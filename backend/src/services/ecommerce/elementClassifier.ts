/**
 * Phase 3b/3c — Element Purpose Classifier.
 *
 * Scores each inventory element for every purpose from code-only clues (role, input type, tag, keywords in
 * name/label/placeholder/HTML name/autocomplete/options, nearby buttons, position, page type). A clear winner
 * (score >= 4 and >= 2 ahead) is decided by rules. Elements with some evidence but no clear winner can be sent
 * to the LLM as a multiple-choice question (resolveAmbiguousPurposes); anything still unclear falls back to a
 * generic purpose, which yields fewer test cases but never a case of the wrong kind.
 */
import {
  APPLY_COUPON_TERMS,
  CART_COUNT_TERMS,
  FEE_TERMS,
  matchesAnyTerm,
  MONEY_PATTERN,
  NOTE_TERMS,
  ORDER_TERMS,
  PURPOSE_TERMS,
  REVIEW_SECTION_TERMS,
  SEARCH_BUTTON_TERMS,
  STEPPER_TERMS,
  SUBMIT_REVIEW_TERMS,
  WISHLIST_TERMS,
} from "./keywords.js";
import { buildPurposeSchema, parsePurposeResponse } from "./dynamicSchemas.js";
import type { ElementInventory, ElementPurpose, InventoryElement, PageType } from "./types.js";

export const DECIDE_MIN_SCORE = 4;
export const DECIDE_MIN_LEAD = 2;
/** Below this there is no real evidence: generic purpose without asking the LLM. */
export const ASK_MIN_SCORE = 2;
export const MAX_LLM_BATCH = 5;

export type PurposeScores = Partial<Record<ElementPurpose, number>>;

export interface PurposeDecision {
  elementId: string;
  /** Decided purpose; for "ambiguous" the generic fallback until resolved. */
  purpose: ElementPurpose;
  confidence: number;
  status: "rule" | "no_evidence" | "ambiguous" | "llm" | "llm_fallback";
  /** For "ambiguous": purposes worth offering the LLM (score >= ASK_MIN_SCORE), best first. */
  candidates: ElementPurpose[];
  scores: PurposeScores;
}

export interface ClassifyContext {
  inventory: ElementInventory;
  pageType?: PageType;
}

const INPUT_ROLES = new Set(["textbox", "searchbox", "spinbutton", "combobox", "listbox"]);
const BUTTON_ROLES = new Set(["button", "link", "menuitem"]);
const CHECKOUT_FIELD_PURPOSES: ElementPurpose[] = ["name", "phone", "address", "postal_code", "email", "card_number"];
const AUTOCOMPLETE_PURPOSES: Array<[RegExp, ElementPurpose]> = [
  [/^email$/, "email"],
  [/password/, "password"],
  [/^tel/, "phone"],
  [/postal-code/, "postal_code"],
  [/^cc-number/, "card_number"],
  [/(^|-)name$|given-name|family-name|username/, "name"],
  [/address|country|locality|region/, "address"],
];

/** "firstName" / "first_name" / "first-name" -> "first name". */
const splitIdentifier = (value: string): string => value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");

/** Independent places a field names its purpose; identical strings count once. */
const fieldSources = (element: InventoryElement): string[] => [...new Set([
  element.name,
  element.attrs?.placeholder,
  element.attrs?.htmlName ? splitIdentifier(element.attrs.htmlName) : undefined,
  element.attrs?.autocomplete ? splitIdentifier(element.attrs.autocomplete) : undefined,
].filter((value): value is string => Boolean(value?.trim())).map((value) => value.trim()))];

const fieldText = (element: InventoryElement): string => fieldSources(element).join(" | ");

const fullText = (element: InventoryElement): string => [element.name, element.text].filter(Boolean).join(" ");

const isGenericFallback = (element: InventoryElement): ElementPurpose =>
  element.interactive && !INPUT_ROLES.has(element.role) ? "generic_button" : "generic_text";

