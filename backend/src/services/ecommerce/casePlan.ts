/**
 * Turns structured cases (template candidates or validated exploratory cases) into the TestPlan shape the job
 * stores, with readable Thai steps for the user and the structure (`structured`) that the compiler uses.
 * Also proposes 1–2 exploratory cases per page (Phase 4e) with the enum schema of Phase 2.
 */
import type { AcceptanceCriterion, TestPlan } from "../../types.js";
import { formatCoveredCase, type CoveredCase } from "../planDedup.js";
import { renderCriteriaForPrompt } from "../ollamaService.js";
import {
  buildExploratorySchema,
  MONEY_IN_ORACLE_ISSUE,
  parseExploratoryResponse,
  promptElements,
  STATUS_NEW_CASE,
  STATUS_NO_MORE,
} from "./dynamicSchemas.js";
import type { AskJson } from "./candidateSelector.js";
import { STRUCTURED_CASE_VERSION } from "./storedCase.js";
import { describe, elementLabel, fieldRef } from "./templates/helpers.js";
import type { CandidateCase, ElementInventory, ExploratoryCase, InventoryElement, PageType, StructuredStep } from "./types.js";

const pathOf = (url: string): string => {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
};

const valueTh = (value: string): string => {
  const env = value.match(/^\{\{env\.([A-Za-z_][A-Za-z0-9_]*)\}\}$/);
  if (env) return `ค่า ${env[1]} จากตัวแปรสภาพแวดล้อม`;
  if (value === "") return "ค่าว่าง";
  if (value.trim() === "") return "ช่องว่างล้วน";
  return value.length > 40 ? `"${value.slice(0, 20)}…" (ยาว ${value.length} ตัวอักษร)` : `"${value}"`;
};

/** Thai description of one step for testSteps. */
export const describeStep = (step: StructuredStep, inventory: ElementInventory): string => {
  const element = (id: string): InventoryElement | undefined => inventory.elements.find((candidate) => candidate.id === id);
  const ref = (id: string) => {
    const target = element(id);
    if (!target) return id;
    return target.interactive && ["textbox", "searchbox", "spinbutton", "combobox"].includes(target.role) ? fieldRef(target) : describe(target);
  };
  switch (step.kind) {
    case "goto":
      return `เปิดหน้า ${pathOf(step.url)}`;
    case "reload":
      return "โหลดหน้าใหม่";
    case "fill":
      return step.value === "" ? `ล้าง${ref(step.elementId)}ให้ว่าง` : `กรอก ${valueTh(step.value)} ใน${ref(step.elementId)}`;
    case "click":
      return `คลิก ${ref(step.elementId)}`;
    case "selectOption":
      return `เลือก "${step.optionLabel}" ใน${ref(step.elementId)}`;
    case "check":
      return `เลือก ${ref(step.elementId)}`;
    case "uncheck":
      return `ยกเลิกการเลือก ${ref(step.elementId)}`;
    case "press":
      return `กดปุ่ม ${step.key} ที่${ref(step.elementId)}`;
    case "precondition":
      return `เตรียมสถานะ: ${step.recipeId}`;
  }
};

interface StructuredSource {
  steps: StructuredStep[];
  oracle: CandidateCase["oracle"];
  preconditionId?: string;
  loggedOut?: boolean;
}

const testStepsFor = (source: StructuredSource, inventory: ElementInventory): string[] => [
  ...(source.loggedOut ? ["เริ่มโดยยังไม่ได้เข้าสู่ระบบ"] : []),
  ...(source.preconditionId ? [`เตรียมสถานะ: ${source.preconditionId}`] : []),
  ...(source.steps[0]?.kind === "goto" ? [] : inventory.navigationPath.map((step) => describeStep(step, inventory))),
  ...source.steps.map((step) => describeStep(step, inventory)),
];

const structuredFor = (source: StructuredSource, pageType: PageType, origin: string): Record<string, unknown> => ({
  version: STRUCTURED_CASE_VERSION,
  steps: source.steps,
  oracle: source.oracle,
  ...(source.preconditionId ? { preconditionId: source.preconditionId } : {}),
  ...(source.loggedOut ? { loggedOut: true } : {}),
  pageType,
  origin,
});

export const candidateToPlan = (
  candidate: CandidateCase,
  selection: { titleTh: string; requirementIds: string[] },
  inventory: ElementInventory,
  pageType: PageType,
): TestPlan => {
  const target = inventory.elements.find((element) => element.id === candidate.targetElementId);
  return {
    id: `${candidate.templateId}:${candidate.id}`,
    title: selection.titleTh || candidate.titleTh,
    description: `${candidate.titleTh} (template ${candidate.templateId})`,
    type: "UI",
    testSteps: testStepsFor(candidate, inventory),
    expectedResult: candidate.expectedResultTh,
    requirementIds: selection.requirementIds,
    category: selection.requirementIds.length === 0 && candidate.category === "happy_path" ? "happy_path" : candidate.category,
    targetElement: target ? elementLabel(target) : candidate.targetElementId,
    inputVariant: candidate.inputVariant,
    structured: structuredFor(candidate, pageType, `template:${candidate.templateId}`),
  };
};

