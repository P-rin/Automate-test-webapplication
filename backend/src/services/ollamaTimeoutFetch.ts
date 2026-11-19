export interface OllamaStreamTimeouts {
  /** Max wait for the first byte of the response (model load + prompt evaluation). 0 disables. */
  firstChunkTimeoutMs: number;
  /** Max silence between streamed chunks once generation has started. 0 disables. */
  idleTimeoutMs: number;
}

export class OllamaTimeoutError extends Error {
  readonly code = "OLLAMA_STREAM_TIMEOUT";

  constructor(
    readonly phase: "first-chunk" | "idle",
    readonly timeoutMs: number,
  ) {
    super(phase === "first-chunk"
      ? `Ollama did not start responding within ${Math.round(timeoutMs / 1000)}s`
      : `Ollama stopped streaming for ${Math.round(timeoutMs / 1000)}s and appears to be stuck`);
    this.name = "OllamaTimeoutError";
  }
}

/**
 * Wraps fetch with an inactivity timeout instead of a total-duration timeout:
 * a long generation is allowed as long as chunks keep arriving. Requires the
 * Ollama request to use `stream: true`, otherwise the body arrives in one piece
 * only after generation finishes.
 */
export const createIdleTimeoutFetch = (
  timeouts: OllamaStreamTimeouts,
  fetchImplementation: typeof fetch = fetch,
): typeof fetch => async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const controller = new AbortController();
  const upstreamSignal = init?.signal ?? undefined;
  const onUpstreamAbort = () => controller.abort(upstreamSignal?.reason);
  if (upstreamSignal?.aborted) onUpstreamAbort();
  else upstreamSignal?.addEventListener("abort", onUpstreamAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (phase: OllamaTimeoutError["phase"]) => {
    clearTimeout(timer);
    const timeoutMs = phase === "first-chunk" ? timeouts.firstChunkTimeoutMs : timeouts.idleTimeoutMs;
    if (!(timeoutMs > 0)) return;
    timer = setTimeout(() => controller.abort(new OllamaTimeoutError(phase, timeoutMs)), timeoutMs);
  };
  const cleanup = () => {
    clearTimeout(timer);
    upstreamSignal?.removeEventListener("abort", onUpstreamAbort);
  };
  const toTimeoutError = (error: unknown): unknown =>
    controller.signal.reason instanceof OllamaTimeoutError ? controller.signal.reason : error;

  arm("first-chunk");
  let response: Response;
  try {
    response = await fetchImplementation(input, { ...init, signal: controller.signal });
  } catch (error) {
    cleanup();
    throw toTimeoutError(error);
  }

  if (!response.body) {
    cleanup();
    return response;
  }

  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(streamController) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          cleanup();
          streamController.close();
          return;
        }
        arm("idle");
        streamController.enqueue(value);
      } catch (error) {
        cleanup();
        streamController.error(toTimeoutError(error));
      }
    },
    async cancel(reason) {
      cleanup();
      controller.abort(reason);
      await reader.cancel(reason).catch(() => undefined);
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};
