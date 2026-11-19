/**
 * Phase 2 — JSON schemas built per LLM call, with `enum`s of the IDs that really exist (candidate IDs,
 * AC IDs, element IDs), passed to Ollama as `format` so constrained decoding cannot produce other values.
 *
 * Every response is still validated in code: some Ollama/model versions do not enforce `enum`,
 * `minItems` or `maxItems` completely. Pure functions only.
 */
import { TEST_PLAN_CATEGORIES } from "../../types.js";
import { MONEY_PATTERN } from "./keywords.js";
import type {
  CandidateCategory,
  ElementInventory,
  InventoryElement,
  ElementPurpose,
  ExploratoryCase,
  Oracle,
  StructuredStep,
} from "./types.js";

type JsonSchema = Record<string, unknown>;

/**
 * Step kinds the LLM may use; navigation (goto/reload/precondition) is added by code. Names differ from
 * StructuredStep on purpose: qwen3.5:4b read "check" as "verify" and used it on prices and buttons.
 */
export const LLM_STEP_KINDS = ["fill", "click", "selectOption", "tickCheckbox", "untickCheckbox", "pressKey"] as const;
export type LlmStepKind = typeof LLM_STEP_KINDS[number];

/** Roles each step kind can act on; any interactive element can be clicked or receive a key press. */
const STEP_ROLES: Partial<Record<LlmStepKind, ReadonlySet<string>>> = {
  fill: new Set(["textbox", "searchbox", "spinbutton", "slider"]),
  selectOption: new Set(["combobox", "listbox"]),
  tickCheckbox: new Set(["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"]),
  untickCheckbox: new Set(["checkbox", "switch", "menuitemcheckbox"]),
  pressKey: new Set(["textbox", "searchbox", "spinbutton", "slider", "combobox", "listbox"]),
};

const canAct = (kind: LlmStepKind, element: Pick<SchemaElement, "role" | "interactive">): boolean =>
  element.interactive && (STEP_ROLES[kind]?.has(element.role) ?? true);

/** Step kinds that at least one element of the page supports (no checkbox on the page = no tickCheckbox). */
export const availableStepKinds = (elements: readonly Pick<SchemaElement, "role" | "interactive">[]): LlmStepKind[] =>
  LLM_STEP_KINDS.filter((kind) => elements.some((element) => canAct(kind, element)));

/** Oracle kinds the LLM may pick for exploratory cases; computed oracles (totals, sorting) come only from templates. */
export const LLM_ORACLE_KINDS = [
  "textVisible", "elementVisible", "elementHidden", "elementDisabled", "elementEnabled",
  "inputValueEquals", "validationMessageShown", "emptyStateShown", "urlContains", "urlUnchanged",
] as const;
export type LlmOracleKind = typeof LLM_ORACLE_KINDS[number];
const URL_ORACLE_KINDS: ReadonlySet<string> = new Set(["urlContains", "urlUnchanged"]);
const ELEMENT_ORACLE_KINDS: ReadonlySet<string> = new Set([
  "elementVisible", "elementHidden", "elementDisabled", "elementEnabled", "inputValueEquals", "validationMessageShown",
]);

const CASE_CATEGORIES = TEST_PLAN_CATEGORIES;
/** Non-fatal issue prefix: the oracle asserts a money amount written by the model (for the Phase 8 quality gate). */
export const MONEY_IN_ORACLE_ISSUE = "oracle asserts a model-written amount";
/** Non-fatal issue prefix: the expected result quotes an amount the model computed (seen wrong in smoke tests). */
export const MONEY_IN_EXPECTED_ISSUE = "expected result quotes a model-written amount";
const MAX_TITLE_CHARS = 150;
const MAX_TEXT_CHARS = 300;
export const DEFAULT_MAX_EXPLORATORY_STEPS = 8;
/** Exploratory "status" values the model chooses from. */
export const STATUS_NEW_CASE = "new_case";
export const STATUS_NO_MORE = "no_more_cases";

const unique = (values: readonly string[]): string[] => [...new Set(values.filter((value) => value !== undefined))];

/** String constrained to `values`; never `enum: []` (an empty enum is invalid / unsatisfiable). */
const stringEnum = (values: readonly string[]): JsonSchema =>
  values.length > 0 ? { type: "string", enum: unique(values) } : { type: "string", maxLength: 0 };

