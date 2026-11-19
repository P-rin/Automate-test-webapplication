import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asGenerationMode } from "../../config/env.js";
import { processSnapshotTestPlans, type LlmGenerationOptions } from "../ollamaService.js";
import { selectSnapshotPlanner } from "./pipeline.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const fixture = (name: string): string => readFileSync(path.join(FIXTURES, `${name}.txt`), "utf8");
const payload = { projectName: "Shop", targetUrl: "https://shop.example", specification: "", accessibilitySnapshot: "" };

const done = {
  status: "done", id: "", title: "", description: "", type: "UI", testSteps: [], expectedResult: "",
  requirementIds: [], category: "exploratory", targetElement: "", inputVariant: "",
};

type ChatRequest = { messages: Array<{ role: string; content: string }> };

const recordingClient = (responses: unknown[], requests: ChatRequest[]) => ({
  chat: async (request: ChatRequest) => {
    requests.push({ messages: request.messages.map((message) => ({ ...message })) });
    return { message: { role: "assistant", content: JSON.stringify(responses.shift() ?? done) } };
  },
}) as unknown as NonNullable<LlmGenerationOptions["ollamaClient"]>;

const userPrompt = (request: ChatRequest): string => request.messages.find((message) => message.role === "user")?.content ?? "";

test("GENERATION_MODE defaults to legacy and only accepts known modes", () => {
  assert.equal(asGenerationMode(undefined), "legacy");
  assert.equal(asGenerationMode(""), "legacy");
  assert.equal(asGenerationMode("  "), "legacy");
  assert.equal(asGenerationMode("legacy"), "legacy");
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
});

test("legacy planner still receives the full snapshot", async () => {
  const requests: ChatRequest[] = [];
  const snapshot = fixture("react-cart-web/cart-one-item");
  await selectSnapshotPlanner("legacy").planner(payload, snapshot, { ollamaClient: recordingClient([], requests) }, async () => true);
  assert.match(userPrompt(requests[0]), /\[ref=/);
});

test("ecommerce planner sends the compact inventory instead of the raw snapshot", async () => {
  const selection = selectSnapshotPlanner("ecommerce");
  assert.deepEqual(selection.stages, ["compact_snapshot", "classify_elements"]);
  const requests: ChatRequest[] = [];
  const result = await selection.planner(
    payload,
    fixture("react-cart-web/cart-one-item"),
    { ollamaClient: recordingClient([], requests) },
    async () => true,
  );
  assert.deepEqual(result, { status: "complete", planCount: 0 });
  const prompt = userPrompt(requests[0]);
  assert.match(prompt, /PAGE \/cart/);
  assert.match(prompt, /G1 item "AirPods Pro 2 USB-C"/);
  assert.match(prompt, /ยอดรวม: ฿7,990/);
  assert.match(prompt, /button remove_from_cart "ลบสินค้า"/, "element purposes label the compact text");
  assert.match(prompt, /text subtotal "ยอดรวม: ฿7,990"/);
  assert.doesNotMatch(prompt, /generic_/);
  assert.doesNotMatch(prompt, /\[ref=|```yaml/);
});

test("ecommerce planner hides nav already sent on an earlier page of the same job only", async () => {
  const requests: ChatRequest[] = [];
  const options = { ollamaClient: recordingClient([], requests) };
  const planner = selectSnapshotPlanner("ecommerce").planner;
  await planner(payload, fixture("react-cart-web/catalog"), options, async () => true);
  await planner(payload, fixture("react-cart-web/cart-one-item"), options, async () => true);
  assert.match(userPrompt(requests[0]), /link "หน้าแรก"/);
  assert.doesNotMatch(userPrompt(requests[1]), /link "หน้าแรก"/);

  // A new job starts with a fresh planner.
  const fresh: ChatRequest[] = [];
  await selectSnapshotPlanner("ecommerce").planner(payload, fixture("react-cart-web/cart-one-item"), { ollamaClient: recordingClient([], fresh) }, async () => true);
  assert.match(userPrompt(fresh[0]), /link "หน้าแรก"/);
});

test("ecommerce planner reports labels the plan used that the compact prompt did not show", async () => {
  const misses: Array<{ text: string; inFullSnapshot: boolean }> = [];
  const plan = {
    status: "case", id: "p", title: "ลบสินค้าออกจากตะกร้า", description: "d", type: "UI",
    testSteps: ["คลิก 'ลบสินค้า'", "คลิก 'Apply coupon'"], expectedResult: "ตะกร้าว่าง",
    requirementIds: [], category: "happy_path", targetElement: "ลบสินค้า", inputVariant: "",
  };
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    await selectSnapshotPlanner("ecommerce").planner(
      payload,
      fixture("react-cart-web/cart-one-item"),
      { ollamaClient: recordingClient([plan], []), metricsHooks: { onPromptReferenceMiss: (miss) => misses.push(miss) } },
      async () => true,
    );
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(misses, [{ text: "Apply coupon", inFullSnapshot: false }]);
});

test("ecommerce planner falls back to the full snapshot when nothing can be parsed", async () => {
  const requests: ChatRequest[] = [];
  await selectSnapshotPlanner("ecommerce").planner(payload, "plain page text without a tree", { ollamaClient: recordingClient([], requests) }, async () => true);
  assert.match(userPrompt(requests[0]), /plain page text without a tree/);
});
