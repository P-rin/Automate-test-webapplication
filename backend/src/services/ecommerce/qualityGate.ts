/**
 * Phase 8a — rule-based quality gate, before anything runs. A case is dropped when it cannot tell a working
 * site from a broken one, or when running it would be unsafe:
 *  - no oracle;
 *  - an expected result that only says "works correctly" while the oracle checks nothing more than the URL;
 *  - a negative/validation case whose only check is the URL (a rejected input usually keeps the URL, so
 *    the check passes whether the site validates or not);
 *  - steps/oracle that refer to elements not in the page's inventory;
 *  - a click on an order confirmation/payment button when the job does not allow mutating tests.
 * Duplicates are handled before the gate (template keys and PlanCoverageRegistry in pipeline.ts).
 */
import { matchesAnyTerm } from "./keywords.js";
import { referencedElementIds } from "./scriptCompiler.js";
import { isFinalOrderButton } from "./templates/helpers.js";
import type { ElementInventory, Oracle, StructuredStep } from "./types.js";

export const VAGUE_EXPECTED_TERMS = [
  "works correctly", "work correctly", "properly", "as expected", "successfully", "correctly",
  "ถูกต้อง", "ปกติ", "สำเร็จ", "เรียบร้อย", "ตามที่คาดไว้", "ได้ตามปกติ",
];

const URL_ONLY = new Set<Oracle["kind"]>(["urlContains", "urlUnchanged"]);
const NEGATIVE_CATEGORIES = new Set(["negative", "validation"]);

export type QualityIssue =
  | "no_oracle"
  | "vague_expected_url_only"
  | "negative_checks_url_only"
  | "unknown_element"
  | "would_place_order";

export interface QualityGateInput {
  category: string;
  expectedResult: string;
  steps: StructuredStep[];
  oracle?: Oracle;
  inventory: ElementInventory;
  allowMutatingTests: boolean;
}

export interface QualityGateResult {
  accepted: boolean;
  issues: QualityIssue[];
}

/** The oracle kind that decides the verdict (persistsAfterReload is judged by its inner check). */
const effectiveKind = (oracle: Oracle): Oracle["kind"] => (oracle.kind === "persistsAfterReload" ? effectiveKind(oracle.inner) : oracle.kind);

export const checkCaseQuality = (input: QualityGateInput): QualityGateResult => {
  const issues: QualityIssue[] = [];
  if (!input.oracle || typeof input.oracle.kind !== "string") {
    return { accepted: false, issues: ["no_oracle"] };
  }
  const kind = effectiveKind(input.oracle);
  if (URL_ONLY.has(kind) && matchesAnyTerm(input.expectedResult, VAGUE_EXPECTED_TERMS)) issues.push("vague_expected_url_only");
  if (URL_ONLY.has(kind) && NEGATIVE_CATEGORIES.has(input.category)) issues.push("negative_checks_url_only");

  const known = new Set(input.inventory.elements.map((element) => element.id));
  const ids = referencedElementIds({ steps: input.steps, oracle: input.oracle });
  if (ids.some((id) => !known.has(id))) issues.push("unknown_element");

  if (!input.allowMutatingTests) {
    const clicked = input.steps.flatMap((step) => (step.kind === "click" ? [step.elementId] : []));
    // A cart's "go to checkout" control only opens the checkout page; on other pages these words place orders.
    const elements = input.inventory.elements.filter((element) => clicked.includes(element.id)
      && !(input.inventory.pageType === "cart" && element.purpose === "checkout_button"));
    if (elements.some(isFinalOrderButton)) issues.push("would_place_order");
  }
  return { accepted: issues.length === 0, issues };
};
