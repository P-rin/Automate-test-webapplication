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

/** Currency amount anywhere in a string: baht/dollar/euro/pound sign + number, "1,200 บาท", negative amounts. */
export const MONEY_PATTERN = /(?:[฿$€£]\s?-?\d[\d,]*(?:\.\d+)?)|(?:\d[\d,]*(?:\.\d+)?\s?(?:บาท|THB|USD|EUR))/i;

const ENGLISH_TERM = /^[a-z][a-z -]*$/;

export const matchesTerm = (text: string, term: string): boolean => {
  const normalized = text.toLocaleLowerCase();
  if (!ENGLISH_TERM.test(term)) return normalized.includes(term);
  return new RegExp(`(^|[^a-z])${term.replace(/[-]/g, "\\-")}([^a-z]|$)`).test(normalized);
};

export const matchesAnyTerm = (text: string, terms: readonly string[]): boolean =>
  terms.some((term) => matchesTerm(text, term));

// ---------------------------------------------------------------------------------------------
// Element purpose clues (Phase 3). Matched against name / label / placeholder / HTML name / id /
// autocomplete / options / nearby text, with matchesTerm (English whole word, Thai substring).

export const PURPOSE_TERMS = {
  search: ["search", "find", "lookup", "ค้นหา", "หาสินค้า"],
  quantity: ["qty", "quantity", "amount", "จำนวน"],
  coupon: ["coupon", "promo", "promo code", "promotion code", "voucher", "discount code", "gift card", "redeem", "โค้ดส่วนลด", "คูปอง", "รหัสส่วนลด", "โค้ดโปรโมชั่น", "บัตรกำนัล"],
  review_comment: ["review", "comment", "comments", "feedback", "ความคิดเห็น", "รีวิว", "ความเห็น", "ติชม"],
  email: ["email", "e-mail", "mail", "อีเมล", "อีเมล์"],
  password: ["password", "passcode", "pwd", "รหัสผ่าน"],
  name: ["name", "first name", "last name", "full name", "username", "user name", "recipient", "given name", "family name", "ชื่อ", "นามสกุล", "ผู้รับ", "ชื่อผู้ใช้"],
  phone: ["phone", "tel", "telephone", "mobile", "contact number", "เบอร์", "โทรศัพท์", "มือถือ", "เบอร์โทร"],
  address: ["address", "street", "city", "district", "province", "state", "country", "region", "ที่อยู่", "ถนน", "เขต", "อำเภอ", "ตำบล", "แขวง", "จังหวัด", "ประเทศ"],
  postal_code: ["zip", "zip code", "postal", "postal code", "postcode", "post code", "รหัสไปรษณีย์", "ไปรษณีย์"],
  card_number: ["card number", "credit card", "card no", "cc number", "cardnumber", "เลขบัตร", "หมายเลขบัตร", "บัตรเครดิต"],
  add_to_cart: ["add to cart", "add to bag", "add to basket", "buy", "buy now", "เพิ่มลงตะกร้า", "ใส่ตะกร้า", "หยิบใส่ตะกร้า", "ซื้อ", "ซื้อเลย"],
  remove_from_cart: ["remove", "delete", "ลบ", "นำออก"],
  checkout_button: ["checkout", "check out", "proceed to checkout", "place order", "ชำระเงิน", "ดำเนินการสั่งซื้อ", "สั่งซื้อสินค้า"],
  cart_badge: ["cart", "basket", "bag", "shopping cart", "ตะกร้า", "รถเข็น"],
  sort: ["sort", "sort by", "order by", "low to high", "high to low", "a to z", "z to a", "newest", "price ascending", "price descending", "เรียง", "จัดเรียง", "ราคาต่ำ", "ราคาสูง", "ใหม่ล่าสุด", "ขายดี"],
  filter: ["filter", "category", "categories", "brand", "type", "หมวด", "หมวดหมู่", "ประเภท", "กรอง", "แบรนด์", "ยี่ห้อ"],
  // No bare "หมด": it is inside "ทั้งหมด" (all) and "โหมด" (mode).
  stock_status: ["in stock", "out of stock", "sold out", "stock", "left", "available", "unavailable", "คงเหลือ", "สินค้าหมด", "หมดแล้ว", "หมดสต็อก", "สต็อก", "พร้อมส่ง"],
  subtotal: ["subtotal", "sub-total", "sub total", "item total", "items total", "ยอดรวม", "ยอดรวมสินค้า", "รวมเป็นเงิน"],
  total: ["total", "grand total", "order total", "net total", "amount due", "ยอดสุทธิ", "รวมทั้งสิ้น", "ยอดชำระ", "ยอดที่ต้องชำระ"],
} as const;