/** Buttons in the same card/row, or (outside cards) under the same heading in the same region. */
const nearbyElements = (element: InventoryElement, inventory: ElementInventory): InventoryElement[] =>
  inventory.elements.filter((other) => other.id !== element.id && other.role === "button" && (
    element.groupId
      ? other.groupId === element.groupId
      : !other.groupId && Boolean(element.sectionHeading) && other.sectionHeading === element.sectionHeading && other.region === element.region
  ));

/** Labels of buttons that act on this element: same form (DOM) plus nearbyElements. */
const nearbyButtons = (element: InventoryElement, inventory: ElementInventory): string[] =>
  [...new Set([...(element.attrs?.formButtons ?? []), ...nearbyElements(element, inventory).map((other) => other.name)].filter(Boolean))];

const nearbyButtonText = (element: InventoryElement, inventory: ElementInventory): string =>
  nearbyButtons(element, inventory).join(" | ");

const isAddToCartLabel = (label: string): boolean =>
  matchesAnyTerm(label, PURPOSE_TERMS.add_to_cart) && !matchesAnyTerm(label, ORDER_TERMS) && !matchesAnyTerm(label, WISHLIST_TERMS);

/** An add-to-cart button, including its disabled "sold out" form. */
const isBuyButton = (element: InventoryElement): boolean =>
  element.role === "button" && (isAddToCartLabel(element.name)
    || (Boolean(element.attrs?.disabled) && matchesAnyTerm(element.name, PURPOSE_TERMS.stock_status)));

/** A page that lists priced products in repeated cards. */
const hasPricedRepeatedGroups = (inventory: ElementInventory): boolean =>
  inventory.groups.some((group) => group.count >= 2) && inventory.elements.some((element) =>
    Boolean(element.groupId) && MONEY_PATTERN.test(fullText(element)));

const groupHasMoney = (element: InventoryElement, inventory: ElementInventory): boolean =>
  Boolean(element.groupId) && inventory.elements.some((other) =>
    other.groupId === element.groupId && MONEY_PATTERN.test(fullText(other)));

