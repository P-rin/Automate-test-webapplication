import { env } from "../config/env.js";
import {
  TEST_PLAN_CATEGORIES,
  type AcceptanceCriterion,
  type RequirementUnit,
  type TestPlanCategory,
} from "../types.js";
import { ACCEPTANCE_CRITERIA_INSTRUCTIONS, ACCEPTANCE_CRITERIA_SYSTEM } from "../prompts/requirementPrompts.js";
import { createRunContext, truncateText, type LlmGenerationOptions } from "./ollamaService.js";

type CriterionCategory = Exclude<TestPlanCategory, "exploratory">;
type CriterionPriority = AcceptanceCriterion["priority"];
type CriterionVerification = AcceptanceCriterion["verification"];

type UnassignedCriterion = Omit<AcceptanceCriterion, "id">;

const isRequirementStart = (line: string): boolean =>
  /^\s*((?:REQ|FR|NFR|US|UC)[-_ ]?\d+)\s*[:.)\-]\s*(.+)/i.test(line)
  || /^\s*[-*+]\s+(.+)/.test(line)
  || /^\s*\d+(?:\.\d+)*[.)]\s+(.+)/.test(line)
  || /^\s*Scenario(?:\s+Outline)?\s*:\s*.+/i.test(line);

const isGherkinStep = (line: string): boolean =>
  /^\s*(?:(?:Given|When|Then|And|But)\b|กำหนดให้|เมื่อ|แล้ว)/i.test(line);

export interface SplitRequirementUnitsResult {
  units: RequirementUnit[];
  warnings: string[];
}

export const splitRequirementUnitsWithWarnings = (
  specification: string,
  maxUnits = env.requirementMaxUnits,
): SplitRequirementUnitsResult => {
  const normalized = specification.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return { units: [], warnings: [] };

  const extracted: Array<{ section: string; sourceText: string }> = [];
  let section = "";
  let current: { section: string; lines: string[]; gherkin: boolean } | undefined;

  const flush = () => {
    if (!current) return;
    const sourceText = current.lines.join("\n").trim();
    if (sourceText.length >= 8) extracted.push({ section: current.section, sourceText });
    current = undefined;
  };

  for (const rawLine of normalized.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      flush();
      continue;
    }

    const headingMatch = line.match(/^#{1,6}\s+(.+)/);
    if (headingMatch) {
      flush();
      section = headingMatch[1].trim();
      continue;
    }

    if (isRequirementStart(rawLine)) {
      flush();
      current = {
        section,
        lines: [line],
        gherkin: /^\s*Scenario(?:\s+Outline)?\s*:/i.test(rawLine),
      };
      continue;
    }

    if (current?.gherkin && isGherkinStep(rawLine)) {
      current.lines.push(line);
      continue;
    }

    if (current) {
      current.lines.push(line);
    } else {
      current = { section, lines: [line], gherkin: false };
    }
  }
  flush();

  const safeMaxUnits = Number.isInteger(maxUnits) && maxUnits > 0 ? maxUnits : env.requirementMaxUnits;
  const capped = extracted.length > safeMaxUnits;
  const units = extracted.slice(0, safeMaxUnits).map((unit, index) => ({
    ref: `R${index + 1}`,
    section: unit.section,
    sourceText: unit.sourceText,
  }));
  return {
    units,
    warnings: capped ? [`Requirement units capped at ${safeMaxUnits}.`] : [],
  };
};

export const splitRequirementUnits = (specification: string): RequirementUnit[] =>
  splitRequirementUnitsWithWarnings(specification).units;

const criterionCategories: readonly CriterionCategory[] = TEST_PLAN_CATEGORIES
  .filter((category): category is CriterionCategory => category !== "exploratory");
const priorities: readonly CriterionPriority[] = ["required", "important", "optional"];
const verifications: readonly CriterionVerification[] = ["automated", "manual"];

const isUnassignedCriterion = (value: unknown): value is UnassignedCriterion => {
  if (typeof value !== "object" || value == null) return false;
  const criterion = value as Record<string, unknown>;
  return typeof criterion.requirementRef === "string"
    && typeof criterion.scenario === "string"
    && typeof criterion.action === "string"
    && typeof criterion.expected === "string"
    && typeof criterion.mustNot === "string"
    && typeof criterion.category === "string"
    && criterionCategories.includes(criterion.category as CriterionCategory)
    && typeof criterion.priority === "string"
    && priorities.includes(criterion.priority as CriterionPriority)
    && typeof criterion.verification === "string"
    && verifications.includes(criterion.verification as CriterionVerification)
    && typeof criterion.ambiguity === "string";
};

