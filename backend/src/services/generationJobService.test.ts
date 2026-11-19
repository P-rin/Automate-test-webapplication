import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRetryTestPlan,
  buildPlannedGenerationCase,
  decodeGenerationSnapshot,
  encodeGenerationSnapshot,
  findBestSnapshotForCriterion,
  findSnapshotForPage,
  generateCaseScript,
  runCoverageGapPass,
} from "./generationJobService.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildInventory } from "./ecommerce/snapshotCompactor.js";
import type { AcceptanceCriterion, TestPlan } from "../types.js";

const makeGapCriterion = (id: string, text: string): AcceptanceCriterion => ({
  id,
  requirementRef: "R1",
  scenario: text,
  action: "กดปุ่มเข้าสู่ระบบ",
  expected: "หน้าแดชบอร์ดแสดงข้อมูลบัญชี",
  mustNot: "",
  category: "happy_path",
  priority: "required",
  verification: "automated",
  ambiguity: "",
});

const makeGapPlan = (requirementId: string): TestPlan => ({
  id: "planner-id",
  title: "ตรวจสอบหน้าแดชบอร์ด",
  description: "ยืนยันว่าแดชบอร์ดแสดงข้อมูลบัญชี",
  type: "UI",
  testSteps: ["เข้าสู่ระบบ"],
  expectedResult: "หน้าแดชบอร์ดแสดงข้อมูลบัญชี",
  requirementIds: [requirementId],
  category: "happy_path",
});

test("generation snapshots round-trip through compressed storage", () => {
  const snapshot = "### Snapshot\n```yaml\n- heading: Account settings\n- button: Save\n```";
  const compressedSnapshot = encodeGenerationSnapshot(snapshot);

  assert.notEqual(compressedSnapshot, snapshot);
  assert.equal(decodeGenerationSnapshot({ encoding: "gzip-base64", compressedSnapshot }), snapshot);
});

test("decodeGenerationSnapshot supports uncompressed legacy snapshot records", () => {
  assert.equal(decodeGenerationSnapshot({ snapshot: "legacy snapshot" }), "legacy snapshot");
});

test("findSnapshotForPage matches the stored page title without case sensitivity", () => {
  const snapshots = [
    { title: "Landing page", snapshot: "landing snapshot" },
    { title: "Route: https://example.com/account", snapshot: "account snapshot" },
  ];

  assert.deepEqual(findSnapshotForPage(snapshots, " route: HTTPS://EXAMPLE.COM/account "), snapshots[1]);
  assert.equal(findSnapshotForPage(snapshots, "Route: /missing"), undefined);
});

test("findBestSnapshotForCriterion selects the snapshot with the highest keyword overlap", () => {
  const criterion = makeGapCriterion("AC-001", "แดชบอร์ดบัญชี");
  const snapshots = [
    { title: "Login", snapshot: "ปุ่มเข้าสู่ระบบและรหัสผ่าน" },
    { title: "Account dashboard", snapshot: "แดชบอร์ดแสดงข้อมูลบัญชีและปุ่มเข้าสู่ระบบ" },
  ];

  const bestMatch = findBestSnapshotForCriterion(criterion, snapshots);
  assert.equal(bestMatch.snapshot, snapshots[1]);
  assert.ok(bestMatch.overlap > 0);
});

test("runCoverageGapPass creates one targeted case and records no-match and planner-failure reasons", async () => {
  const criteria = [
    makeGapCriterion("AC-001", "แดชบอร์ดบัญชี"),
    {
      ...makeGapCriterion("AC-002", "annual tax invoice export"),
      action: "download annual tax invoice",
      expected: "tax PDF saved locally",
    },
    makeGapCriterion("AC-003", "แดชบอร์ดการเรียกเก็บเงิน"),
  ];
  const snapshots = [
    { title: "Account dashboard", snapshot: "แดชบอร์ดแสดงข้อมูลบัญชี" },
    { title: "Billing dashboard", snapshot: "แดชบอร์ดการเรียกเก็บเงินและยอดคงเหลือ" },
  ];
  const coveredAcIds = new Set<string>();
  const plannedFor: string[] = [];
  const persisted: string[] = [];

  const gaps = await runCoverageGapPass(
    criteria,
    snapshots,
    coveredAcIds,
    2,
    async (criterion, snapshot) => {
      plannedFor.push(`${criterion.id}:${snapshot.title}`);
      return criterion.id === "AC-001" ? makeGapPlan(criterion.id) : undefined;
    },
    async (plan, snapshot) => {
      persisted.push(`${plan.requirementIds?.[0]}:${snapshot.title}`);
      return true;
    },
  );

  assert.deepEqual(plannedFor, ["AC-001:Account dashboard", "AC-003:Billing dashboard"]);
  assert.deepEqual(persisted, ["AC-001:Account dashboard"]);
  assert.deepEqual([...coveredAcIds], ["AC-001"]);
  assert.deepEqual(gaps, [
    { acId: "AC-002", reason: "no matching page discovered" },
    { acId: "AC-003", reason: "planner could not create a case" },
  ]);
});

