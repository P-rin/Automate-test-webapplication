/**
 * Phase 4d — the LLM's remaining job on a page: keep or drop each code-built candidate, map it to the
 * acceptance criteria, and polish its Thai title. It answers in at most MAX_CANDIDATES_PER_CALL candidates per
 * call with an enum schema of the batch's candidate IDs and the AC IDs (Phase 2). Mandatory candidates are
 * always kept; a failed call falls back to "mandatory + one happy path per template" with keyword AC matching,
 * so the job never fails because of the model.
 */
import type { AcceptanceCriterion } from "../../types.js";
import { renderCriteriaForPrompt } from "../ollamaService.js";
import { buildSelectionSchema, parseSelectionResponse, type CandidateSelection } from "./dynamicSchemas.js";
import { elementLabel } from "./templates/helpers.js";
import type { CandidateCase, ElementInventory } from "./types.js";

export const MAX_CANDIDATES_PER_CALL = 8;

export type AskJson = (prompt: string, schema: object) => Promise<string>;

export interface SelectionInput {
  candidates: CandidateCase[];
  inventory: ElementInventory;
  acceptanceCriteria: AcceptanceCriterion[];
  coveredAcIds: ReadonlySet<string>;
  /** Compact page text (Phase 1); included when it fits the budget. */
  pageText?: string;
  maxPromptChars?: number;
}

export interface SelectionStats {
  calls: number;
  failedCalls: number;
  /** Candidates decided by the fallback because their call failed. */
  fallbackCandidates: number;
  /** Mandatory candidates the model wanted to drop. */
  forcedByMandatory: number;
  issues: string[];
}

export interface SelectionOutcome {
  selections: CandidateSelection[];
  stats: SelectionStats;
}

/** One short line per candidate, e.g. `C3 [boundary, mandatory] ใส่ 0 ในช่องจำนวน → ระบบไม่ยอมรับ...`. */
export const renderCandidateLine = (candidate: CandidateCase): string =>
  `${candidate.id} [${candidate.category}${candidate.mandatory ? ", mandatory" : ""}] ${candidate.titleTh} → ${candidate.expectedResultTh}`;