const normalizeKeyPart = (value: string): string => value.trim().replace(/\s+/g, " ").toLocaleLowerCase();

export const normalizeAcceptanceCriteria = (
  values: unknown[],
  units: RequirementUnit[],
  maxCriteria = env.requirementMaxCriteria,
): { criteria: AcceptanceCriterion[]; warnings: string[] } => {
  const unitOrder = new Map(units.map((unit, index) => [unit.ref, index]));
  const uniqueKeys = new Set<string>();
  const grouped = new Map<string, Array<{ criterion: UnassignedCriterion; sourceIndex: number }>>();

  values.forEach((value, sourceIndex) => {
    if (!isUnassignedCriterion(value)
      || !unitOrder.has(value.requirementRef)
      || !value.action.trim()
      || !value.expected.trim()) return;

    const key = [
      normalizeKeyPart(value.scenario),
      normalizeKeyPart(value.action),
      normalizeKeyPart(value.expected),
    ].join("|");
    if (uniqueKeys.has(key)) return;
    uniqueKeys.add(key);

    const group = grouped.get(value.requirementRef) ?? [];
    group.push({
      criterion: {
        requirementRef: value.requirementRef,
        scenario: value.scenario.trim(),
        action: value.action.trim(),
        expected: value.expected.trim(),
        mustNot: value.mustNot.trim(),
        category: value.category,
        priority: value.priority,
        verification: value.verification,
        ambiguity: value.ambiguity.trim(),
      },
      sourceIndex,
    });
    grouped.set(value.requirementRef, group);
  });

  const candidates = units.flatMap((unit, index) =>
    (grouped.get(unit.ref) ?? []).map((entry) => ({ ...entry, unitIndex: index })));
  const priorityRank = (priority: CriterionPriority) => priorities.indexOf(priority);
  const selected: typeof candidates = [];
  const countsByUnit = new Map<string, number>();
  const maximum = Number.isInteger(maxCriteria) && maxCriteria > 0 ? maxCriteria : env.requirementMaxCriteria;
  const prioritized = [...candidates].sort((left, right) =>
    priorityRank(left.criterion.priority) - priorityRank(right.criterion.priority)
    || left.unitIndex - right.unitIndex
    || left.sourceIndex - right.sourceIndex);

  for (const candidate of prioritized) {
    if (selected.length >= maximum) break;
    const ref = candidate.criterion.requirementRef;
    const count = countsByUnit.get(ref) ?? 0;
    if (count >= 6) continue;
    selected.push(candidate);
    countsByUnit.set(ref, count + 1);
  }

  selected.sort((left, right) => left.unitIndex - right.unitIndex || left.sourceIndex - right.sourceIndex);
  const criteria = selected.map(({ criterion }, index) => ({
    id: `AC-${String(index + 1).padStart(3, "0")}`,
    ...criterion,
  }));
  const warnings = units
    .filter((unit) => !criteria.some((criterion) => criterion.requirementRef === unit.ref))
    .map((unit) => `${unit.ref}: no verifiable criterion`);
  return { criteria, warnings };
};

