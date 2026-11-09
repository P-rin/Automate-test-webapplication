import test from "node:test";
import assert from "node:assert/strict";

import {
  computeCoverage,
  renderCoverageMarkdown,
  type CoverageState,
} from "./coverageService.js";
import type { AcceptanceCriterion } from "../types.js";

const makeCriterion = (
  id: string,
  overrides: Partial<AcceptanceCriterion> = {},
): AcceptanceCriterion => ({
  id,
  requirementRef: "R1",
  scenario: "ผู้ใช้เปิดหน้าแบบฟอร์ม",
  action: "ส่งแบบฟอร์ม",
  expected: "หน้าแสดงผลสำเร็จ",
  mustNot: "",
  category: "happy_path",
  priority: "required",
  verification: "automated",
  ambiguity: "",
  ...overrides,
});

test("computeCoverage returns each specified state and coverage totals", () => {
  const criteria = [
    makeCriterion("AC-001", { verification: "manual", ambiguity: "ต้องยืนยันถ้อยคำ" }),
    makeCriterion("AC-002"),
    makeCriterion("AC-003"),
    makeCriterion("AC-004"),
    makeCriterion("AC-005"),
    makeCriterion("AC-006"),
    makeCriterion("AC-007"),
    makeCriterion("AC-008"),
  ];
  const cases = [
    { id: "case-2", title: "Not planned yet", status: "planned", requirementIds: ["AC-002"] },
    { id: "case-3", title: "Saved test", status: "saved", requirementIds: ["AC-003"], testCaseId: "test-3" },
    { id: "case-4", title: "Failed test", status: "saved", requirementIds: ["AC-004"], testCaseId: "test-4" },
    { id: "case-5", title: "Passed test", status: "saved", requirementIds: ["AC-005"], testCaseId: "test-5" },
    { id: "case-6", title: "Flaky test", status: "saved", requirementIds: ["AC-006"], testCaseId: "test-6" },
    { id: "case-8", title: "Failed generation", status: "failed", requirementIds: ["AC-008"] },
  ];
  const report = computeCoverage(criteria, cases, [
    { id: "test-3", lastStatus: "pending", generationCaseId: "case-3" },
    { id: "test-4", lastStatus: "fail", generationCaseId: "case-4" },
    { id: "test-5", lastStatus: "pass", generationCaseId: "case-5" },
    { id: "test-6", lastStatus: "flaky", generationCaseId: "case-6" },
  ], [
    { acId: "AC-007", reason: "planner could not create a case" },
    { acId: "AC-008", reason: "case generation failed" },
  ]);
  const stateById = Object.fromEntries(report.criteria.map(({ id, state }) => [id, state])) as Record<string, CoverageState>;

  assert.deepEqual(stateById, {
    "AC-001": "manual",
    "AC-002": "in_progress",
    "AC-003": "unverified",
    "AC-004": "failing",
    "AC-005": "covered",
    "AC-006": "unverified",
    "AC-007": "missing",
    "AC-008": "missing",
  });
  assert.deepEqual(report.totals, {
    missing: 2,
    in_progress: 1,
    unverified: 2,
    failing: 1,
    covered: 1,
    manual: 1,
  });
  assert.equal(report.criteria.find((criterion) => criterion.id === "AC-007")?.gapReason, "planner could not create a case");
  assert.equal(report.criteria.find((criterion) => criterion.id === "AC-008")?.gapReason, "case generation failed");
  assert.deepEqual(report.ambiguities, [{ acId: "AC-001", text: "ต้องยืนยันถ้อยคำ" }]);
});

test("computeCoverage reports a linked failing test even when another linked case passed", () => {
  const criterion = makeCriterion("AC-001");
  const cases = [
    { id: "case-fail", title: "Reject invalid", status: "saved", requirementIds: ["AC-001"], testCaseId: "fail" },
    { id: "case-pass", title: "Accept valid", status: "saved", requirementIds: ["AC-001"], testCaseId: "pass" },
  ];

  const report = computeCoverage( [criterion], cases, [
    { id: "fail", lastStatus: "fail" },
    { id: "pass", lastStatus: "pass" },
  ], []);

  assert.equal(report.criteria[0].state, "failing");
});

