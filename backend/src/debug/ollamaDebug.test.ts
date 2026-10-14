import test from "node:test";
import assert from "node:assert/strict";

import { createOllamaDebugFetch, type OllamaDebugRecord } from "./ollamaDebug.js";

const context = { jobId: "job-123", stage: "planner" as const };

test("Ollama debug fetch records response body without logging the prompt", async () => {
  const records: OllamaDebugRecord[] = [];
  const debugFetch = createOllamaDebugFetch(
    context,
    async () => new Response('{"error":"runner failed"}', {
      status: 500,
      headers: { "content-type": "application/json" },
    }),
    async (_context, record) => {
      records.push(record);
    },
  );
  const privatePrompt = "private prompt text";
  const response = await debugFetch("http://localhost:11434/api/chat", {
    method: "POST",
    body: JSON.stringify({
      model: "qwen2.5-coder:7b",
      messages: [{ role: "user", content: privatePrompt }],
      tools: [{ type: "function" }],
    }),
  });

  assert.equal(response.status, 500);
  assert.equal(records.length, 2);
  assert.equal(records[0].event, "request");
  assert.equal(records[0].model, "qwen2.5-coder:7b");
  assert.equal(records[0].userPromptChars, privatePrompt.length);
  assert.equal(JSON.stringify(records[0]).includes(privatePrompt), false);
  assert.equal(records[1].event, "response");
  assert.equal(records[1].httpStatus, 500);
  assert.equal(records[1].responseBody, '{"error":"runner failed"}');
});

test("Ollama debug fetch records nested transport error causes and rethrows", async () => {
  const records: OllamaDebugRecord[] = [];
  const timeoutCause = Object.assign(new Error("response headers timed out"), {
    code: "UND_ERR_HEADERS_TIMEOUT",
  });
  const fetchError = Object.assign(new TypeError("fetch failed"), { cause: timeoutCause });
  const debugFetch = createOllamaDebugFetch(
    context,
    async () => {
      throw fetchError;
    },
    async (_context, record) => {
      records.push(record);
    },
  );

  await assert.rejects(
    () => debugFetch("http://localhost:11434/api/chat", { method: "POST", body: "{}" }),
    /fetch failed/,
  );

  assert.equal(records.length, 2);
  assert.equal(records[1].event, "transport-error");
  const error = records[1].error as { message: string; cause: { code: string } };
  assert.equal(error.message, "fetch failed");
  assert.equal(error.cause.code, "UND_ERR_HEADERS_TIMEOUT");
});