/** Array of IDs from `values`; with no values, the only valid answer is []. */
const idArray = (values: readonly string[]): JsonSchema =>
  values.length > 0
    ? { type: "array", items: { type: "string", enum: unique(values) } }
    : { type: "array", items: { type: "string" }, maxItems: 0 };

const object = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

// ---------------------------------------------------------------------------------------------
// Schemas

/** One selection per candidate: keep it?, which ACs it verifies, a polished Thai title. */
export const buildSelectionSchema = (candidateIds: readonly string[], acIds: readonly string[]): JsonSchema => {
  const ids = unique(candidateIds);
  return object({
    selections: {
      type: "array",
      items: object({
        candidateId: stringEnum(ids),
        keep: { type: "boolean" },
        requirementIds: idArray(acIds),
        titleTh: { type: "string" },
      }),
      minItems: ids.length,
      maxItems: ids.length,
    },
  });
};

/** Purpose of up to a few unclear elements at once (Phase 3c); "unknown" is always allowed. */
export const buildPurposeSchema = (allowed: readonly ElementPurpose[], elementIds: readonly string[]): JsonSchema => {
  const ids = unique(elementIds);
  return object({
    answers: {
      type: "array",
      items: object({
        elementId: stringEnum(ids),
        purpose: stringEnum([...allowed.filter((purpose) => purpose !== "unknown"), "unknown"]),
      }),
      minItems: ids.length,
      maxItems: ids.length,
    },
  });
};

export interface ExploratorySchemaOptions {
  /** false when the page/state is not identified by URL (SPA): URL oracles are not offered. */
  allowUrlOracles?: boolean;
  maxSteps?: number;
}

/** What schemas and validators need to know about an inventory element. */
export type SchemaElement = Pick<InventoryElement, "id" | "role" | "interactive" | "options">;

/**
 * One exploratory case whose steps and oracle may only reference listed elements. Steps may only act on
 * interactive elements (a small model otherwise "checks" a price text as if it were an assertion); the oracle
 * may observe any element. Flat objects with every field required (unused fields are "") keep the schema
 * within what Ollama's grammar conversion handles well.
 */
export const buildExploratorySchema = (
  elements: readonly SchemaElement[],
  acIds: readonly string[],
  options: ExploratorySchemaOptions = {},
): JsonSchema => {
  const ids = unique(elements.map((element) => element.id));
  const actionableIds = unique(elements.filter((element) => element.interactive).map((element) => element.id));
  const canPlan = actionableIds.length > 0;
  const oracleKinds = LLM_ORACLE_KINDS.filter((kind) => options.allowUrlOracles !== false || !URL_ORACLE_KINDS.has(kind));
  // Properties are generated in this order; "status" comes last so the model decides after writing the case.
  // With status first and values "case"/"done", qwen3.5:4b answered "done" (as in "finished writing") and then
  // wrote a full case anyway, hence the self-explaining values.
  return object({
    titleTh: { type: "string" },
    descriptionTh: { type: "string" },
    category: stringEnum([...CASE_CATEGORIES]),
    requirementIds: idArray(acIds),
    targetElementId: stringEnum(canPlan ? ids : [""]),
    inputVariant: { type: "string" },
    steps: {
      type: "array",
      items: object({
        kind: stringEnum(canPlan ? availableStepKinds(elements) : []),
        elementId: stringEnum(canPlan ? actionableIds : [""]),
        value: { type: "string" },
      }),
      maxItems: canPlan ? options.maxSteps ?? DEFAULT_MAX_EXPLORATORY_STEPS : 0,
    },
    oracle: object({
      kind: stringEnum(oracleKinds),
      elementId: stringEnum(["", ...ids]),
      text: { type: "string" },
    }),
    expectedResultTh: { type: "string" },
    status: stringEnum(canPlan ? [STATUS_NEW_CASE, STATUS_NO_MORE] : [STATUS_NO_MORE]),
  });
};

/** Elements the model can see in the compact prompt (hidden nav/footer excluded). */
export const promptElements = (inventory: ElementInventory): InventoryElement[] =>
  inventory.elements.filter((element) => !element.hiddenFromPrompt);

// ---------------------------------------------------------------------------------------------
// Response validation

