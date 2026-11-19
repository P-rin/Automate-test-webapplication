import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asGenerationMode } from "../../config/env.js";
import type { AcceptanceCriterion, TestPlan } from "../../types.js";
import { processSnapshotTestPlans, type LlmGenerationOptions } from "../ollamaService.js";
import { PlanCoverageRegistry } from "../planDedup.js";
import { STATUS_NO_MORE } from "./dynamicSchemas.js";
import { ECOMMERCE_STAGES, selectSnapshotPlanner, type EcommercePlannerConfig } from "./pipeline.js";
import { compileStoredCase, parseStoredStructuredCase } from "./storedCase.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const fixture = (name: string): string => readFileSync(path.join(FIXTURES, `${name}.txt`), "utf8");
const payload = { projectName: "Shop", targetUrl: "https://shop.example", specification: "", accessibilitySnapshot: "" };

type Schema = { properties: Record<string, any> };

/** Fake model: answers each schema kind with a scripted reply and records the prompts. */
const fakeModel = (reply: { keep?: (id: string) => boolean; fail?: boolean } = {}) => {
  const prompts: Array<{ kind: string; prompt: string }> = [];
  const ask: NonNullable<EcommercePlannerConfig["ask"]> = async (prompt, schema) => {
    const properties = (schema as Schema).properties;
    const kind = properties.selections ? "selection" : properties.answers ? "purpose" : "exploratory";
    prompts.push({ kind, prompt });
    if (reply.fail) throw new Error("Ollama timeout");
    if (kind === "selection") {
      const ids: string[] = properties.selections.items.properties.candidateId.enum;
      return JSON.stringify({ selections: ids.map((candidateId) => ({ candidateId, keep: reply.keep?.(candidateId) ?? false, requirementIds: [], titleTh: "" })) });
    }
    if (kind === "purpose") {
      const ids: string[] = properties.answers.items.properties.elementId.enum;
      return JSON.stringify({ answers: ids.map((elementId) => ({ elementId, purpose: "unknown" })) });
    }
    return JSON.stringify({ status: STATUS_NO_MORE });
  };
  return { ask, prompts };
};

const runPlanner = async (
  snapshots: string[],
  config: Partial<EcommercePlannerConfig> & { ask: EcommercePlannerConfig["ask"] },
  options: { criteria?: AcceptanceCriterion[]; allowMutatingTests?: boolean; metrics?: LlmGenerationOptions["metricsHooks"] } = {},
) => {
  const planner = selectSnapshotPlanner("ecommerce", { hasLogin: true, ...config }).planner;
  const persisted: TestPlan[] = [];
  const duplicates: string[] = [];
  const coverage = new PlanCoverageRegistry();
  const results = [];
  for (const snapshot of snapshots) {
    results.push(await planner(
      payload,
      snapshot,
      { metricsHooks: options.metrics } as LlmGenerationOptions,
      async (plan) => {
        persisted.push(plan);
        return true;
      },
      options.criteria ?? [],
      new Set(),
      options.allowMutatingTests ?? false,
      coverage,
      { onDuplicate: (plan) => duplicates.push(plan.title) },
    ));
  }
  return { persisted, duplicates, results };
};

test("GENERATION_MODE defaults to legacy and only accepts known modes", () => {
  assert.equal(asGenerationMode(undefined), "legacy");
  assert.equal(asGenerationMode(""), "legacy");
  assert.equal(asGenerationMode("ecommerce"), "ecommerce");
  assert.equal(asGenerationMode(" ECommerce "), "ecommerce");
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    assert.equal(asGenerationMode("e-commerce"), "legacy");
  } finally {
    console.warn = warn;
  }
});

test("legacy mode uses the original snapshot planner unchanged", () => {
  const selection = selectSnapshotPlanner("legacy");
  assert.equal(selection.mode, "legacy");
  assert.equal(selection.planner, processSnapshotTestPlans);
  assert.deepEqual(selection.stages, []);
  assert.deepEqual(selectSnapshotPlanner("ecommerce").stages, ECOMMERCE_STAGES);
});