/** Item-count summaries that stand in for a header cart badge (e.g. "Items in cart: 2"). */
export const CART_COUNT_TERMS = ["items in cart", "total items", "item count", "cart items", "จำนวนสินค้าทั้งหมด", "จำนวนสินค้าในตะกร้า", "จำนวนชิ้น"];
/** Fees next to totals; their amounts are not product prices. */
export const FEE_TERMS = ["tax", "vat", "shipping", "delivery", "discount", "fee", "ภาษี", "ค่าจัดส่ง", "ค่าส่ง", "ส่วนลด", "ค่าธรรมเนียม"];
/** Free-text fields that are not reviews: delivery notes, remarks. */
export const NOTE_TERMS = ["note", "notes", "remark", "remarks", "instruction", "instructions", "special request", "หมายเหตุ", "ข้อความถึง", "คำแนะนำในการจัดส่ง"];
/** Things that are not the shopping cart even if they say "remove"/"add". */
export const WISHLIST_TERMS = ["wishlist", "wish list", "favorite", "favourite", "saved", "รายการโปรด", "ชอบ", "บันทึกไว้"];
/** Section/heading words that put a free-text field in a review context. */
export const REVIEW_SECTION_TERMS = ["review", "reviews", "comment", "comments", "rating", "รีวิว", "ความคิดเห็น", "ให้คะแนน"];
/** Buttons that submit a review / apply a coupon / run a search. */
export const SUBMIT_REVIEW_TERMS = ["post", "submit", "send", "publish", "ส่ง", "โพสต์", "แสดงความคิดเห็น"];
export const APPLY_COUPON_TERMS = ["apply", "redeem", "ใช้โค้ด", "ใช้คูปอง", "ยืนยันโค้ด"];
export const SEARCH_BUTTON_TERMS = ["search", "go", "find", "ค้นหา"];
/** Stepper controls next to a quantity (bare "plus"/"minus" only as the whole label: "XPS 13 Plus" is a product). */
export const STEPPER_TERMS = ["increase quantity", "decrease quantity", "increase", "decrease", "increment", "decrement", "เพิ่มจำนวน", "ลดจำนวน"];
/** Order history / order wording that contains "ซื้อ" (buy) but is not an add-to-cart button. */
export const ORDER_TERMS = ["คำสั่งซื้อ", "ประวัติการสั่งซื้อ", "การสั่งซื้อ", "order history", "my orders", "orders"];

/** Words of a validation/error message, for the validationMessageShown oracle (Phase 5). */
export const VALIDATION_ERROR_TERMS = [
  "required", "invalid", "error", "must", "please enter", "please fill", "please select", "not valid", "at least", "at most",
  "minimum", "maximum", "cannot be", "too long", "too short", "out of range", "not enough",
  "กรุณา", "ไม่ถูกต้อง", "จำเป็น", "ต้องระบุ", "ต้องมี", "ต้องเป็น", "ต้องไม่", "ผิดพลาด", "ไม่สามารถ", "ขั้นต่ำ", "สูงสุด", "เกิน", "ไม่เพียงพอ", "ไม่ครบ",
];

/**
 * A JS regex literal that matches any of the terms with the same rule as matchesTerm (English whole word,
 * Thai anywhere), case-insensitively.
 */
export const termsRegexLiteral = (terms: readonly string[]): string => {
  const escape = (term: string) => term.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const parts = terms.map((term) => ENGLISH_TERM.test(term) ? `\\b${escape(term)}\\b` : escape(term));
  return `/(?:${parts.join("|")})/i`;
};