const parseRaw = (raw: unknown): { value: unknown; issue?: string } => {
  if (typeof raw !== "string") return { value: raw };
  try {
    return { value: JSON.parse(raw) as unknown };
  } catch {
    return { value: undefined, issue: "response is not valid JSON" };
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const cleanText = (value: unknown, maxChars: number): string =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, maxChars) : "";

const knownIds = (value: unknown, allowed: ReadonlySet<string>, issues: string[], label: string): string[] => {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && allowed.has(item)) {
      if (!result.includes(item)) result.push(item);
    } else {
      issues.push(`${label}: unknown id ${JSON.stringify(item)} dropped`);
    }
  }
  return result;
};

export interface CandidateRef {
  id: string;
  mandatory: boolean;
}

export interface CandidateSelection {
  candidateId: string;
  keep: boolean;
  requirementIds: string[];
  /** "" = use the template title. */
  titleTh: string;
  /** "llm": answered by the model; "default": the model did not answer this candidate. */
  source: "llm" | "default";
  /** The model said keep=false but the candidate is mandatory. */
  forcedByMandatory?: boolean;
}

export interface SelectionResult {
  selections: CandidateSelection[];
  issues: string[];
}

/**
 * Validates a selection answer. Unknown candidate/AC IDs are dropped, the first answer per candidate wins,
 * unanswered candidates default to keep=mandatory, and mandatory candidates are always kept.
 * Result order follows `candidates`.
 */
export const parseSelectionResponse = (
  raw: unknown,
  candidates: readonly CandidateRef[],
  acIds: readonly string[],
): SelectionResult => {
  const issues: string[] = [];
  const parsed = parseRaw(raw);
  if (parsed.issue) issues.push(parsed.issue);
  const answers = isRecord(parsed.value) && Array.isArray(parsed.value.selections) ? parsed.value.selections : [];
  if (parsed.value !== undefined && !(isRecord(parsed.value) && Array.isArray(parsed.value.selections))) {
    issues.push("response has no selections array");
  }
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const allowedAcs = new Set(acIds);
  const answered = new Map<string, CandidateSelection>();

  for (const answer of answers) {
    if (!isRecord(answer) || typeof answer.candidateId !== "string" || !candidateById.has(answer.candidateId)) {
      issues.push(`unknown candidate ${JSON.stringify(isRecord(answer) ? answer.candidateId : answer)} dropped`);
      continue;
    }
    if (answered.has(answer.candidateId)) {
      issues.push(`duplicate answer for ${answer.candidateId} ignored`);
      continue;
    }
    const candidate = candidateById.get(answer.candidateId)!;
    const llmKeep = answer.keep === true;
    answered.set(answer.candidateId, {
      candidateId: answer.candidateId,
      keep: llmKeep || candidate.mandatory,
      requirementIds: knownIds(answer.requirementIds, allowedAcs, issues, answer.candidateId),
      titleTh: cleanText(answer.titleTh, MAX_TITLE_CHARS),
      source: "llm",
      ...(!llmKeep && candidate.mandatory ? { forcedByMandatory: true } : {}),
    });
  }

  const selections = candidates.map((candidate) => answered.get(candidate.id) ?? {
    candidateId: candidate.id,
    keep: candidate.mandatory,
    requirementIds: [],
    titleTh: "",
    source: "default" as const,
  });
  const missing = selections.filter((selection) => selection.source === "default").map((selection) => selection.candidateId);
  if (missing.length > 0) issues.push(`no answer for ${missing.join(", ")}`);
  return { selections, issues };
};

export interface PurposeResult {
  purposes: Map<string, ElementPurpose>;
  issues: string[];
}

/** Validates a purpose answer: unknown elements are dropped, disallowed purposes and missing answers become "unknown". */
export const parsePurposeResponse = (
  raw: unknown,
  elementIds: readonly string[],
  allowed: readonly ElementPurpose[],
): PurposeResult => {
  const issues: string[] = [];
  const parsed = parseRaw(raw);
  if (parsed.issue) issues.push(parsed.issue);
  const answers = isRecord(parsed.value) && Array.isArray(parsed.value.answers) ? parsed.value.answers : [];
  const wanted = new Set(elementIds);
  const allowedPurposes = new Set<string>(allowed);
  const purposes = new Map<string, ElementPurpose>();

  for (const answer of answers) {
    if (!isRecord(answer) || typeof answer.elementId !== "string" || !wanted.has(answer.elementId)) {
      issues.push(`unknown element ${JSON.stringify(isRecord(answer) ? answer.elementId : answer)} dropped`);
      continue;
    }
    if (purposes.has(answer.elementId)) continue;
    if (typeof answer.purpose === "string" && (allowedPurposes.has(answer.purpose) || answer.purpose === "unknown")) {
      purposes.set(answer.elementId, answer.purpose as ElementPurpose);
    } else {
      issues.push(`${answer.elementId}: purpose ${JSON.stringify(answer.purpose)} not allowed`);
      purposes.set(answer.elementId, "unknown");
    }
  }
  for (const id of elementIds) if (!purposes.has(id)) purposes.set(id, "unknown");
  return { purposes, issues };
};

