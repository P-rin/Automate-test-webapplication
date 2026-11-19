import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveGenerationRates,
  GenerationMetricsCollector,
  metricIncrements,
  metricKey,
  promptCharsOf,
  summarizeLatestCaseResults,
} from "./generationMetrics.js";

test("collector counts planned and rejected cases per category, page and page type", () => {
  const metrics = new GenerationMetricsCollector("legacy");
  metrics.recordPlanned({ category: "boundary", page: "Cart" });
  metrics.recordPlanned({ category: "boundary", page: "Cart", pageType: "cart" });
  metrics.recordPlanned({ page: "Products" });
  metrics.recordRejected("duplicate_registry");
  metrics.recordRejected("duplicate_title");
  metrics.recordRejected("duplicate_registry");
  metrics.recordStalledSnapshot();

  const { mode, planning } = metrics.toJSON();
  assert.equal(mode, "legacy");
  assert.equal(planning.plannedCount, 3);
  assert.equal(planning.rejectedCount, 3);
  assert.deepEqual(planning.rejectedByReason, { duplicate_registry: 2, duplicate_title: 1 });
  assert.equal(planning.stalledSnapshotCount, 1);
  assert.deepEqual(planning.byCategory, { boundary: 2, uncategorized: 1 });
  assert.deepEqual(planning.byPage, { Cart: 2, Products: 1 });
  assert.deepEqual(planning.byPageType, { unclassified: 2, cart: 1 });
});

test("collector aggregates LLM prompt lengths per stage and keeps each call", () => {
  const metrics = new GenerationMetricsCollector("ecommerce");
  metrics.hooks.onLlmCall({ stage: "planner", model: "qwen3.5:4b", promptChars: 9000 });
  metrics.hooks.onLlmCall({ stage: "planner", model: "qwen3.5:4b", promptChars: 3000 });
  metrics.hooks.onLlmCall({ stage: "script", model: "qwen2.5-coder:7b", promptChars: 5000 });

  const { llmCalls } = metrics.toJSON();
  assert.deepEqual(llmCalls.planner, { count: 2, totalPromptChars: 12000, maxPromptChars: 9000 });
  assert.deepEqual(llmCalls.script, { count: 1, totalPromptChars: 5000, maxPromptChars: 5000 });
  assert.deepEqual(metrics.calls.map((call) => call.promptChars), [9000, 3000, 5000]);
});

test("derived rates use attempts and cases and stay null without data", () => {
  const metrics = new GenerationMetricsCollector("legacy");
  assert.deepEqual(deriveGenerationRates(metrics.toJSON()), {
    duplicateRate: null,
    scriptAttemptPassRate: null,
    scriptCaseSaveRate: null,
    averagePromptChars: { planner: null, script: null },
  });

  metrics.recordPlanned({ page: "Cart" });
  metrics.recordPlanned({ page: "Cart" });
  metrics.recordPlanned({ page: "Cart" });
  metrics.recordRejected("duplicate_registry");
  metrics.hooks.onScriptAttempt({ attempt: 1, passed: false, reason: "Generated script has a syntax error" });
  metrics.hooks.onScriptAttempt({ attempt: 2, passed: true });
  metrics.hooks.onScriptAttempt({ attempt: 1, passed: true });
  metrics.recordScriptCase(true);
  metrics.recordScriptCase(true);
  metrics.recordScriptCase(false);
  metrics.hooks.onLlmCall({ stage: "planner", model: "m", promptChars: 1001 });
  metrics.hooks.onLlmCall({ stage: "planner", model: "m", promptChars: 2000 });

  const rates = deriveGenerationRates(metrics.toJSON());
  assert.equal(rates.duplicateRate, 0.25);
  assert.equal(rates.scriptAttemptPassRate, 0.667);
  assert.equal(rates.scriptCaseSaveRate, 0.667);
  assert.deepEqual(rates.averagePromptChars, { planner: 1501, script: null });
});

test("toJSON returns a copy that later events do not mutate", () => {
  const metrics = new GenerationMetricsCollector("legacy");
  metrics.recordPlanned({ page: "Cart" });
  const before = metrics.toJSON();
  metrics.recordPlanned({ page: "Cart" });
  assert.equal(before.planning.plannedCount, 1);
  assert.equal(before.planning.byPage.Cart, 1);
});

test("metricIncrements flattens non-zero counters into Firestore-safe dotted paths and skips max values", () => {
  const metrics = new GenerationMetricsCollector("legacy");
  metrics.recordPlanned({ category: "happy_path", page: "Swag Labs | /inventory.html" });
  metrics.recordPlanned({ category: "happy_path", page: "ตะกร้าสินค้า" });
  metrics.hooks.onLlmCall({ stage: "planner", model: "m", promptChars: 4200 });

  assert.deepEqual(metricIncrements(metrics.toJSON()), {
    "generationMetrics.planning.plannedCount": 2,
    "generationMetrics.planning.byCategory.happy_path": 2,
    "generationMetrics.planning.byPage.Swag_Labs_inventory_html": 1,
    "generationMetrics.planning.byPage.ตะกร้าสินค้า": 1,
    "generationMetrics.planning.byPageType.unclassified": 2,
    "generationMetrics.llmCalls.planner.count": 1,
    "generationMetrics.llmCalls.planner.totalPromptChars": 4200,
  });
  assert.deepEqual(metricIncrements(new GenerationMetricsCollector("legacy").toJSON()), {});
});

test("metricKey removes path separators and never returns an empty key", () => {
  assert.equal(metricKey("a.b/c[d]"), "a_b_c_d");
  assert.equal(metricKey("..."), "unknown");
  assert.equal(metricKey("ชำระเงิน"), "ชำระเงิน");
});

test("promptCharsOf sums message contents", () => {
  assert.equal(promptCharsOf([{ content: "abc" }, { content: "de" }, {}]), 5);
});

test("summarizeLatestCaseResults keeps only each test case's most recent result", () => {
  const summary = summarizeLatestCaseResults(["tc1", "tc2", "tc3"], [
    { completedAtMs: 200, caseResults: [{ testCaseId: "tc1", passed: true }] },
    { completedAtMs: 100, caseResults: [{ testCaseId: "tc1", passed: false }, { testCaseId: "tc2", passed: false }] },
    { completedAtMs: 300, caseResults: [{ testCaseId: "other-job-case", passed: true }] },
  ]);
  assert.deepEqual(summary, { testCaseCount: 3, executedCount: 2, passedCount: 1, passRate: 0.5 });
  assert.equal(summarizeLatestCaseResults(["tc1"], []).passRate, null);
});
