/**
 * Template registry and candidate generator (Phase 4b/4c): runs every template that applies to a page and
 * numbers the resulting candidates C1, C2, ... Page-level rules shared by all templates live here.
 */
import { LOGIN_TERMS } from "./helpers.js";
import { matchesAnyTerm } from "../keywords.js";
import type { CandidateCase } from "../types.js";
import { ELEMENT_TEMPLATES } from "./elementTemplates.js";
import { SHOP_TEMPLATES } from "./shopTemplates.js";
import type { CandidateDraft, CaseTemplate, TemplateContext } from "./types.js";

export type { CaseTemplate, CandidateDraft, TemplateContext } from "./types.js";

export const TEMPLATES: CaseTemplate[] = [...SHOP_TEMPLATES, ...ELEMENT_TEMPLATES];

export interface CandidateGeneration {
  candidates: CandidateCase[];
  /** Why the page produced fewer cases than its elements suggest (for logs and reports). */
  notes: string[];
}

/** A page captured without a session shows a login entry in its navigation. */
export const isGuestSnapshot = (context: TemplateContext): boolean =>
  context.inventory.elements.some((element) => element.interactive && (element.role === "link" || element.role === "button")
    && (element.region === "nav" || element.region === "header") && matchesAnyTerm(element.name, LOGIN_TERMS));

/** States reachable only through a precondition (a filled cart, a checkout form). */
const needsStatePrecondition = (context: TemplateContext): boolean =>
  context.pageType === "checkout"
  || (context.pageType === "cart" && context.inventory.elements.some((element) => element.purpose === "remove_from_cart" || (element.purpose === "quantity" && element.role === "button")));

export const generateCandidates = (context: TemplateContext): CandidateGeneration => {
  const notes: string[] = [];
  if (needsStatePrecondition(context) && !context.statePreconditionId) {
    notes.push(`${context.pageType} state needs a precondition recipe (Phase 7); no candidates`);
    return { candidates: [], notes };
  }
  const guest = isGuestSnapshot(context);
  const drafts: CandidateDraft[] = [];
  for (const template of TEMPLATES) {
    const applies = template.appliesTo(context);
    if (applies === false || (Array.isArray(applies) && applies.length === 0)) continue;
    try {
      const built = Array.isArray(applies)
        ? applies.flatMap((element) => template.build(context, element))
        : template.build(context);
      drafts.push(...built);
    } catch (error) {
      notes.push(`template ${template.id} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const seen = new Set<string>();
  const candidates: CandidateCase[] = [];
  for (const draft of drafts) {
    const key = `${draft.templateId}|${draft.targetElementId}|${draft.inputVariant}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      ...draft,
      id: `C${candidates.length + 1}`,
      ...(context.statePreconditionId && !draft.preconditionId ? { preconditionId: context.statePreconditionId } : {}),
      // A guest snapshot must be tested as a guest, even when the runner would log in first.
      ...(guest ? { loggedOut: true } : {}),
    });
  }
  return { candidates, notes };
};