export interface ExploratoryValidationContext {
  elements: readonly SchemaElement[];
  acIds: readonly string[];
  allowUrlOracles?: boolean;
  maxSteps?: number;
}

export type ExploratoryResult =
  | { status: "done"; issues: string[] }
  | { status: "case"; case: ExploratoryCase; issues: string[] }
  | { status: "invalid"; issues: string[] };

const INPUT_ROLES: ReadonlySet<string> = new Set(["textbox", "searchbox", "spinbutton", "slider", "combobox", "listbox"]);

const toStep = (
  value: unknown,
  elements: ReadonlyMap<string, SchemaElement>,
  index: number,
  issues: string[],
): StructuredStep | undefined => {
  if (!isRecord(value)) {
    issues.push(`step ${index + 1}: not an object`);
    return undefined;
  }
  const kind = value.kind;
  const elementId = typeof value.elementId === "string" ? value.elementId : "";
  const text = typeof value.value === "string" ? value.value : "";
  if (typeof kind !== "string" || !(LLM_STEP_KINDS as readonly string[]).includes(kind)) {
    issues.push(`step ${index + 1}: kind ${JSON.stringify(kind)} not allowed`);
    return undefined;
  }
  const element = elements.get(elementId);
  if (!element) {
    issues.push(`step ${index + 1}: element ${JSON.stringify(elementId)} is not on the page`);
    return undefined;
  }
  const stepKind = kind as LlmStepKind;
  if (!canAct(stepKind, element)) {
    issues.push(`step ${index + 1}: ${kind} cannot act on ${element.role} ${elementId}`);
    return undefined;
  }
  switch (stepKind) {
    case "fill":
      return { kind: "fill", elementId, value: text };
    case "selectOption":
      if (!text.trim()) {
        issues.push(`step ${index + 1}: selectOption needs an option label`);
        return undefined;
      }
      if (element.options && !element.options.includes(text.trim())) {
        issues.push(`step ${index + 1}: option ${JSON.stringify(text.trim())} is not in ${elementId}`);
        return undefined;
      }
      return { kind: "selectOption", elementId, optionLabel: text.trim() };
    case "pressKey":
      if (!text.trim()) {
        issues.push(`step ${index + 1}: pressKey needs a key`);
        return undefined;
      }
      return { kind: "press", elementId, key: text.trim() };
    case "click":
      return { kind: "click", elementId };
    case "tickCheckbox":
      return { kind: "check", elementId };
    case "untickCheckbox":
      return { kind: "uncheck", elementId };
  }
};

const toOracle = (
  value: unknown,
  elements: ReadonlyMap<string, SchemaElement>,
  allowUrlOracles: boolean,
  issues: string[],
): Oracle | undefined => {
  if (!isRecord(value) || typeof value.kind !== "string" || !(LLM_ORACLE_KINDS as readonly string[]).includes(value.kind)) {
    issues.push(`oracle kind ${JSON.stringify(isRecord(value) ? value.kind : value)} not allowed`);
    return undefined;
  }
  const kind = value.kind as LlmOracleKind;
  const elementId = typeof value.elementId === "string" ? value.elementId : "";
  const text = cleanText(value.text, MAX_TEXT_CHARS);
  if (URL_ORACLE_KINDS.has(kind) && !allowUrlOracles) {
    issues.push(`oracle ${kind} not allowed on a page without a stable URL`);
    return undefined;
  }
  const element = elements.get(elementId);
  if (ELEMENT_ORACLE_KINDS.has(kind) && !element) {
    issues.push(`oracle ${kind}: element ${JSON.stringify(elementId)} is not on the page`);
    return undefined;
  }
  if ((kind === "inputValueEquals" || kind === "validationMessageShown") && element && !INPUT_ROLES.has(element.role)) {
    issues.push(`oracle ${kind}: ${element.role} ${elementId} is not an input`);
    return undefined;
  }
  if ((kind === "elementDisabled" || kind === "elementEnabled") && element && !element.interactive) {
    issues.push(`oracle ${kind}: ${element.role} ${elementId} cannot be disabled`);
    return undefined;
  }
  // Amounts the model computed itself are the weak assertions of P4; templates compute them in code instead.
  if ((kind === "textVisible" || kind === "inputValueEquals") && MONEY_PATTERN.test(text)) {
    issues.push(`${MONEY_IN_ORACLE_ISSUE}: ${JSON.stringify(text)}`);
  }
  switch (kind) {
    case "textVisible":
      if (!text) break;
      return { kind, text };
    case "urlContains":
      if (!text) break;
      return { kind, fragment: text };
    case "inputValueEquals":
      return { kind, elementId, expected: text };
    case "elementVisible":
    case "elementHidden":
    case "elementDisabled":
    case "elementEnabled":
    case "validationMessageShown":
      return { kind, elementId };
    case "emptyStateShown":
    case "urlUnchanged":
      return { kind };
  }
  issues.push(`oracle ${kind} needs text`);
  return undefined;
};

