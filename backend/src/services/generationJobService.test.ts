import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRetryTestPlan,
  buildPlannedGenerationCase,
  decodeGenerationSnapshot,
  encodeGenerationSnapshot,
  findBestSnapshotForCriterion,
  findSnapshotForPage,
  runCoverageGapPass,
} from "./generationJobService.js";
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