/** Raw scores for one element; exported for tests and for explaining decisions. */
export const scoreElement = (element: InventoryElement, context: ClassifyContext): PurposeScores => {
  const scores: PurposeScores = {};
  const add = (purpose: ElementPurpose, points: number) => {
    scores[purpose] = (scores[purpose] ?? 0) + points;
  };
  const { inventory, pageType } = context;
  const type = element.attrs?.type ?? "";
  const text = fieldText(element);
  const inCartOrProduct = pageType === "cart" || pageType === "product_detail" || groupHasMoney(element, inventory)
    || inventory.elements.some(isBuyButton);

  if (INPUT_ROLES.has(element.role)) {
    // Role / type / tag
    if (element.role === "searchbox" || type === "search") add("search", 3);
    if (element.role === "spinbutton" || type === "number") add("quantity", inCartOrProduct ? 3 : 2);
    if (type === "email") add("email", 3);
    if (type === "password") add("password", 3);
    if (type === "tel") add("phone", 3);
    if (element.attrs?.tag === "textarea") add("review_comment", 2);
    const autocomplete = element.attrs?.autocomplete ?? "";
    for (const [pattern, purpose] of AUTOCOMPLETE_PURPOSES) if (pattern.test(autocomplete)) add(purpose, 3);

    // Keywords in name / label / placeholder / HTML name / autocomplete: +2, +1 when the accessible name
    // (the label a user reads) says it, +1 when a second independent source agrees.
    const sources = fieldSources(element);
    const searchWord = matchesAnyTerm(text, PURPOSE_TERMS.search);
    for (const purpose of ["search", "quantity", "coupon", "review_comment", "email", "password", "name", "phone", "address", "postal_code", "card_number"] as const) {
      // "Search products by name" is a search box, not a name field.
      if (purpose === "name" && searchWord) continue;
      // "Email address" / "Zip code" are not street addresses.
      if (purpose === "address" && (matchesAnyTerm(text, PURPOSE_TERMS.email) || matchesAnyTerm(text, PURPOSE_TERMS.postal_code))) continue;
      const agreeing = sources.filter((source) => matchesAnyTerm(source, PURPOSE_TERMS[purpose]));
      if (agreeing.length === 0) continue;
      add(purpose, 2);
      if (element.name && matchesAnyTerm(element.name, PURPOSE_TERMS[purpose])) add(purpose, 1);
      if (agreeing.length >= 2) add(purpose, 1);
    }
    // A required form field is a data-entry field, which supports the purpose its label names.
    if (element.attrs?.required) {
      for (const purpose of CHECKOUT_FIELD_PURPOSES) if (scores[purpose]) add(purpose, 1);
    }

    // Nearby buttons
    const nearby = nearbyButtonText(element, inventory);
    if (matchesAnyTerm(nearby, SEARCH_BUTTON_TERMS)) add("search", 2);
    if (matchesAnyTerm(nearby, APPLY_COUPON_TERMS)) add("coupon", 2);
    if (matchesAnyTerm(nearby, SUBMIT_REVIEW_TERMS)) add("review_comment", 2);
    if ((element.role === "spinbutton" || type === "number") && nearbyElements(element, inventory).some(isBuyButton)) add("quantity", 1);

    // The only free-text field on a page of priced product cards is almost always the search box; a sole field
    // that says "search" is one too (e.g. the same page showing "no results").
    const textFields = inventory.elements.filter((other) => ["textbox", "searchbox"].includes(other.role) && other.region === element.region);
    const soleTextField = (element.role === "textbox" || element.role === "searchbox") && textFields.length === 1 && element.attrs?.tag !== "textarea";
    if (soleTextField && hasPricedRepeatedGroups(inventory)) add("search", 2);
    if (soleTextField && searchWord) add("search", 1);
    if (pageType === "listing" || pageType === "search_results") add("search", scores.search ? 1 : 0);

    // Position
    if (element.region === "header" || element.region === "nav" || element.attrs?.formRole === "search") add("search", 1);
    if (element.sectionHeading && matchesAnyTerm(element.sectionHeading, REVIEW_SECTION_TERMS)) add("review_comment", 1);
    if (element.groupId && groupHasMoney(element, inventory) && (element.role === "spinbutton" || element.role === "textbox")) add("quantity", 1);
    // A delivery note / remark is free text but not a review (e.g. a checkout textarea).
    if (matchesAnyTerm(`${text} ${element.sectionHeading ?? ""}`, NOTE_TERMS)) add("review_comment", -3);

    // Combobox: sort or filter, by name and options.
    if (element.role === "combobox" || element.role === "listbox") {
      const choices = `${text} | ${(element.options ?? []).join(" | ")}`;
      if (matchesAnyTerm(choices, PURPOSE_TERMS.sort)) add("sort", 4);
      if (matchesAnyTerm(choices, PURPOSE_TERMS.filter)) add("filter", 3);
      if ((element.options ?? []).some((option) => /^(all|any)\b|ทุก|ทั้งหมด/i.test(option.trim()))) add("filter", 2);
    }

    // Page type
    if (pageType === "cart") add("quantity", 1);
    if (pageType === "checkout") for (const purpose of CHECKOUT_FIELD_PURPOSES) if (scores[purpose]) add(purpose, 1);
    return scores;
  }

  if (BUTTON_ROLES.has(element.role)) {
    const label = fullText(element);
    const wishlist = matchesAnyTerm(label, WISHLIST_TERMS);
    if (isAddToCartLabel(label)) add("add_to_cart", 4);
    // A disabled "sold out" button is the add-to-cart button of an unavailable product.
    if (!wishlist && element.attrs?.disabled && matchesAnyTerm(label, PURPOSE_TERMS.stock_status)) add("add_to_cart", 4);
    if (!wishlist && matchesAnyTerm(label, PURPOSE_TERMS.remove_from_cart)) {
      add("remove_from_cart", 3);
      if (pageType === "cart" || groupHasMoney(element, inventory)) add("remove_from_cart", 1);
    }
    if (matchesAnyTerm(label, PURPOSE_TERMS.checkout_button)) add("checkout_button", 4);
    const chrome = (element.region === "header" || element.region === "nav") && !element.groupId;
    if (chrome && matchesAnyTerm(label, PURPOSE_TERMS.cart_badge)) add("cart_badge", 4);
    // Quantity steppers: "+"/"-" (or increase/decrease) inside a priced card/row.
    const stepperLabel = /^([+\-−–]|plus|minus)$/i.test(element.name.trim()) || matchesAnyTerm(label, STEPPER_TERMS);
    if (element.role === "button" && stepperLabel && (groupHasMoney(element, inventory) || pageType === "cart")) {
      add("quantity", 4);
    }
    return scores;
  }

  // Text and headings
  const content = fullText(element);
  if (element.groupId && element.groupLabel && content.trim() === element.groupLabel.trim()) add("product_name", 5);
  if (element.role === "heading" && element.attrs?.level === 1 && !MONEY_PATTERN.test(content)
    && pageType !== "cart" && pageType !== "checkout"
    && (pageType === "product_detail" || (inventory.groups.length === 0
      && inventory.elements.some((other) => isAddToCartLabel(other.name) && other.role === "button")
      && inventory.elements.some((other) => other.role !== "heading" && MONEY_PATTERN.test(fullText(other)))))) {
    add("product_name", 4);
  }
  if (element.role === "heading") return scores;

  const isFee = matchesAnyTerm(content, FEE_TERMS);
  if (MONEY_PATTERN.test(content)) {
    if (matchesAnyTerm(element.name || content, PURPOSE_TERMS.subtotal)) add("subtotal", 5);
    else if (matchesAnyTerm(element.name || content, PURPOSE_TERMS.total)) add("total", 5);
    else if (!isFee) {
      add("price", 2);
      // Mostly an amount: a bare price, or a price with a short unit word ("ต่อชิ้น", "each").
      if (content.replace(MONEY_PATTERN, "").trim().length <= 10) add("price", 2);
      if (element.groupId) add("price", 1);
    }
  }
  if (matchesAnyTerm(content, CART_COUNT_TERMS) && /\d/.test(content)) add("cart_badge", 4);
  if (!MONEY_PATTERN.test(content) && matchesAnyTerm(content, PURPOSE_TERMS.stock_status)) add("stock_status", 4);
  return scores;
};