/**
 * Validates an exploratory case. Any step or oracle that references an element outside the page, or a
 * missing title/step/oracle, makes the whole case invalid (quality gate 8a: no invented elements).
 * Unknown AC IDs are only dropped.
 */
export const parseExploratoryResponse = (raw: unknown, context: ExploratoryValidationContext): ExploratoryResult => {
  const issues: string[] = [];
  const parsed = parseRaw(raw);
  if (parsed.issue) return { status: "invalid", issues: [parsed.issue] };
  const value = parsed.value;
  if (!isRecord(value)) return { status: "invalid", issues: ["response is not an object"] };
  if (value.status === STATUS_NO_MORE) return { status: "done", issues };
  if (value.status !== STATUS_NEW_CASE) return { status: "invalid", issues: [`status ${JSON.stringify(value.status)} not allowed`] };

  const elements = new Map(context.elements.map((element) => [element.id, element]));
  const ids = new Set(elements.keys());
  const titleTh = cleanText(value.titleTh, MAX_TITLE_CHARS);
  if (!titleTh) issues.push("titleTh is empty");
  const targetElementId = typeof value.targetElementId === "string" ? value.targetElementId : "";
  if (!ids.has(targetElementId)) issues.push(`targetElementId ${JSON.stringify(targetElementId)} is not on the page`);

  const rawSteps = Array.isArray(value.steps) ? value.steps : [];
  const maxSteps = context.maxSteps ?? DEFAULT_MAX_EXPLORATORY_STEPS;
  if (rawSteps.length === 0) issues.push("no steps");
  if (rawSteps.length > maxSteps) issues.push(`too many steps (${rawSteps.length} > ${maxSteps})`);
  const steps = rawSteps.slice(0, maxSteps).map((step, index) => toStep(step, elements, index, issues));
  const oracle = toOracle(value.oracle, elements, context.allowUrlOracles !== false, issues);

  const requirementIds = knownIds(value.requirementIds, new Set(context.acIds), issues, "requirementIds");
  const category = typeof value.category === "string" && (CASE_CATEGORIES as readonly string[]).includes(value.category)
    ? value.category as CandidateCategory | "exploratory"
    : "exploratory";
  if (category !== value.category) issues.push(`category ${JSON.stringify(value.category)} replaced by exploratory`);

  const fatal = !titleTh || !ids.has(targetElementId) || steps.length === 0 || steps.some((step) => !step)
    || !oracle || rawSteps.length > maxSteps;
  if (fatal) return { status: "invalid", issues };
  const expectedResultTh = cleanText(value.expectedResultTh, MAX_TEXT_CHARS);
  if (MONEY_PATTERN.test(expectedResultTh)) issues.push(`${MONEY_IN_EXPECTED_ISSUE}: ${JSON.stringify(expectedResultTh)}`);

  return {
    status: "case",
    case: {
      titleTh,
      descriptionTh: cleanText(value.descriptionTh, MAX_TEXT_CHARS),
      // Same traceability rule as the legacy planner: no AC means exploratory.
      category: requirementIds.length === 0 ? "exploratory" : category === "exploratory" ? "happy_path" : category,
      requirementIds,
      targetElementId,
      inputVariant: cleanText(value.inputVariant, 80),
      steps: steps as StructuredStep[],
      oracle: oracle!,
      expectedResultTh,
    },
    issues,
  };
};
