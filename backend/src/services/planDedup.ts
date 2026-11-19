import type { TestPlan } from "../types.js";

/**
 * Job-wide registry of planned cases used to (a) show the planner what is already covered,
 * across every page/snapshot of a job, and (b) reject semantic duplicates that a pure
 * title comparison misses (e.g. "สลับธีมสีจากโหมดสว่างเป็นมืด" vs "เปลี่ยนโหมดสี (Dark/Light Mode)").
 */

type PlanLike = Pick<TestPlan, "title" | "description" | "testSteps" | "expectedResult"> &
  Partial<Pick<TestPlan, "targetElement" | "inputVariant" | "requirementIds">>;

interface RegisteredPlan {
  title: string;
  titleKey: string;
  targetElement: string;
  elementTokens: Set<string>;
  inputVariant: string;
  variantGrams: Set<string>;
  /** Signed numbers in the variant ("quantity=0" vs "quantity=-1" must never merge). */
  variantNumbers: string;
  contentGrams: Set<string>;
  contentNumbers: string;
}

/** Same target element: content must still overlap at least this much to count as a duplicate. */
export const SAME_ELEMENT_SIMILARITY = 0.35;
/**
 * No usable target element on one side: fall back to near-verbatim content only. Calibrated on job
 * p8mpszLBuRvSUYfOH5vn: distinct navigation cases (Discord vs GitHub link) already score ~0.85 while the
 * real duplicate pair (#16 vs #42) scored only ~0.44, so content alone cannot separate them.
 */
export const CONTENT_ONLY_SIMILARITY = 0.95;
/** Two non-empty input variants below this similarity are different partitions, never duplicates. */
export const VARIANT_SIMILARITY = 0.5;

const ELEMENT_NOISE_WORDS = new Set([
  "button", "link", "menu", "item", "icon", "toggle", "tab", "field", "input", "the", "a", "an",
  "ปุ่ม", "ลิงก์", "ลิงค์", "เมนู", "ไอคอน", "ช่อง",
]);

export const normalizePlanTitle = (title: string): string =>
  title.trim().toLocaleLowerCase().replace(/\s+/g, " ");

const normalizeText = (value: string): string => value
  .toLocaleLowerCase()
  .replace(/https?:\/\/\S+/g, " ")
  .replace(/\bref=\S+/g, " ")
  .replace(/^\s*\d+[.)]\s*/gm, " ")
  .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
  .replace(/\s+/g, " ")
  .trim();

const trigrams = (value: string): Set<string> => {
  const text = normalizeText(value);
  const grams = new Set<string>();
  if (!text) return grams;
  const padded = ` ${text} `;
  for (let index = 0; index + 3 <= padded.length; index += 1) grams.add(padded.slice(index, index + 3));
  return grams;
};

/** Sørensen–Dice coefficient over character trigrams; works for Thai, which has no word spaces. */
export const diceSimilarity = (left: Set<string>, right: Set<string>): number => {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return (2 * shared) / (left.size + right.size);
};

export const textSimilarity = (left: string, right: string): number => diceSimilarity(trigrams(left), trigrams(right));

const elementTokens = (element: string): Set<string> => new Set(
  normalizeText(element.replace(/\((?:currently|ปัจจุบัน)[^)]*\)/gi, " "))
    .split(" ")
    .filter((token) => token && !ELEMENT_NOISE_WORDS.has(token)),
);

/** Same element when one label's tokens are a subset of the other's ("Python" vs "Python docs"), never "Java" vs "JavaScript". */
const sameElement = (left: Set<string>, right: Set<string>): boolean => {
  if (left.size === 0 || right.size === 0) return false;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  for (const token of small) if (!large.has(token)) return false;
  return true;
};

/** Distinct signed numbers, ignoring URLs, snapshot refs and step numbering ("1. ..."). */
const numbersOf = (value: string): string => [...new Set(
  value
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\bref=\S+/g, " ")
    .replace(/^\s*\d+[.)]\s*/gm, " ")
    .match(/[-+]?\d+(?:\.\d+)?/g) ?? [],
)].sort().join(",");