test("computeCoverage flags required input criteria until a linked negative, validation, or boundary case exists", () => {
  const criteria = [
    makeCriterion("AC-001", { category: "happy_path" }),
    makeCriterion("AC-002", {
      category: "validation",
      priority: "important",
      requirementRef: "R1",
    }),
    makeCriterion("AC-003", { category: "negative", requirementRef: "R2" }),
  ];
  const cases = [
    { id: "case-happy", title: "Submit valid data", status: "saved", requirementIds: ["AC-001"], category: "happy_path" },
    { id: "case-validation", title: "Submit empty data", status: "saved", requirementIds: ["AC-002"], category: "validation" },
    { id: "case-exploratory", title: "Explore page", status: "planned", requirementIds: ["AC-003"], category: "exploratory" },
  ];
  const report = computeCoverage(criteria, cases, [], []);

  assert.equal(report.criteria.find((criterion) => criterion.id === "AC-001")?.needsNegativeCase, true);
  assert.equal(report.criteria.find((criterion) => criterion.id === "AC-002")?.needsNegativeCase, false);
  assert.equal(report.criteria.find((criterion) => criterion.id === "AC-003")?.needsNegativeCase, true);
});

test("computeCoverage supports legacy cases without requirementIds", () => {
  const report = computeCoverage(
    [makeCriterion("AC-001")],
    [
      { id: "legacy", title: "Legacy case", status: "saved" },
      { id: "exploratory", title: "Exploratory case", status: "saved", category: "exploratory" },
    ],
    [],
    [],
  );

  assert.equal(report.criteria[0].state, "missing");
  assert.equal(report.exploratoryCaseCount, 1);
});

test("renderCoverageMarkdown renders the report sections as a stable Markdown export", () => {
  const report = computeCoverage(
    [
      makeCriterion("AC-001", {
        expected: "แสดงข้อความ | สำเร็จ",
        ambiguity: "ไม่กำหนดข้อความยืนยัน",
      }),
      makeCriterion("AC-002", {
        requirementRef: "R2",
        scenario: "ผู้ดูแลเปิดหน้าแก้ไข",
        expected: "แสดงข้อมูลรายการ",
        category: "boundary",
        verification: "manual",
      }),
    ],
    [
      {
        id: "case-1",
        title: "ตรวจสอบรายการ",
        status: "saved",
        requirementIds: ["AC-001"],
        category: "happy_path",
        testCaseId: "test-1",
        page: "หน้ารายการ",
      },
    ],
    [{ id: "test-1", lastStatus: "pending", generationCaseId: "case-1" }],
    [{ acId: "AC-002", reason: "no matching page discovered" }],
    [
      { ref: "R1", section: "รายการ", sourceText: "ผู้ใช้ตรวจสอบสถานะของรายการ" },
      { ref: "R2", section: "การแก้ไข", sourceText: "ผู้ดูแลสามารถแก้ไขรายละเอียดรายการได้" },
    ],
    ["วิเคราะห์ข้อมูลบางส่วนไม่สำเร็จ"],
  );

  assert.equal(renderCoverageMarkdown(report), [
    "# TESTS.md",
    "",
    "## Test Asset Map",
    "",
    "| Page | Cases | Categories | Acceptance criteria |",
    "|---|---:|---|---|",
    "| หน้ารายการ | 1 | happy_path | AC-001 |",
    "",
    "## Required Test Points",
    "",
    "### AC-001 — required / happy_path",
    "",
    "- State: unverified",
    "- Source: R1 — รายการ: ผู้ใช้ตรวจสอบสถานะของรายการ",
    "- Expected behavior: แสดงข้อความ \\| สำเร็จ",
    "- Linked test cases: ตรวจสอบรายการ (pending)",
    "",
    "### AC-002 — required / boundary",
    "",
    "- State: manual",
    "- Source: R2 — การแก้ไข: ผู้ดูแลสามารถแก้ไขรายละเอียดรายการได้",
    "- Expected behavior: แสดงข้อมูลรายการ",
    "- Linked test cases: None",
    "",
    "## Manual Verification Exits",
    "",
    "| Check | Expected behavior | Evidence |",
    "|---|---|---|",
    "| AC-002 | แสดงข้อมูลรายการ | |",
    "",
    "## Current Gaps and Actions",
    "",
    "- [ ] AC-001 (required): unverified",
    "- [ ] AC-002 (required): add a negative, validation, or boundary case",
    "",
    "## Ambiguities to confirm",
    "",
    "- AC-001: ไม่กำหนดข้อความยืนยัน",
    "",
  ].join("\n"));
});

test("renderCoverageMarkdown limits source text to 200 characters", () => {
  const report = computeCoverage(
    [makeCriterion("AC-001")],
    [],
    [],
    [],
    [{ ref: "R1", section: "", sourceText: "x".repeat(220) }],
  );
  const sourceLine = renderCoverageMarkdown(report).split("\n").find((line) => line.startsWith("- Source:"));

  assert.equal(sourceLine, `- Source: R1: ${"x".repeat(200)}`);
});