/** Batches of at most `size`, keeping candidates of the same element together where possible. */
export const batchCandidates = (candidates: CandidateCase[], size = MAX_CANDIDATES_PER_CALL): CandidateCase[][] => {
  const byElement = new Map<string, CandidateCase[]>();
  for (const candidate of candidates) byElement.set(candidate.targetElementId, [...(byElement.get(candidate.targetElementId) ?? []), candidate]);
  const batches: CandidateCase[][] = [];
  let current: CandidateCase[] = [];
  for (const group of byElement.values()) {
    for (const candidate of group) {
      if (current.length >= size) {
        batches.push(current);
        current = [];
      }
      current.push(candidate);
    }
    // Start a new batch at an element boundary when the next element's cases would not fit together.
    if (current.length > 0 && current.length + 1 > size) {
      batches.push(current);
      current = [];
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
};

const words = (value: string): string[] =>
  value.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 4);

/** Keyword match between an AC and a candidate (used only when the model is unavailable). */
export const keywordRequirementIds = (candidate: CandidateCase, inventory: ElementInventory, criteria: AcceptanceCriterion[]): string[] => {
  const target = inventory.elements.find((element) => element.id === candidate.targetElementId);
  const label = target ? elementLabel(target).toLocaleLowerCase() : "";
  const candidateWords = new Set(words(`${candidate.titleTh} ${label}`));
  return criteria.filter((criterion) => {
    const acText = `${criterion.scenario} ${criterion.action} ${criterion.expected}`.toLocaleLowerCase();
    if (label.length >= 3 && acText.includes(label)) return true;
    return words(acText).filter((word) => candidateWords.has(word)).length >= 2;
  }).map((criterion) => criterion.id);
};

/** Fallback decision: every mandatory case, plus the first happy path of each template. */
export const fallbackSelections = (candidates: CandidateCase[], inventory: ElementInventory, criteria: AcceptanceCriterion[]): CandidateSelection[] => {
  const templatesWithHappyPath = new Set<string>();
  return candidates.map((candidate) => {
    let keep = candidate.mandatory;
    if (candidate.category === "happy_path" && !templatesWithHappyPath.has(candidate.templateId)) {
      templatesWithHappyPath.add(candidate.templateId);
      keep = true;
    }
    return {
      candidateId: candidate.id,
      keep,
      requirementIds: keywordRequirementIds(candidate, inventory, criteria),
      titleTh: "",
      source: "default" as const,
    };
  });
};

export const buildSelectionPrompt = (batch: CandidateCase[], input: SelectionInput): string => {
  const maxPromptChars = input.maxPromptChars ?? 6000;
  const candidateBlock = batch.map(renderCandidateLine).join("\n");
  const instructions = [
    "คุณช่วยคัดเลือก test case ที่ระบบสร้างไว้แล้ว ห้ามสร้าง case ใหม่",
    "สำหรับแต่ละ candidate: keep=true ถ้ามีประโยชน์กับหน้านี้, requirementIds = AC ที่ case นี้ตรวจได้ (ไม่มีให้ใส่ []), titleTh = ชื่อภาษาไทยสั้นและชัด (ว่างได้ถ้าชื่อเดิมดีแล้ว)",
    "case ที่มีคำว่า mandatory ระบบจะเก็บเสมอ ให้ใส่ requirementIds ให้ถูกต้อง",
    "ตอบเป็น JSON ตาม schema เท่านั้น ตอบครบทุก candidate",
  ].join("\n");
  const criteria = input.acceptanceCriteria.length
    ? renderCriteriaForPrompt(input.acceptanceCriteria, input.coveredAcIds, Math.floor(maxPromptChars * 0.35))
    : "ไม่มี AC";
  const fixed = [instructions, "[AC]", criteria, "[Candidates]", candidateBlock].join("\n");
  const pageBudget = maxPromptChars - fixed.length - 20;
  const page = input.pageText && input.pageText.length <= pageBudget ? ["[หน้าเว็บ]", input.pageText] : [];
  return [instructions, "[AC]", criteria, ...page, "[Candidates]", candidateBlock].join("\n");
};

export const selectCandidates = async (input: SelectionInput, ask: AskJson): Promise<SelectionOutcome> => {
  const stats: SelectionStats = { calls: 0, failedCalls: 0, fallbackCandidates: 0, forcedByMandatory: 0, issues: [] };
  const acIds = input.acceptanceCriteria.map((criterion) => criterion.id);
  const selections: CandidateSelection[] = [];

  for (const batch of batchCandidates(input.candidates)) {
    stats.calls += 1;
    const refs = batch.map((candidate) => ({ id: candidate.id, mandatory: candidate.mandatory }));
    try {
      const raw = await ask(buildSelectionPrompt(batch, input), buildSelectionSchema(batch.map((candidate) => candidate.id), acIds));
      const result = parseSelectionResponse(raw, refs, acIds);
      stats.issues.push(...result.issues);
      // Candidates the model skipped keep only the mandatory default; give them keyword AC links like the fallback.
      const fallback = new Map(fallbackSelections(batch, input.inventory, input.acceptanceCriteria).map((selection) => [selection.candidateId, selection]));
      for (const selection of result.selections) {
        if (selection.forcedByMandatory) stats.forcedByMandatory += 1;
        selections.push(selection.source === "default"
          ? { ...selection, requirementIds: fallback.get(selection.candidateId)?.requirementIds ?? [] }
          : selection);
      }
    } catch (error) {
      stats.failedCalls += 1;
      stats.fallbackCandidates += batch.length;
      stats.issues.push(`selection call failed: ${error instanceof Error ? error.message : String(error)}`);
      selections.push(...fallbackSelections(batch, input.inventory, input.acceptanceCriteria));
    }
  }
  return { selections, stats };
};
