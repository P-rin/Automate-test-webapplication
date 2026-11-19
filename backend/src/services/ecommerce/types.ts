/**
 * Shared types of the GENERATION_MODE=ecommerce pipeline (ECOMMERCE_TESTGEN_CONTEXT.md §5).
 * Additions to the document's proposal are marked "(added)".
 */

export type PageType =
  | "listing" | "product_detail" | "cart" | "checkout"
  | "login" | "search_results" | "order_confirmation" | "other";

export type ElementPurpose =
  | "search" | "quantity" | "coupon" | "review_comment" | "email" | "password"
  | "name" | "phone" | "address" | "postal_code" | "card_number"
  | "sort" | "filter" | "add_to_cart" | "remove_from_cart" | "checkout_button"
  | "cart_badge" | "price" | "subtotal" | "total" | "product_name" | "stock_status"
  | "generic_text" | "generic_button" | "unknown";

export type Region = "header" | "nav" | "main" | "footer" | "dialog" | "unknown";

/** One element kept after compacting a snapshot. */
export interface InventoryElement {
  /** "E1", "E2", ... in document order; stable within one snapshot. */
  id: string;
  /** Snapshot role (button, textbox, combobox, link, heading, ...); plain text nodes are normalized to "text". */
  role: string;
  /** Accessible name as shown in the snapshot ("" when the snapshot shows none). For label/value text pairs, the label. */
  name: string;
  interactive: boolean;
  region: Region;
  /** Repeated container (product card, cart row) this element belongs to: G1, G2, ... */
  groupId?: string;
  groupLabel?: string;
  /** Nearest heading above the element. */
  sectionHeading?: string;
  attrs?: {
    tag?: string; type?: string; placeholder?: string; required?: boolean;
    min?: string; max?: string; maxLength?: number; pattern?: string;
    disabled?: boolean; testId?: string; formRole?: string;
    /** (added) snapshot state flags */
    checked?: boolean; selected?: boolean; level?: number;
  };
  /** Combobox/listbox options. */
  options?: string[];
  /** Visible text: own inline text, merged child text of a control, or a text pair's value. Shortened to ~60 chars. */
  text?: string;
  /** (added) the text was shortened for the prompt. */
  textTruncated?: boolean;
  /** (added) current value of a textbox/spinbutton/combobox. */
  value?: string;
  /** (added) link target from the snapshot's /url. */
  href?: string;
  purpose?: ElementPurpose;
  purposeConfidence?: number;
  /** 1-based line in the full snapshot, to find the element again for locators. */
  sourceLine: number;
  /** (added) kept in the inventory but not rendered for the LLM (e.g. nav already sent on an earlier page). */
  hiddenFromPrompt?: "seen_on_previous_page";
}

export interface InventoryGroup {
  id: string;
  label: string;
  /** Number of containers in the repeated set this group belongs to. */
  count: number;
  /** Locator hint for the repeated container: a data-test selector from "### Test IDs" or a role such as "article". */
  containerHint?: string;
  /** (added) groups of the same repeated set share a setId (S1, S2, ...). */
  setId: string;
  /** (added) 1-based position inside its repeated set. */
  index: number;
}

export interface ElementInventory {
  pageUrl: string;
  pageTitle: string;
  pageType?: PageType;
  /** e.g. "cart_with_1_item" for a precondition snapshot. */
  stateLabel?: string;
  /**
   * (added, REACT_CART_WEB_PROFILE.md §6.1) steps that reach this page/state from a fresh browser.
   * Defaults to [goto pageUrl]; SPA states that keep the URL need extra clicks filled in by discovery.
   */
  navigationPath: StructuredStep[];
  /** (added) false when the page/state cannot be told apart by URL, so URL oracles must not be used. */
  urlIsStable: boolean;
  elements: InventoryElement[];
  groups: InventoryGroup[];
  /** e.g. { label: "article", omittedCount: 17 } — containers not turned into elements. */
  omittedRepeatedGroups: { label: string; omittedCount: number; setId: string }[];
}

/** Structured step: compiled to Playwright by code (Phase 6). */
export type StructuredStep =
  | { kind: "goto"; url: string }
  | { kind: "fill"; elementId: string; value: string }
  | { kind: "click"; elementId: string }
  | { kind: "selectOption"; elementId: string; optionLabel: string }
  | { kind: "check" | "uncheck"; elementId: string }
  | { kind: "press"; elementId: string; key: string }
  | { kind: "reload" }
  | { kind: "precondition"; recipeId: string };

export type Oracle =
  | { kind: "textVisible"; text: string }
  | { kind: "elementVisible"; elementId: string }
  | { kind: "elementHidden"; elementId: string }
  | { kind: "elementDisabled" | "elementEnabled"; elementId: string }
  | { kind: "urlContains"; fragment: string }
  | { kind: "urlUnchanged" }
  | { kind: "countEquals"; groupId: string; expected: number }
  | { kind: "countChangedBy"; elementId: string; delta: number }
  | { kind: "inputValueEquals"; elementId: string; expected: string }
  | { kind: "validationMessageShown"; elementId: string }
  | { kind: "sortedBy"; groupId: string; field: "price" | "name"; direction: "asc" | "desc" }
  | { kind: "allItemsContain"; groupId: string; text: string }
  | { kind: "emptyStateShown" }
  | { kind: "lineTotalEquals"; priceElementId: string; qtyElementId: string; lineTotalElementId: string }
  | { kind: "subtotalEqualsSumOfLines"; groupId: string; subtotalElementId: string }
  | { kind: "persistsAfterReload"; inner: Oracle };