const ranked = (scores: PurposeScores): Array<[ElementPurpose, number]> =>
  (Object.entries(scores) as Array<[ElementPurpose, number]>).filter(([, score]) => score > 0).sort((a, b) => b[1] - a[1]);

export const decidePurpose = (element: InventoryElement, scores: PurposeScores): PurposeDecision => {
  const order = ranked(scores);
  const [top, second] = [order[0]?.[1] ?? 0, order[1]?.[1] ?? 0];
  const fallback = isGenericFallback(element);
  if (top >= DECIDE_MIN_SCORE && top - second >= DECIDE_MIN_LEAD) {
    return {
      elementId: element.id,
      purpose: order[0][0],
      confidence: Math.min(1, 0.6 + 0.05 * (top - DECIDE_MIN_SCORE) + 0.1 * (top - second)),
      status: "rule",
      candidates: [],
      scores,
    };
  }
  if (top < ASK_MIN_SCORE) {
    return { elementId: element.id, purpose: fallback, confidence: 0.5, status: "no_evidence", candidates: [], scores };
  }
  return {
    elementId: element.id,
    purpose: fallback,
    confidence: 0.3,
    status: "ambiguous",
    candidates: order.filter(([, score]) => score >= ASK_MIN_SCORE).slice(0, 4).map(([purpose]) => purpose),
    scores,
  };
};

export interface ClassificationResult {
  inventory: ElementInventory;
  decisions: PurposeDecision[];
}

const applyDecisions = (inventory: ElementInventory, decisions: PurposeDecision[]): ElementInventory => {
  const byId = new Map(decisions.map((decision) => [decision.elementId, decision]));
  return {
    ...inventory,
    elements: inventory.elements.map((element) => {
      const decision = byId.get(element.id);
      return decision ? { ...element, purpose: decision.purpose, purposeConfidence: decision.confidence } : element;
    }),
  };
};

