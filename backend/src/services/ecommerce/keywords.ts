/**
 * Thai + English keyword dictionaries for the e-commerce pipeline. Generic shop vocabulary only:
 * never add a site's product names, button labels or prices here (see REACT_CART_WEB_PROFILE.md).
 *
 * Matching rule (same as DISCOVERY_BLOCKED_TERMS): English terms match whole words, Thai terms match
 * anywhere because Thai is written without spaces.
 */

/** Header/nav items whose content changes with use; never hidden as "already seen". */
export const DYNAMIC_HEADER_TERMS = [
  "cart", "basket", "bag", "account", "profile", "my account", "wishlist", "logged in", "signed in",
  "ตะกร้า", "บัญชี", "โปรไฟล์", "รายการโปรด", "เข้าสู่ระบบในชื่อ", "ใช้งานในฐานะ",
];

/** Text that tends to be checked by an oracle: prices, totals, stock, empty/error states. */
export const IMPORTANT_TEXT_TERMS = [
  "total", "subtotal", "sub-total", "tax", "shipping", "discount", "price", "qty", "quantity",
  "in stock", "out of stock", "sold out", "stock", "left", "error", "invalid", "required", "not found",
  "no results", "empty", "items", "item",
  "ยอด", "รวม", "ภาษี", "ค่าจัดส่ง", "ค่าส่ง", "ส่วนลด", "ราคา", "จำนวน", "คงเหลือ", "สต็อก", "หมด",
  "ไม่พบ", "ว่าง", "ผิดพลาด", "ไม่ถูกต้อง", "ไม่สำเร็จ", "กรุณา", "ต้อง", "ชิ้น",
];

/** Currency amount anywhere in a string: "฿7,990", "$29.99", "1,200 บาท", "-฿0". */
export const MONEY_PATTERN = /(?:[฿$€£]\s?-?\d[\d,]*(?:\.\d+)?)|(?:\d[\d,]*(?:\.\d+)?\s?(?:บาท|THB|USD|EUR))/i;

const ENGLISH_TERM = /^[a-z][a-z -]*$/;

export const matchesTerm = (text: string, term: string): boolean => {
  const normalized = text.toLocaleLowerCase();
  if (!ENGLISH_TERM.test(term)) return normalized.includes(term);
  return new RegExp(`(^|[^a-z])${term.replace(/[-]/g, "\\-")}([^a-z]|$)`).test(normalized);
};

export const matchesAnyTerm = (text: string, terms: readonly string[]): boolean =>
  terms.some((term) => matchesTerm(text, term));
