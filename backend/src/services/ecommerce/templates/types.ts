/**
 * Phase 4b — template interface. A template is a rule in code: it decides which elements of a page it
 * applies to and builds complete candidate cases (steps, oracle, Thai title/expected result) from the
 * page's real values. Templates never contain a site's names, texts or prices.
 */
import type { CandidateCase, ElementInventory, InventoryElement, PageType } from "../types.js";

export interface TemplateContext {
  /** Inventory with element purposes (Phase 3). */
  inventory: ElementInventory;
  pageType: PageType;
  /** false: never place orders, pay, delete accounts or submit final confirmations. */
  allowMutatingTests: boolean;
  /** Precondition recipes the job can run (Phase 7), e.g. "seed_cart_one_item". */
  availablePreconditions: string[];
  /** Recipe that produced this snapshot's state (e.g. a cart with one item); every case starts with it. */
  statePreconditionId?: string;
  credentials: { hasLogin: boolean };
  /** The page needs a session (from page discovery's requiresLogin). */
  pageRequiresLogin?: boolean;
}

/** A candidate before IDs (C1, C2, ...) are assigned. */
export type CandidateDraft = Omit<CandidateCase, "id">;

export interface CaseTemplate {
  /** e.g. "num.zero", "cart.remove_item" (a family may build several variants). */
  id: string;
  /** For developers. */
  description: string;
  /** Elements the template applies to, or true/false for page-level templates. */
  appliesTo(context: TemplateContext): InventoryElement[] | boolean;
  build(context: TemplateContext, element?: InventoryElement): CandidateDraft[];
}