test("ecommerce planner stores code-built candidates with structured steps; mandatory ones survive a model that keeps nothing", async () => {
  const model = fakeModel({ keep: () => false });
  const { persisted, results } = await runPlanner([fixture("saucedemo/inventory")], { ask: model.ask });
  assert.deepEqual(results, [{ status: "complete", planCount: persisted.length }]);
  const templates = persisted.map((plan) => String(plan.structured?.origin));
  assert.ok(templates.includes("template:listing.add_to_cart"));
  assert.equal(templates.filter((origin) => origin === "template:listing.sort").length, 4);
  assert.ok(!templates.includes("template:listing.add_twice"), "non-mandatory candidates follow the model");
  for (const plan of persisted) {
    const structured = parseStoredStructuredCase(plan.structured);
    assert.ok(structured, plan.title);
    assert.equal(plan.structured?.pageType, "listing");
    assert.ok(plan.testSteps.length > 0);
    assert.match(plan.testSteps[0], /^เปิดหน้า \/inventory\.html/);
  }
  // The model saw the candidates and the compact page, never the raw snapshot.
  const selectionPrompt = model.prompts.find((entry) => entry.kind === "selection")!.prompt;
  assert.match(selectionPrompt, /C1 \[happy_path, mandatory\]/);
  assert.doesNotMatch(selectionPrompt, /\[ref=/);
});

test("candidates the model keeps are stored with its AC mapping; others are dropped", async () => {
  const criteria: AcceptanceCriterion[] = [{
    id: "AC-001", requirementRef: "R1", scenario: "เรียงสินค้า", action: "เลือกเรียงราคา", expected: "สินค้าเรียงตามราคา", mustNot: "",
    category: "happy_path", priority: "required", verification: "automated", ambiguity: "",
  }];
  const model = fakeModel({ keep: () => true });
  const ask: EcommercePlannerConfig["ask"] = async (prompt, schema) => {
    const properties = (schema as Schema).properties;
    if (!properties.selections) return model.ask(prompt, schema);
    const ids: string[] = properties.selections.items.properties.candidateId.enum;
    return JSON.stringify({ selections: ids.map((candidateId) => ({ candidateId, keep: true, requirementIds: ["AC-001"], titleTh: `ชื่อใหม่ ${candidateId}` })) });
  };
  const { persisted } = await runPlanner([fixture("saucedemo/inventory")], { ask }, { criteria });
  assert.ok(persisted.some((plan) => String(plan.structured?.origin) === "template:listing.add_twice"));
  assert.ok(persisted.every((plan) => plan.requirementIds?.includes("AC-001")));
  assert.ok(persisted.every((plan) => plan.title.startsWith("ชื่อใหม่ C")));
});

test("a failing model never fails planning: mandatory + one happy path per template are kept", async () => {
  const model = fakeModel({ fail: true });
  const stages: unknown[] = [];
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    const { persisted, results } = await runPlanner([fixture("react-cart-web/product-detail-in-stock")], { ask: model.ask }, {
      metrics: { onCandidateStage: (stage) => stages.push(stage) },
    });
    assert.equal(results[0].status, "complete");
    const origins = persisted.map((plan) => String(plan.structured?.origin));
    assert.ok(origins.includes("template:num.zero"));
    assert.ok(origins.includes("template:num.over_max"));
    assert.ok(origins.includes("template:num.valid"), "first happy path of the template");
    assert.ok(!origins.includes("template:num.max"), "other optional cases are dropped");
    assert.equal((stages[0] as { byFallback: number }).byFallback > 0, true);
  } finally {
    console.warn = warn;
  }
});

test("cases already planned on an earlier page of the job are de-duplicated", async () => {
  const model = fakeModel({ keep: () => true });
  const { persisted, duplicates } = await runPlanner([fixture("saucedemo/inventory"), fixture("saucedemo/inventory")], { ask: model.ask });
  assert.ok(persisted.length > 0);
  assert.equal(duplicates.length, persisted.length, "every case of the repeated page is a duplicate");
});

test("states that need a precondition produce no candidates until Phase 7", async () => {
  const model = fakeModel();
  const info = console.info;
  console.info = () => undefined;
  try {
    const { persisted } = await runPlanner([fixture("react-cart-web/cart-two-items")], { ask: model.ask });
    assert.equal(persisted.length, 0);
    assert.ok(!model.prompts.some((entry) => entry.kind === "selection"));
    assert.ok(model.prompts.some((entry) => entry.kind === "exploratory"), "exploratory cases are still proposed");
  } finally {
    console.info = info;
  }
});

test("nav already shown on an earlier page is hidden from the next page's prompts", async () => {
  const model = fakeModel();
  await runPlanner([fixture("react-cart-web/catalog"), fixture("react-cart-web/product-detail-in-stock")], { ask: model.ask });
  const exploratory = model.prompts.filter((entry) => entry.kind === "exploratory");
  assert.match(exploratory[0].prompt, /link "หน้าแรก"/);
  assert.doesNotMatch(exploratory[exploratory.length - 1].prompt, /link "หน้าแรก"/);
});

test("stored cases compile into scripts (basic oracles; computed ones arrive in Phase 5)", async () => {
  const snapshot = fixture("react-cart-web/product-detail-out-of-stock");
  const { persisted } = await runPlanner([snapshot], { ask: fakeModel().ask });
  const outOfStock = persisted.find((plan) => String(plan.structured?.origin) === "template:product.out_of_stock")!;
  const compiled = compileStoredCase(outOfStock.title, parseStoredStructuredCase(outOfStock.structured)!, snapshot);
  assert.match(compiled.script, /toBeDisabled\(\);/);
});

test("guest snapshots are tested as guests even when the runner logs in", async () => {
  const { persisted } = await runPlanner([fixture("react-cart-web/guest-catalog")], { ask: fakeModel({ keep: () => true }).ask });
  assert.ok(persisted.length > 0);
  assert.ok(persisted.every((plan) => plan.structured?.loggedOut === true));
  assert.ok(persisted.every((plan) => plan.testSteps[0] === "เริ่มโดยยังไม่ได้เข้าสู่ระบบ"));
});

test("snapshots the compactor cannot parse fall back to the legacy planner", async () => {
  const requests: string[] = [];
  const ollamaClient = {
    chat: async (request: { messages: Array<{ role: string; content: string }> }) => {
      requests.push(request.messages.find((message) => message.role === "user")?.content ?? "");
      return { message: { role: "assistant", content: JSON.stringify({ status: "done", id: "", title: "", description: "", type: "UI", testSteps: [], expectedResult: "", requirementIds: [], category: "exploratory", targetElement: "", inputVariant: "" }) } };
    },
  } as never;
  await selectSnapshotPlanner("ecommerce").planner(payload, "plain page text without a tree", { ollamaClient }, async () => true);
  assert.match(requests[0], /plain page text without a tree/);
});
