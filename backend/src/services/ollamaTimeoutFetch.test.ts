import test from "node:test";
import assert from "node:assert/strict";

import { createIdleTimeoutFetch, OllamaTimeoutError } from "./ollamaTimeoutFetch.js";
import { collectChatResponse, processSnapshotTestPlans } from "./ollamaService.js";
import { createOllamaDebugFetch, type OllamaDebugRecord } from "../debug/ollamaDebug.js";

const encoder = new TextEncoder();
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A fake fetch that streams NDJSON lines with a pause before each one and honours the abort signal. */
const streamingFetch = (lines: string[], gapMs: number, headerDelayMs = 0): typeof fetch =>
  async (_input, init) => {
    const signal = init?.signal ?? undefined;
    const abortable = (ms: number) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(signal.reason);
      }, { once: true });
    });
    await abortable(headerDelayMs);
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (index >= lines.length) {
          controller.close();
          return;
        }
        await abortable(gapMs);
        controller.enqueue(encoder.encode(`${lines[index]}\n`));
        index += 1;
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } });
  };

const readAll = async (response: Response): Promise<string> => response.text();

test("idle timeout fetch allows a long stream as long as chunks keep arriving", async () => {
  const lines = Array.from({ length: 10 }, (_, i) => JSON.stringify({ i }));
  const timeoutFetch = createIdleTimeoutFetch(
    { firstChunkTimeoutMs: 300, idleTimeoutMs: 200 },
    streamingFetch(lines, 50),
  );
  const startedAt = Date.now();
  const body = await readAll(await timeoutFetch("http://ollama/api/chat"));
  // Total time (~500ms) exceeds both timeouts, but no single gap does.
  assert.ok(Date.now() - startedAt >= 450);
  assert.equal(body.trim().split("\n").length, 10);
});

test("idle timeout fetch aborts with OllamaTimeoutError when the stream goes silent", async () => {
  const timeoutFetch = createIdleTimeoutFetch(
    { firstChunkTimeoutMs: 1000, idleTimeoutMs: 40 },
    async (_input, init) => {
      const signal = init?.signal ?? undefined;
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(encoder.encode('{"i":0}\n'));
            return;
          }
          return new Promise<void>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
      });
      return new Response(body, { status: 200 });
    },
  );
  const response = await timeoutFetch("http://ollama/api/chat");
  await assert.rejects(readAll(response), (error: unknown) =>
    error instanceof OllamaTimeoutError && error.phase === "idle");
});

test("idle timeout fetch aborts when the first response byte never arrives", async () => {
  const timeoutFetch = createIdleTimeoutFetch(
    { firstChunkTimeoutMs: 40, idleTimeoutMs: 1000 },
    streamingFetch(["{}"], 0, 10_000),
  );
  await assert.rejects(timeoutFetch("http://ollama/api/chat"), (error: unknown) =>
    error instanceof OllamaTimeoutError && error.phase === "first-chunk");
});

test("collectChatResponse merges streamed content, thinking and tool calls", async () => {
  async function* chunks() {
    yield { model: "m", message: { role: "assistant", content: '{"status":', thinking: "plan " } };
    yield { model: "m", message: { role: "assistant", content: '"done"}', thinking: "more" } };
    yield {
      model: "m",
      message: { role: "assistant", content: "", tool_calls: [{ function: { name: "browser_navigate", arguments: {} } }] },
    };
    yield { model: "m", done: true, eval_count: 7, message: { role: "assistant", content: "" } };
  }
  const response = await collectChatResponse(chunks());
  assert.equal(response.message.content, '{"status":"done"}');
  assert.equal(response.message.thinking, "plan more");
  assert.equal(response.message.tool_calls?.length, 1);
  assert.equal(response.eval_count, 7);
});

test("collectChatResponse passes non-streamed responses through unchanged", async () => {
  const response = { message: { role: "assistant", content: "hi" } };
  assert.equal(await collectChatResponse(response), response);
});

test("debug fetch does not block a streamed response and logs a merged summary", async () => {
  const records: OllamaDebugRecord[] = [];
  const lines = [
    JSON.stringify({ message: { role: "assistant", content: "Hel" } }),
    JSON.stringify({ message: { role: "assistant", content: "lo" } }),
    JSON.stringify({ done: true, eval_count: 2, message: { role: "assistant", content: "" } }),
  ];
  const debugFetch = createOllamaDebugFetch(
    { jobId: "job-1", stage: "planner" },
    streamingFetch(lines, 30),
    async (_context, record) => { records.push(record); },
  );

  const startedAt = Date.now();
  const response = await debugFetch("http://ollama/api/chat", { method: "POST", body: "{}" });
  assert.ok(Date.now() - startedAt < 60, "headers should be returned before the stream finishes");

  await response.text();
  await delay(20);
  const logged = records.find((record) => record.event === "response");
  assert.ok(logged);
  assert.equal(logged.streamed, true);
  const summary = JSON.parse(String(logged.responseBody)) as { message: { content: string } };
  assert.equal(summary.message.content, "Hello");
  assert.deepEqual(logged.modelMetrics, { eval_count: 2 });
});

test("processSnapshotTestPlans reports incomplete instead of throwing when the model call fails", async () => {
  const ollamaClient = {
    chat: async () => {
      throw new TypeError("fetch failed");
    },
  } as never;
  const result = await processSnapshotTestPlans(
    {
      projectName: "Demo",
      targetUrl: "https://example.com",
      specification: "Page loads",
      accessibilitySnapshot: "heading Example",
    },
    "heading Example",
    { ollamaClient },
    async () => true,
  );
  assert.equal(result.status, "incomplete");
  assert.match(result.status === "incomplete" ? result.stopReason : "", /Planner request failed: fetch failed/);
});
