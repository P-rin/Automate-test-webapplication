/**
 * Phase 4a — page type classifier. Scores URL (only when the URL identifies the state), page titles
 * (headings, short header texts) and the page's composition from element purposes (Phase 3), so that
 * state-based SPAs without distinct URLs are still classified. Falls back to "other".
 */
import { matchesAnyTerm, MONEY_PATTERN } from "./keywords.js";
import type { ElementInventory, InventoryElement, PageType } from "./types.js";

export const PAGE_MIN_SCORE = 3;

const PAGE_TITLE_TERMS: Partial<Record<PageType, readonly string[]>> = {
  cart: ["your cart", "shopping cart", "cart", "basket", "shopping bag", "ตะกร้าสินค้า", "ตะกร้า", "รถเข็น"],
  checkout: ["checkout", "check out", "shipping address", "payment", "your information", "overview", "ชำระเงิน", "ยืนยันคำสั่งซื้อ", "ที่อยู่จัดส่ง", "ข้อมูลการจัดส่ง"],
  login: ["login", "log in", "sign in", "welcome back", "เข้าสู่ระบบ", "ยินดีต้อนรับกลับ", "ลงชื่อเข้าใช้"],
  order_confirmation: ["thank you", "order complete", "order confirmed", "order number", "ขอบคุณ", "สั่งซื้อสำเร็จ", "เลขที่ออเดอร์", "เลขที่คำสั่งซื้อ"],
  listing: ["products", "shop", "catalog", "all products", "สินค้าทั้งหมด", "รายการสินค้า"],
  search_results: ["search results", "results for", "ผลการค้นหา"],
};

const URL_RULES: Array<[RegExp, PageType, number]> = [
  [/(order-?confirm|thank-?you|checkout-complete|order-?success|\/complete)/i, "order_confirmation", 3],
  [/(\/cart|\/basket|\/bag)(\.html?)?([/?#]|$)/i, "cart", 3],
  [/\/checkout|\/payment|\/shipping/i, "checkout", 3],
  [/(\/login|\/signin|\/sign-in|\/log-in)(\.html?)?([/?#]|$)/i, "login", 3],
  [/(\/search([/?#]|$)|[?&](q|query|search|keyword)=)/i, "search_results", 3],
  [/(\/products?\/[^/?#]+|\/p\/[^/?#]+|\/item[s]?\/[^/?#]+|product-detail)/i, "product_detail", 3],
  [/(\/products?|\/shop|\/catalog|\/category|\/categories|\/collections?|\/inventory)(\.html?)?([/?#]|$)/i, "listing", 2],
];

const has = (inventory: ElementInventory, predicate: (element: InventoryElement) => boolean): boolean =>
  inventory.elements.some(predicate);
const count = (inventory: ElementInventory, predicate: (element: InventoryElement) => boolean): number =>
  inventory.elements.filter(predicate).length;

/** Headings anywhere, plus short texts in the header (some sites title their pages with a plain span). */
const pageTitles = (inventory: ElementInventory): string[] => inventory.elements
  .filter((element) => !element.hiddenFromPrompt && (element.role === "heading"
    || (element.region === "header" && element.role === "text" && !element.groupId && (element.text ?? "").length <= 40)))
  .map((element) => element.role === "heading" ? element.name : `${element.name} ${element.text ?? ""}`.trim());

export interface PageClassification {
  pageType: PageType;
  scores: Partial<Record<PageType, number>>;
}

/** Needs element purposes (run classifyInventory first). */
export const classifyPageType = (inventory: ElementInventory): PageClassification => {
  const scores: Partial<Record<PageType, number>> = {};
  const add = (type: PageType, points: number) => {
    scores[type] = (scores[type] ?? 0) + points;
  };

  if (inventory.urlIsStable && inventory.pageUrl) {
    let path = inventory.pageUrl;
    try {
      const url = new URL(inventory.pageUrl);
      path = `${url.pathname}${url.search}`;
    } catch {
      // keep the raw value
    }
    for (const [pattern, type, points] of URL_RULES) {
      if (pattern.test(path)) {
        add(type, points);
        break;
      }
    }
  }

  for (const title of pageTitles(inventory)) {
    for (const [type, terms] of Object.entries(PAGE_TITLE_TERMS) as Array<[PageType, readonly string[]]>) {
      if (matchesAnyTerm(title, terms)) add(type, 2);
    }
  }

  const purpose = (value: InventoryElement["purpose"]) => (element: InventoryElement) => element.purpose === value;
  const pricedSets = new Set(inventory.groups.filter((group) => inventory.elements.some((element) =>
    element.groupId === group.id && MONEY_PATTERN.test(`${element.name} ${element.text ?? ""}`))).map((group) => group.setId));
  const repeatedPriced = inventory.groups.some((group) => pricedSets.has(group.setId) && group.count >= 2);
  const addButtons = count(inventory, purpose("add_to_cart"));
  const removeInRows = has(inventory, (element) => element.purpose === "remove_from_cart" && (Boolean(element.groupId) || element.region === "main"));
  const steppers = has(inventory, (element) => element.purpose === "quantity" && element.role === "button");
  const fields = (purposes: InventoryElement["purpose"][]) => count(inventory, (element) => element.interactive && purposes.includes(element.purpose));
  const passwordFields = count(inventory, purpose("password"));
  const textInputs = count(inventory, (element) => ["textbox", "searchbox"].includes(element.role) && element.region !== "header");

  if (repeatedPriced && (addButtons > 0 || has(inventory, (element) => Boolean(element.groupId) && element.role === "link"))) add("listing", 3);
  // Search plus filter/sort controls make a catalog page even when it currently shows no products.
  if (has(inventory, purpose("search")) && (has(inventory, purpose("filter")) || has(inventory, purpose("sort")))) add("listing", 2);
  if (!repeatedPriced && addButtons >= 1 && has(inventory, purpose("price"))) {
    add("product_detail", 3);
    if (has(inventory, (element) => element.purpose === "quantity" && element.role !== "button")) add("product_detail", 1);
  }
  if (removeInRows || steppers) add("cart", 3);
  if (has(inventory, purpose("subtotal")) && has(inventory, purpose("checkout_button")) && !fields(["name", "address", "phone", "postal_code"])) add("cart", 1);
  // Personal-data fields next to a password field are a registration form, not a checkout.
  if (fields(["name", "address", "phone", "postal_code", "card_number"]) >= 2 && passwordFields === 0) add("checkout", 3);
  if (has(inventory, purpose("total")) && has(inventory, purpose("subtotal"))) add("checkout", 1);
  // A login form is a password field with at most a couple of other inputs (a registration form has more).
  if (passwordFields >= 1 && textInputs - passwordFields <= 2) add("login", 3);

  const ranked = (Object.entries(scores) as Array<[PageType, number]>).sort((a, b) => b[1] - a[1]);
  const [best, second] = [ranked[0], ranked[1]];
  const pageType = best && best[1] >= PAGE_MIN_SCORE && best[1] > (second?.[1] ?? 0) ? best[0] : "other";
  return { pageType, scores };
};
