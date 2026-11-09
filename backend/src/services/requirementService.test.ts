import test from "node:test";
import assert from "node:assert/strict";

import {
  generateAcceptanceCriteria,
  normalizeAcceptanceCriteria,
  splitRequirementUnits,
  splitRequirementUnitsWithWarnings,
} from "./requirementService.js";
import { ACCEPTANCE_CRITERIA_INSTRUCTIONS } from "../prompts/requirementPrompts.js";
import type { AcceptanceCriterion, RequirementUnit } from "../types.js";
import type { LlmGenerationOptions } from "./ollamaService.js";

const makeCriterion = (
  requirementRef: string,
  overrides: Partial<Omit<AcceptanceCriterion, "id" | "requirementRef">> = {},
): Omit<AcceptanceCriterion, "id"> => ({
  requirementRef,
  scenario: "ผู้ใช้เปิดหน้าแบบฟอร์ม",
  action: "กดปุ่มบันทึก",
  expected: "หน้าแสดงผลสำเร็จ",
  mustNot: "",
  category: "happy_path",
  priority: "required",
  verification: "automated",
  ambiguity: "",
  ...overrides,
});

test("splitRequirementUnits tracks headings and splits ID, bullet, numbered, and Gherkin requirements", () => {
  const units = splitRequirementUnits([
    "# การสมัครสมาชิก",
    "REQ-1: ผู้ใช้สามารถสมัครด้วยอีเมลได้",
    "และเห็นหน้าสำเร็จหลังส่งข้อมูล",
    "- ระบบต้องปฏิเสธอีเมลที่ไม่ถูกต้อง",
    "1. เมื่อข้อมูลครบ ให้แสดงปุ่มบันทึก",
    "Scenario: สมัครสมาชิกสำเร็จ",
    "  Given ผู้ใช้เปิดหน้า signup",
    "  When กรอกข้อมูลและกด Submit",
    "  แล้วเห็นข้อความยืนยัน",
  ].join("\r\n"));

  assert.deepEqual(units, [
    {
      ref: "R1",
      section: "การสมัครสมาชิก",
      sourceText: "REQ-1: ผู้ใช้สามารถสมัครด้วยอีเมลได้\nและเห็นหน้าสำเร็จหลังส่งข้อมูล",
    },
    {
      ref: "R2",
      section: "การสมัครสมาชิก",
      sourceText: "- ระบบต้องปฏิเสธอีเมลที่ไม่ถูกต้อง",
    },
    {
      ref: "R3",
      section: "การสมัครสมาชิก",
      sourceText: "1. เมื่อข้อมูลครบ ให้แสดงปุ่มบันทึก",
    },
    {
      ref: "R4",
      section: "การสมัครสมาชิก",
      sourceText: "Scenario: สมัครสมาชิกสำเร็จ\nGiven ผู้ใช้เปิดหน้า signup\nWhen กรอกข้อมูลและกด Submit\nแล้วเห็นข้อความยืนยัน",
    },
  ]);
});

test("splitRequirementUnits groups paragraphs, preserves Thai text, and ignores short units", () => {
  const units = splitRequirementUnits(
    "ยืนยันตัวตนผ่านรหัส OTP\nแล้วกลับสู่หน้าหลัก\n\nThis paragraph describes a separate browser behavior.",
  );

  assert.deepEqual(units, [
    {
      ref: "R1",
      section: "",
      sourceText: "ยืนยันตัวตนผ่านรหัส OTP\nแล้วกลับสู่หน้าหลัก",
    },
    {
      ref: "R2",
      section: "",
      sourceText: "This paragraph describes a separate browser behavior.",
    },
  ]);
  assert.deepEqual(splitRequirementUnits(" \r\n\t "), []);
  assert.deepEqual(splitRequirementUnits("tiny\n\nshort"), []);
});

test("splitRequirementUnits starts a new section at each markdown heading", () => {
  const units = splitRequirementUnits([
    "## Login",
    "Users can sign in to their account",
    "### Password",
    "The system rejects an invalid password",
  ].join("\n"));

  assert.deepEqual(units.map(({ ref, section }) => ({ ref, section })), [
    { ref: "R1", section: "Login" },
    { ref: "R2", section: "Password" },
  ]);
});

test("splitRequirementUnitsWithWarnings caps units and records a warning", () => {
  const result = splitRequirementUnitsWithWarnings([
    "- The first behavior is visible",
    "- The second behavior is visible",
    "- The third behavior is visible",
  ].join("\n"), 2);

  assert.deepEqual(result.units.map((unit) => unit.ref), ["R1", "R2"]);
  assert.deepEqual(result.warnings, ["Requirement units capped at 2."]);
});