/** Rule-based pass (3b). Ambiguous elements get the generic fallback until resolveAmbiguousPurposes runs. */
export const classifyInventory = (inventory: ElementInventory, pageType: PageType | undefined = inventory.pageType): ClassificationResult => {
  const context: ClassifyContext = { inventory, pageType };
  const decisions = inventory.elements.map((element) => decidePurpose(element, scoreElement(element, context)));
  return { inventory: applyDecisions(inventory, decisions), decisions };
};

/** Short context line per element for the multiple-choice question. */
const describeForLlm = (element: InventoryElement, inventory: ElementInventory, pageType: PageType | undefined): string => {
  const parts = [`${element.id} ${element.role} ${JSON.stringify(element.name)}`];
  if (element.attrs?.placeholder) parts.push(`placeholder=${JSON.stringify(element.attrs.placeholder)}`);
  if (element.attrs?.type) parts.push(`type=${element.attrs.type}`);
  if (element.attrs?.tag === "textarea") parts.push("multiline");
  if (element.options?.length) parts.push(`options=[${element.options.slice(0, 6).join(" | ")}]`);
  if (element.text) parts.push(`text=${JSON.stringify(element.text)}`);
  if (element.sectionHeading) parts.push(`heading=${JSON.stringify(element.sectionHeading)}`);
  const nearby = nearbyButtonText(element, inventory);
  if (nearby) parts.push(`buttons nearby=${JSON.stringify(nearby)}`);
  parts.push(`page=${pageType ?? "unknown"}`);
  return parts.join(" ");
};

export type AskLlm = (prompt: string, schema: object) => Promise<string>;

export interface ResolveStats {
  asked: number;
  answered: number;
  fallback: number;
  failedCalls: number;
}

/**
 * 3c: asks the LLM about ambiguous elements, at most MAX_LLM_BATCH per call, choosing only among each
 * element's candidates (+ unknown). Unknown answers and failed calls keep the generic fallback.
 */
export const resolveAmbiguousPurposes = async (
  result: ClassificationResult,
  ask: AskLlm,
  pageType: PageType | undefined = result.inventory.pageType,
): Promise<ClassificationResult & { stats: ResolveStats }> => {
  const stats: ResolveStats = { asked: 0, answered: 0, fallback: 0, failedCalls: 0 };
  const decisions = result.decisions.map((decision) => ({ ...decision }));
  const ambiguous = decisions.filter((decision) => decision.status === "ambiguous");
  const elementById = new Map(result.inventory.elements.map((element) => [element.id, element]));

  for (let start = 0; start < ambiguous.length; start += MAX_LLM_BATCH) {
    const batch = ambiguous.slice(start, start + MAX_LLM_BATCH);
    const allowed = [...new Set(batch.flatMap((decision) => decision.candidates))];
    const ids = batch.map((decision) => decision.elementId);
    stats.asked += batch.length;
    const prompt = [
      "เลือกหน้าที่ (purpose) ของ element แต่ละตัวในหน้าร้านค้าออนไลน์ จากตัวเลือกใน schema เท่านั้น",
      "ถ้าไม่แน่ใจให้ตอบ unknown",
      `ตัวเลือก: ${allowed.join(", ")}, unknown`,
      "",
      ...batch.map((decision) => describeForLlm(elementById.get(decision.elementId)!, result.inventory, pageType)),
    ].join("\n");
    let purposes: Map<string, ElementPurpose>;
    try {
      purposes = parsePurposeResponse(await ask(prompt, buildPurposeSchema(allowed, ids)), ids, allowed).purposes;
    } catch {
      stats.failedCalls += 1;
      purposes = new Map();
    }
    for (const decision of batch) {
      const answer = purposes.get(decision.elementId);
      // Only a purpose that was a candidate for this element counts; the schema enum is per batch.
      if (answer && answer !== "unknown" && decision.candidates.includes(answer)) {
        decision.purpose = answer;
        decision.status = "llm";
        decision.confidence = 0.6;
        stats.answered += 1;
      } else {
        decision.status = "llm_fallback";
        stats.fallback += 1;
      }
    }
  }
  return { inventory: applyDecisions(result.inventory, decisions), decisions, stats };
};