test("buildRetryTestPlan restores the persisted plan and original sequence id", () => {
  const plan = buildRetryTestPlan({
    sequence: 4,
    title: "Update account details",
    description: "Confirm profile edits are saved",
    type: "API",
    testSteps: ["Open profile", "Update the name"],
    expectedResult: "The updated name is displayed",
    requirementIds: ["AC-003", "AC-004", 42],
    category: "validation",
  });

  assert.deepEqual(plan, {
    id: "TC-004",
    title: "Update account details",
    description: "Confirm profile edits are saved",
    type: "API",
    testSteps: ["Open profile", "Update the name"],
    expectedResult: "The updated name is displayed",
    requirementIds: ["AC-003", "AC-004"],
    category: "validation",
  });
});

test("buildRetryTestPlan supports legacy cases without traceability fields", () => {
  const plan = buildRetryTestPlan({
    sequence: 2,
    title: "Open account page",
    description: "Verify the account page loads",
    type: "UI",
    testSteps: ["Open account page"],
    expectedResult: "Account page is visible",
  });

  assert.deepEqual(plan, {
    id: "TC-002",
    title: "Open account page",
    description: "Verify the account page loads",
    type: "UI",
    testSteps: ["Open account page"],
    expectedResult: "Account page is visible",
    requirementIds: [],
  });
});

test("buildRetryTestPlan rejects incomplete persisted plans", () => {
  assert.throws(() => buildRetryTestPlan({ sequence: 1, title: "Incomplete" }), /stored Test plan is incomplete/);
});

test("buildPlannedGenerationCase persists the full plan and snapshot reference without a script", () => {
  const generationCase = buildPlannedGenerationCase({
    id: "planner-id",
    title: "Account form rejects an invalid email",
    description: "Verify email validation on the account form",
    type: "UI",
    testSteps: ["Open account form", "Enter an invalid email", "Submit"],
    expectedResult: "An email validation message is shown",
    requirementIds: ["AC-001", "AC-002"],
    category: "validation",
  }, 2, "Route: https://example.com/account", "snapshot-00003");

  assert.deepEqual(generationCase, {
    id: "case-00002",
    sequence: 2,
    title: "Account form rejects an invalid email",
    description: "Verify email validation on the account form",
    type: "UI",
    testSteps: ["Open account form", "Enter an invalid email", "Submit"],
    expectedResult: "An email validation message is shown",
    requirementIds: ["AC-001", "AC-002"],
    category: "validation",
    page: "Route: https://example.com/account",
    snapshotId: "snapshot-00003",
    status: "planned",
  });
});

test("buildPlannedGenerationCase includes the selected page ID when supplied", () => {
  const generationCase = buildPlannedGenerationCase({
    id: "planner-id",
    title: "Verify home page",
    description: "Check the selected page",
    type: "UI",
    testSteps: ["Open home page"],
    expectedResult: "Home page is visible",
    requirementIds: ["AC-001"],
  }, 1, "Landing page", "snapshot-00001", "page-home");

  assert.equal(generationCase.pageId, "page-home");
});
test("generateCaseScript compiles structured cases without the script model and keeps legacy cases on it", async () => {
  const snapshot = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "ecommerce/__fixtures__/react-cart-web/guest-catalog.txt"),
    "utf8",
  );
  const inventory = buildInventory(snapshot);
  const search = inventory.elements.find((element) => element.role === "textbox")!;
  const plan: TestPlan = {
    id: "case-00001", title: "ค้นหาสินค้าที่ไม่มีอยู่", description: "", type: "UI", testSteps: [], expectedResult: "",
  };
  const payload = { projectName: "Shop", targetUrl: "http://localhost:5173", specification: "", accessibilitySnapshot: snapshot };
  const attempts: Array<{ passed: boolean }> = [];
  const chatCalls: unknown[] = [];
  const ollamaClient = {
    chat: async (request: unknown) => {
      chatCalls.push(request);
      return { message: { role: "assistant", content: JSON.stringify({ id: "x", title: "t", script: "import { test, expect } from '@playwright/test';\ntest('t', async ({ page }) => {\n  await page.goto('http://localhost:5173');\n  await expect(page).toHaveURL(/localhost/);\n});\n" }) } };
    },
  } as never;
  const options = { ollamaClient, metricsHooks: { onScriptAttempt: (attempt: { passed: boolean }) => attempts.push(attempt) } };

  const structured = {
    version: 1,
    steps: [{ kind: "fill", elementId: search.id, value: "zzqxnotfound" }],
    oracle: { kind: "textVisible", text: "ไม่พบสินค้าที่ตรงกับเงื่อนไข" },
  };
  const compiled = await generateCaseScript("job-1", payload, plan, { structured }, options);
  assert.equal(chatCalls.length, 0, "no LLM call for a structured case");
  assert.match(compiled.script, /getByRole\("textbox", \{ name: "ค้นหาสินค้าด้วยชื่อ\.\.\.", exact: true \}\)\.fill\("zzqxnotfound"\)/);
  assert.deepEqual(attempts, [{ attempt: 1, passed: true }]);

  await assert.rejects(
    generateCaseScript("job-1", payload, plan, { structured: { ...structured, steps: [{ kind: "click", elementId: "E999" }] } }, options),
    /could not be compiled: Element E999/,
  );

  await generateCaseScript("job-1", payload, plan, { title: plan.title }, options);
  assert.equal(chatCalls.length, 1, "legacy cases still use the script model");
});