test("normalizeAcceptanceCriteria drops unknown and empty entries, deduplicates, prioritizes, and assigns IDs by unit", () => {
  const units: RequirementUnit[] = [
    { ref: "R1", section: "", sourceText: "First user behavior" },
    { ref: "R2", section: "", sourceText: "Second user behavior" },
  ];
  const result = normalizeAcceptanceCriteria([
    makeCriterion("R2", {
      scenario: "ผู้ใช้เปิดหน้ารายการ",
      action: "เลือกแถวรายการ",
      expected: "หน้ารายละเอียดรายการแสดงขึ้น",
    }),
    makeCriterion("UNKNOWN"),
    makeCriterion("R1", { action: "  " }),
    makeCriterion("R1", { scenario: "ผู้ใช้เปิดหน้าแบบฟอร์ม  ", action: "กดปุ่มบันทึก", expected: "หน้าแสดงผลสำเร็จ" }),
    makeCriterion("R1", { priority: "optional", scenario: "เงื่อนไขพิเศษ", action: "กรอกข้อมูลเพิ่มเติม", expected: "แสดงข้อมูลเพิ่มเติม" }),
  ], units);

  assert.deepEqual(result.criteria.map(({ id, requirementRef }) => ({ id, requirementRef })), [
    { id: "AC-001", requirementRef: "R1" },
    { id: "AC-002", requirementRef: "R1" },
    { id: "AC-003", requirementRef: "R2" },
  ]);
  assert.deepEqual(result.warnings, []);
});

test("normalizeAcceptanceCriteria limits six criteria per unit and puts required criteria first at the total cap", () => {
  const units: RequirementUnit[] = [
    { ref: "R1", section: "", sourceText: "First user behavior" },
    { ref: "R2", section: "", sourceText: "Second user behavior" },
  ];
  const values = [
    ...Array.from({ length: 8 }, (_, index) => makeCriterion("R1", {
      scenario: `Scenario ${index}`,
      action: `Action ${index}`,
      expected: `Expected ${index}`,
      priority: index === 7 ? "required" : "optional",
    })),
    makeCriterion("R2", {
      scenario: "Required second behavior",
      action: "Open the other page",
      expected: "The other page is visible",
      priority: "required",
    }),
  ];

  const perUnitCapped = normalizeAcceptanceCriteria(values, units);
  assert.equal(perUnitCapped.criteria.filter((criterion) => criterion.requirementRef === "R1").length, 6);
  assert.equal(perUnitCapped.criteria.some((criterion) => criterion.scenario === "Scenario 7"), true);

  const totalCapped = normalizeAcceptanceCriteria(values, units, 2);
  assert.deepEqual(totalCapped.criteria.map((criterion) => criterion.scenario), [
    "Scenario 7",
    "Required second behavior",
  ]);
  assert.equal(totalCapped.criteria.every((criterion) => criterion.priority === "required"), true);
});

test("normalizeAcceptanceCriteria warns when a unit has no verifiable criteria", () => {
  const units: RequirementUnit[] = [
    { ref: "R1", section: "", sourceText: "First user behavior" },
    { ref: "R2", section: "", sourceText: "Second user behavior" },
  ];
  const result = normalizeAcceptanceCriteria([makeCriterion("R1")], units);

  assert.deepEqual(result.warnings, ["R2: no verifiable criterion"]);
});

test("generateAcceptanceCriteria batches within the prompt budget and continues after one failed batch retry", async () => {
  const units: RequirementUnit[] = ["R1", "R2", "R3"].map((ref) => ({
    ref,
    section: "Account",
    sourceText: `${ref} ${"long requirement text ".repeat(30)}`,
  }));
  const prompts: string[] = [];
  let requests = 0;
  const ollamaClient = {
    chat: async (request: {
      messages: Array<{ role: string; content: string }>;
      format?: unknown;
      tools?: unknown[];
    }) => {
      requests += 1;
      const prompt = request.messages.find((message) => message.role === "user")?.content ?? "";
      prompts.push(prompt);
      assert.deepEqual(request.tools, []);
      assert.equal(typeof request.format, "object");
      if (prompt.includes("R1 [Account]")) return { message: { content: "invalid json" } };
      const criteria = (["R2", "R3"] as const)
        .filter((requirementRef) => prompt.includes(`${requirementRef} [Account]`))
        .map((requirementRef) => makeCriterion(requirementRef, {
          scenario: `${requirementRef} ผู้ใช้เปิดหน้าแบบฟอร์ม`,
          action: `กดปุ่มบันทึก ${requirementRef}`,
          expected: `หน้าแสดงผลสำเร็จ ${requirementRef}`,
        }));
      return {
        message: {
          content: JSON.stringify({ criteria }),
        },
      };
    },
  } as unknown as NonNullable<LlmGenerationOptions["ollamaClient"]>;
  const maxPromptChars = ACCEPTANCE_CRITERIA_INSTRUCTIONS.length + 700;

  const result = await generateAcceptanceCriteria(units, "https://example.com", {
    ollamaClient,
    maxPromptChars,
  });

  assert.ok(prompts.length > 2);
  assert.ok(prompts.every((prompt) => prompt.length <= maxPromptChars));
  assert.equal(requests, prompts.length);
  assert.deepEqual(result.criteria.map((criterion) => criterion.requirementRef), ["R2", "R3"]);
  assert.equal(result.warnings.some((warning) => warning.includes("batch 1/") && warning.includes("failed after retry")), true);
  assert.deepEqual(result.warnings.filter((warning) => warning.includes("no verifiable criterion")), [
    "R1: no verifiable criterion",
  ]);
});