const responseFormat = {
  type: "object",
  properties: {
    criteria: {
      type: "array",
      items: {
        type: "object",
        properties: {
          requirementRef: { type: "string" },
          scenario: { type: "string" },
          action: { type: "string" },
          expected: { type: "string" },
          mustNot: { type: "string" },
          category: { type: "string", enum: criterionCategories },
          priority: { type: "string", enum: priorities },
          verification: { type: "string", enum: verifications },
          ambiguity: { type: "string" },
        },
        required: [
          "requirementRef",
          "scenario",
          "action",
          "expected",
          "mustNot",
          "category",
          "priority",
          "verification",
          "ambiguity",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["criteria"],
  additionalProperties: false,
};

const parseCriteriaResponse = (raw: string): UnassignedCriterion[] => {
  const normalized = raw.trim();
  const fenced = normalized.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const parsed: unknown = JSON.parse(fenced ? fenced[1] : normalized);
  if (typeof parsed !== "object" || parsed == null || !Array.isArray((parsed as { criteria?: unknown }).criteria)) {
    throw new Error("Model response must contain a criteria array");
  }
  const criteria = (parsed as { criteria: unknown[] }).criteria;
  if (!criteria.every(isUnassignedCriterion)) {
    throw new Error("Model response contains an invalid acceptance criterion");
  }
  return criteria;
};

const renderUnit = (unit: RequirementUnit): string =>
  `${unit.ref}${unit.section ? ` [${unit.section}]` : ""} ${unit.sourceText.replace(/\s+/g, " ").trim()}`;

const buildPromptPrefix = (targetUrl: string): string => [
  ACCEPTANCE_CRITERIA_INSTRUCTIONS,
  "",
  `Target URL: ${targetUrl}`,
  "",
  "[Requirement units]",
].join("\n") + "\n";

const fitPromptToBudget = (prompt: string, maxPromptChars: number): string =>
  prompt.length <= maxPromptChars
    ? prompt
    : truncateText(prompt, Math.max(0, maxPromptChars - 80), "[Acceptance criteria prompt]").slice(0, maxPromptChars);

const buildBatches = (
  units: RequirementUnit[],
  targetUrl: string,
  maxPromptChars: number,
): string[][] => {
  const prefix = buildPromptPrefix(targetUrl);
  if (prefix.length >= maxPromptChars) return [];
  const batches: string[][] = [];
  let batch: string[] = [];

  for (const unit of units) {
    let line = renderUnit(unit);
    if (prefix.length + line.length > maxPromptChars) {
      const availableLineChars = Math.max(1, maxPromptChars - prefix.length);
      const label = `${unit.ref}${unit.section ? ` [${unit.section}]` : ""} `;
      const sourceBudget = Math.max(0, availableLineChars - label.length - 80);
      line = `${label}${truncateText(unit.sourceText.replace(/\s+/g, " ").trim(), sourceBudget, "requirement unit")}`
        .slice(0, availableLineChars);
    }

    const candidate = [...batch, line];
    if (batch.length > 0 && prefix.length + candidate.join("\n").length > maxPromptChars) {
      batches.push(batch);
      batch = [line];
    } else {
      batch = candidate;
    }
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
};

export const generateAcceptanceCriteria = async (
  units: RequirementUnit[],
  targetUrl: string,
  options: LlmGenerationOptions,
): Promise<{ criteria: AcceptanceCriterion[]; warnings: string[] }> => {
  if (units.length === 0) return { criteria: [], warnings: [] };

  const maxPromptChars = options.maxPromptChars ?? env.llmMaxPromptChars;
  const prefix = buildPromptPrefix(targetUrl);
  if (prefix.length >= maxPromptChars) {
    const normalized = normalizeAcceptanceCriteria([], units);
    return {
      criteria: normalized.criteria,
      warnings: [`Acceptance-criteria instructions exceed the ${maxPromptChars}-character prompt budget.`, ...normalized.warnings],
    };
  }
  const batches = buildBatches(units, targetUrl, maxPromptChars);
  const runPrompt = createRunContext({ ...options, usePlaywrightTools: false }, "planner");
  const rawCriteria: UnassignedCriterion[] = [];
  const warnings: string[] = [];

  for (let index = 0; index < batches.length; index += 1) {
    const prompt = fitPromptToBudget(`${prefix}${batches[index].join("\n")}`, maxPromptChars);
    let batchCriteria: UnassignedCriterion[] | undefined;
    let lastError: unknown;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        batchCriteria = parseCriteriaResponse(await runPrompt(prompt, ACCEPTANCE_CRITERIA_SYSTEM, responseFormat));
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (batchCriteria) {
      rawCriteria.push(...batchCriteria);
    } else {
      const detail = lastError instanceof Error ? lastError.message : String(lastError);
      warnings.push(`Acceptance-criteria batch ${index + 1}/${batches.length} failed after retry: ${detail}`);
    }
  }

  const normalized = normalizeAcceptanceCriteria(rawCriteria, units);
  return { criteria: normalized.criteria, warnings: [...warnings, ...normalized.warnings] };
};
