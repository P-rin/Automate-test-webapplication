import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export interface OllamaDebugContext {
  jobId: string;
  stage: "planner" | "script";
  planId?: string;
}

export type OllamaDebugRecord = Record<string, unknown>;
export type OllamaDebugWriter = (
  context: OllamaDebugContext,
  record: OllamaDebugRecord,
) => Promise<void>;

const MAX_RESPONSE_BODY_CHARS = 100_000;

const redact = (value: string): string => value
  .replace(/\b(Bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
  .replace(/\b((?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi, "$1[REDACTED]")
  .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, "$1[REDACTED]@");

const serializeCause = (value: unknown, depth: number, seen: Set<object>): unknown => {
  if (value == null) return value;
  if (depth > 5) return "[cause depth limit]";

  if (typeof value === "object") {
    if (seen.has(value)) return "[circular cause]";
    seen.add(value);
  }

  if (value instanceof Error) {
    const extended = value as Error & {
      cause?: unknown;
      code?: unknown;
      status_code?: unknown;
      error?: unknown;
    };

    return {
      name: value.name,
      message: redact(value.message),
      ...(value.stack ? { stack: redact(value.stack) } : {}),
      ...(extended.code !== undefined ? { code: extended.code } : {}),
      ...(extended.status_code !== undefined ? { statusCode: extended.status_code } : {}),
      ...(extended.error !== undefined ? { responseError: serializeCause(extended.error, depth + 1, seen) } : {}),
      ...(extended.cause !== undefined ? { cause: serializeCause(extended.cause, depth + 1, seen) } : {}),
    };
  }

  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const details: Record<string, unknown> = {};
    for (const key of ["name", "message", "code", "errno", "syscall", "hostname", "address", "port", "cause"]) {
      if (object[key] !== undefined) {
        details[key] = key === "cause"
          ? serializeCause(object[key], depth + 1, seen)
          : typeof object[key] === "string" ? redact(object[key] as string) : object[key];
      }
    }
    return Object.keys(details).length > 0 ? details : redact(String(value));
  }

  return typeof value === "string" ? redact(value) : value;
};

export const serializeOllamaDebugError = (error: unknown): unknown => serializeCause(error, 0, new Set());

export const writeOllamaDebugRecord: OllamaDebugWriter = async (context, record) => {
  const debugDir = path.resolve(process.cwd(), "Debug");
  const safeJobId = context.jobId.replace(/[^a-zA-Z0-9_-]/g, "_") || "unknown";
  const logPath = path.join(debugDir, `ollama-${safeJobId}.jsonl`);
  const entry = {
    timestamp: new Date().toISOString(),
    ...context,
    ...record,
  };

  try {
    await mkdir(debugDir, { recursive: true });
    await appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[ollama-debug] Could not write debug record: ${redact(message)}`);
  }
};

const getRequestSummary = (input: RequestInfo | URL, init?: RequestInit): Record<string, unknown> => {
  const request = input instanceof Request ? input : undefined;
  const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  let requestUrl = "unavailable";

  try {
    const url = new URL(rawUrl);
    requestUrl = `${url.origin}${url.pathname}`;
  } catch {
    // Keep the request body and raw URL out of diagnostics.
  }

  const body = typeof init?.body === "string" ? init.body : "";
  let requestBody: Record<string, unknown> = {};
  try {
    requestBody = JSON.parse(body) as Record<string, unknown>;
  } catch {
    // Request size and URL are sufficient when the body is not JSON text.
  }

  const messages = Array.isArray(requestBody.messages) ? requestBody.messages : [];
  const userPromptChars = messages.reduce((total, message) => {
    if (typeof message !== "object" || message == null) return total;
    const item = message as { role?: unknown; content?: unknown };
    return item.role === "user" && typeof item.content === "string" ? total + item.content.length : total;
  }, 0);

  return {
    requestUrl,
    method: init?.method ?? request?.method ?? "GET",
    requestBodyChars: body.length,
    model: typeof requestBody.model === "string" ? requestBody.model : undefined,
    messageCount: messages.length,
    userPromptChars,
    toolCount: Array.isArray(requestBody.tools) ? requestBody.tools.length : 0,
  };
};

export const createOllamaDebugFetch = (
  context: OllamaDebugContext,
  fetchImplementation: typeof fetch = fetch,
  writer: OllamaDebugWriter = writeOllamaDebugRecord,
): typeof fetch => {
  let requestNumber = 0;

  const writeSafely = async (record: OllamaDebugRecord): Promise<void> => {
    try {
      await writer(context, record);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[ollama-debug] Could not write debug record: ${redact(message)}`);
    }
  };

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requestNumber += 1;
    const requestId = randomUUID();
    const requestSummary = getRequestSummary(input, init);
    const startedAt = Date.now();

    await writeSafely({
      event: "request",
      requestId,
      requestNumber,
      ...requestSummary,
    });

    try {
      const response = await fetchImplementation(input, init);
      let responseBody = "";
      let bodyCaptureError: unknown;

      try {
        responseBody = await response.clone().text();
      } catch (error) {
        bodyCaptureError = serializeOllamaDebugError(error);
      }

      await writeSafely({
        event: "response",
        requestId,
        requestNumber,
        httpStatus: response.status,
        ok: response.ok,
        contentType: response.headers.get("content-type"),
        durationMs: Date.now() - startedAt,
        responseBody: responseBody.slice(0, MAX_RESPONSE_BODY_CHARS),
        responseBodyChars: responseBody.length,
        responseBodyTruncated: responseBody.length > MAX_RESPONSE_BODY_CHARS,
        ...(bodyCaptureError ? { bodyCaptureError } : {}),
      });

      return response;
    } catch (error) {
      await writeSafely({
        event: "transport-error",
        requestId,
        requestNumber,
        durationMs: Date.now() - startedAt,
        error: serializeOllamaDebugError(error),
      });
      throw error;
    }
  };
};