const contentOf = (plan: PlanLike): string =>
  [plan.title, plan.description, ...(plan.testSteps ?? []), plan.expectedResult].join("\n");

const register = (plan: PlanLike): RegisteredPlan => {
  const targetElement = (plan.targetElement ?? "").trim();
  const inputVariant = (plan.inputVariant ?? "").trim();
  return {
    title: plan.title,
    titleKey: normalizePlanTitle(plan.title),
    targetElement,
    elementTokens: elementTokens(targetElement),
    inputVariant,
    variantGrams: trigrams(inputVariant),
    variantNumbers: numbersOf(inputVariant),
    contentGrams: trigrams(contentOf(plan)),
    contentNumbers: numbersOf(contentOf(plan)),
  };
};

const isDuplicateOf = (candidate: RegisteredPlan, existing: RegisteredPlan): boolean => {
  if (candidate.titleKey === existing.titleKey) return true;

  // Different equivalence partitions / boundary values / start states on the same element are distinct cases.
  if (candidate.variantGrams.size > 0 && existing.variantGrams.size > 0) {
    if (candidate.variantNumbers !== existing.variantNumbers) return false;
    if (diceSimilarity(candidate.variantGrams, existing.variantGrams) < VARIANT_SIMILARITY) return false;
  }

  const contentSimilarity = diceSimilarity(candidate.contentGrams, existing.contentGrams);
  const bothHaveElements = candidate.elementTokens.size > 0 && existing.elementTokens.size > 0;
  if (bothHaveElements) {
    return sameElement(candidate.elementTokens, existing.elementTokens) && contentSimilarity >= SAME_ELEMENT_SIMILARITY;
  }
  // Near-verbatim text that differs only in numbers is a different boundary value, not a duplicate.
  return candidate.contentNumbers === existing.contentNumbers && contentSimilarity >= CONTENT_ONLY_SIMILARITY;
};

export class PlanCoverageRegistry {
  private readonly plans: RegisteredPlan[] = [];

  get size(): number {
    return this.plans.length;
  }

  /**
   * Returns the title of an already-registered case that the candidate duplicates, if any.
   * `titleOnly` limits the check to identical titles (used when the candidate verifies a not-yet-covered AC).
   */
  findDuplicate(plan: PlanLike, options: { titleOnly?: boolean } = {}): string | undefined {
    const candidate = register(plan);
    if (!candidate.titleKey) return "(empty title)";
    const match = this.plans.find((existing) => options.titleOnly
      ? existing.titleKey === candidate.titleKey
      : isDuplicateOf(candidate, existing));
    if (!match) return undefined;
    // Keep the case the planner keeps repeating at the most-recent end of the prompt window.
    this.plans.splice(this.plans.indexOf(match), 1);
    this.plans.push(match);
    return match.title;
  }

  add(plan: PlanLike): void {
    this.plans.push(register(plan));
  }

  /** Covered cases, oldest first (a repeatedly re-proposed case is moved to the end). */
  coveredCases(): CoveredCase[] {
    return this.plans.map(({ title, targetElement, inputVariant }) => ({ title, targetElement, inputVariant }));
  }
}

export type CoveredCase = Pick<TestPlan, "title"> & Partial<Pick<TestPlan, "description" | "targetElement" | "inputVariant">>;

const MAX_COVERED_TITLE_CHARS = 120;

/** Compact single line for the planner's [Already Covered Cases] block: title plus its dedup key. */
export const formatCoveredCase = (item: CoveredCase): string => {
  const title = item.title.length > MAX_COVERED_TITLE_CHARS
    ? `${item.title.slice(0, MAX_COVERED_TITLE_CHARS - 1)}…`
    : item.title;
  const key = [item.targetElement?.trim(), item.inputVariant?.trim()].filter(Boolean).join(" | ");
  return key ? `- ${title} [${key}]` : `- ${title}`;
};