export const exploratoryToPlan = (exploratory: ExploratoryCase, inventory: ElementInventory, pageType: PageType, index: number): TestPlan => {
  const target = inventory.elements.find((element) => element.id === exploratory.targetElementId);
  return {
    id: `exploratory:${index}`,
    title: exploratory.titleTh,
    description: exploratory.descriptionTh || exploratory.titleTh,
    type: "UI",
    testSteps: testStepsFor(exploratory, inventory),
    expectedResult: exploratory.expectedResultTh,
    requirementIds: exploratory.requirementIds,
    category: exploratory.category,
    targetElement: target ? elementLabel(target) : exploratory.targetElementId,
    inputVariant: exploratory.inputVariant,
    structured: structuredFor(exploratory, pageType, "exploratory"),
  };
};

export const MAX_EXPLORATORY_PER_PAGE = 2;

export interface ExploratoryInput {
  inventory: ElementInventory;
  pageText: string;
  acceptanceCriteria: AcceptanceCriterion[];
  coveredAcIds: ReadonlySet<string>;
  /** Cases already planned (this page and earlier ones), so the model does not repeat them. */
  coveredCases: () => readonly CoveredCase[];
  allowMutatingTests: boolean;
  maxPromptChars?: number;
}

export interface ExploratoryOutcome {
  cases: ExploratoryCase[];
  calls: number;
  rejected: Array<{ reason: string; issues: string[] }>;
}

export const buildExploratoryPrompt = (input: ExploratoryInput): string => {
  const budget = input.maxPromptChars ?? 6000;
  const covered = input.coveredCases().slice(-25).map(formatCoveredCase).join("\n") || "ไม่มี";
  return [
    "เสนอ test case เพิ่ม 1 ข้อสำหรับหน้านี้ ที่ไม่ซ้ำกับ [Covered] (element เดียวกัน + ค่าเดียวกัน = ซ้ำ)",
    "steps และ oracle ใช้ได้เฉพาะ element ID จาก [หน้าเว็บ]; oracle ต้องตรวจสิ่งที่เห็นได้ ห้ามคำนวณตัวเลขเงินเอง",
    `ถ้าไม่มีอะไรที่มีประโยชน์และไม่ซ้ำ ให้ status=${STATUS_NO_MORE}; ถ้ามีให้ status=${STATUS_NEW_CASE}`,
    ...(input.allowMutatingTests ? [] : ["ห้ามกดยืนยันคำสั่งซื้อ ชำระเงิน หรือลบข้อมูลบัญชี"]),
    "เขียน titleTh, descriptionTh, expectedResultTh เป็นภาษาไทย ตอบ JSON ตาม schema เท่านั้น",
    "[AC]",
    input.acceptanceCriteria.length ? renderCriteriaForPrompt(input.acceptanceCriteria, input.coveredAcIds, Math.floor(budget * 0.2)) : "ไม่มี AC",
    "[หน้าเว็บ]",
    input.pageText,
    "[Covered]",
    covered,
  ].join("\n");
};

/**
 * Up to MAX_EXPLORATORY_PER_PAGE calls. Invalid answers (invented elements, unusable steps) are dropped, and so
 * are cases whose oracle asserts an amount the model computed (the weak assertions of P4).
 */
export const proposeExploratoryCases = async (input: ExploratoryInput, ask: AskJson, max = MAX_EXPLORATORY_PER_PAGE): Promise<ExploratoryOutcome> => {
  const elements = promptElements(input.inventory);
  const acIds = input.acceptanceCriteria.map((criterion) => criterion.id);
  const schema = buildExploratorySchema(elements, acIds, { allowUrlOracles: input.inventory.urlIsStable });
  const outcome: ExploratoryOutcome = { cases: [], calls: 0, rejected: [] };
  const accepted: CoveredCase[] = [];
  for (let attempt = 0; attempt < max; attempt += 1) {
    outcome.calls += 1;
    let raw: string;
    try {
      raw = await ask(buildExploratoryPrompt({ ...input, coveredCases: () => [...input.coveredCases(), ...accepted] }), schema);
    } catch (error) {
      outcome.rejected.push({ reason: "call_failed", issues: [error instanceof Error ? error.message : String(error)] });
      break;
    }
    const result = parseExploratoryResponse(raw, { elements, acIds, allowUrlOracles: input.inventory.urlIsStable });
    if (result.status === "done") break;
    if (result.status === "invalid") {
      outcome.rejected.push({ reason: "invalid", issues: result.issues });
      continue;
    }
    if (result.issues.some((issue) => issue.startsWith(MONEY_IN_ORACLE_ISSUE))) {
      outcome.rejected.push({ reason: "model_written_amount", issues: result.issues });
      continue;
    }
    outcome.cases.push(result.case);
    const target = input.inventory.elements.find((element) => element.id === result.case.targetElementId);
    accepted.push({ title: result.case.titleTh, targetElement: target ? elementLabel(target) : "", inputVariant: result.case.inputVariant });
  }
  return outcome;
};
