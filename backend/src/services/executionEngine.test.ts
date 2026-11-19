import test from "node:test";
import assert from "node:assert/strict";
import { resolveExecutionEngine } from "./executionEngine.js";

test("runs always use the Playwright engine", () => {
  assert.deepEqual(resolveExecutionEngine(undefined, undefined), { engineRequested: "playwright", engineUsed: "playwright", fallbackReason: "" });
  assert.equal(resolveExecutionEngine("mcp", undefined).engineUsed, "playwright");
  assert.equal(resolveExecutionEngine(undefined, "mcp").engineRequested, "mcp");
});

test("a requested MCP run names the cases that need Playwright", () => {
  const resolution = resolveExecutionEngine("mcp", "playwright", [{ id: "a" }, { id: "b", requiresPlaywrightEngine: true }]);
  assert.equal(resolution.engineUsed, "playwright");
  assert.match(resolution.fallbackReason, /^Cases b use computed assertions/);
  assert.doesNotMatch(resolveExecutionEngine("mcp", undefined, [{ id: "a" }]).fallbackReason, /Cases/);
});
