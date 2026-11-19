/**
 * Group B templates (ECOMMERCE_TESTGEN_CONTEXT.md §4c + REACT_CART_WEB_PROFILE.md §6): shop flows.
 * Every oracle is chosen from what the page really has (a counting cart badge or not, steppers or a quantity
 * input, URLs that identify pages or not); a feature the page lacks produces no case.
 */
import { matchesAnyTerm, MONEY_PATTERN } from "../keywords.js";
import { ENV_EMAIL, ENV_PASSWORD, TEST_DATA, validValueFor } from "../testData.js";
import type { InventoryElement, InventoryGroup, Oracle, StructuredStep } from "../types.js";
import {
  describe,
  EMPTY_STATE_TERMS,
  fieldRef,
  formSubmitFor,
  inGroup,
  isFinalOrderButton,
  isLoginish,
  isOutOfStockText,
  nearbyButtons,
  parseAmount,
  pricedGroups,
  safeSubmitFor,
  stockIn,
  withPurpose,
} from "./helpers.js";
import type { CandidateDraft, CaseTemplate, TemplateContext } from "./types.js";

const text = (element: InventoryElement): string => `${element.name} ${element.text ?? ""}`.trim();
const SOLD_OUT_TERMS = ["out of stock", "sold out", "unavailable", "สินค้าหมด", "หมดแล้ว", "หมดสต็อก"];
const DISCOUNT_TERMS = ["discount", "coupon", "promo", "ส่วนลด", "คูปอง"];
const enabledAddButtons = (context: TemplateContext) =>
  withPurpose(context.inventory, "add_to_cart").filter((button) => !button.attrs?.disabled && !isLoginish(button));

/** Product name shown for a card/row, or the page's product heading on a detail page. */
const productNameFor = (context: TemplateContext, element: InventoryElement): string | undefined => {
  if (element.groupLabel) return element.groupLabel;
  const heading = withPurpose(context.inventory, "product_name")[0];
  return heading ? heading.name || heading.text : undefined;
};

/** A cart badge that shows a count: in the header, or with a number in it. Plain "Cart" nav links do not count. */
const countingBadge = (context: TemplateContext): InventoryElement | undefined =>
  withPurpose(context.inventory, "cart_badge").find((badge) => badge.interactive && (badge.region === "header" || /\d/.test(text(badge))));
const cartLink = (context: TemplateContext): InventoryElement | undefined =>
  withPurpose(context.inventory, "cart_badge").find((badge) => badge.interactive);

const sortDirection = (option: string): { field: "price" | "name"; direction: "asc" | "desc" } | undefined => {
  const value = option.toLocaleLowerCase();
  const price = matchesAnyTerm(value, ["price", "ราคา"]);
  if (price && matchesAnyTerm(value, ["low to high", "lowest", "ascending", "ต่ำไปสูง", "น้อยไปมาก", "ถูกไปแพง"])) return { field: "price", direction: "asc" };
  if (price && matchesAnyTerm(value, ["high to low", "highest", "descending", "สูงไปต่ำ", "มากไปน้อย", "แพงไปถูก"])) return { field: "price", direction: "desc" };
  if (/\ba\s*(to|-|–)\s*z\b|ก\s*-\s*ฮ|ก-ฮ/i.test(value)) return { field: "name", direction: "asc" };
  if (/\bz\s*(to|-|–)\s*a\b|ฮ\s*-\s*ก|ฮ-ก/i.test(value)) return { field: "name", direction: "desc" };
  return undefined;
};

// ---------------------------------------------------------------------------------------------
// Listing / product

export const addToCartTemplate: CaseTemplate = {
  id: "listing.add_to_cart",
  description: "Add one representative product to the cart; oracle from a counting badge or the cart page",
  appliesTo: (context) => (context.pageType === "listing" || context.pageType === "product_detail") && enabledAddButtons(context).length > 0,
  build: (context) => {
    const button = enabledAddButtons(context)[0];
    const name = productNameFor(context, button);
    const badge = countingBadge(context);
    const drafts: CandidateDraft[] = [];
    if (badge) {
      drafts.push({
        templateId: "listing.add_to_cart", category: "happy_path", mandatory: true, targetElementId: button.id, inputVariant: "add=1",
        titleTh: `กด "${button.name}"${name ? ` ของ "${name}"` : ""} แล้วจำนวนในตะกร้าเพิ่มขึ้น 1`,
        steps: [{ kind: "click", elementId: button.id }],
        oracle: { kind: "countChangedBy", elementId: badge.id, delta: 1 },
        expectedResultTh: `ตัวเลขที่ ${describe(badge)} เพิ่มขึ้น 1`,
      });
      // A card's add button often turns into "remove" once clicked, so clicking it twice is only tested
      // where the button stays (a product page's own button, outside repeated cards).
      if (!button.groupId) drafts.push({
        templateId: "listing.add_twice", category: "boundary", mandatory: false, targetElementId: button.id, inputVariant: "add=2",
        titleTh: `กด "${button.name}"${name ? ` ของ "${name}"` : ""} สองครั้ง`,
        steps: [{ kind: "click", elementId: button.id }, { kind: "click", elementId: button.id }],
        oracle: { kind: "countChangedBy", elementId: badge.id, delta: 2 },
        expectedResultTh: `ตัวเลขที่ ${describe(badge)} เพิ่มขึ้น 2 หรือจำนวนของสินค้านี้ในตะกร้าเป็น 2 (ให้ผู้ใช้ยืนยันพฤติกรรมที่ต้องการ)`,
      });
      return drafts;
    }
    // No counter on the page: open the cart and look for the product (REACT_CART_WEB_PROFILE.md §6.3).
    const link = cartLink(context);
    if (!link || !name) return [];
    return [{
      templateId: "listing.add_to_cart", category: "happy_path", mandatory: true, targetElementId: button.id, inputVariant: "add=1",
      titleTh: `กด "${button.name}" ของ "${name}" แล้วสินค้าอยู่ในตะกร้า`,
      steps: [{ kind: "click", elementId: button.id }, { kind: "click", elementId: link.id }],
      oracle: { kind: "textVisible", text: name },
      expectedResultTh: `เมื่อเปิด ${describe(link)} จะเห็นสินค้า "${name}" ในตะกร้า`,
    }];
  },
};

export const sortTemplate: CaseTemplate = {
  id: "listing.sort",
  description: "One case per recognizable sort option, checked over every visible card",
  appliesTo: (context) => withPurpose(context.inventory, "sort").filter((element) => element.interactive && (element.options?.length ?? 0) > 0),
  build: (context, element) => {
    const group = pricedGroups(context.inventory)[0] ?? context.inventory.groups[0];
    if (!element || !group) return [];
    return (element.options ?? []).flatMap((option): CandidateDraft[] => {
      const order = sortDirection(option);
      if (!order) return [];
      const fieldTh = order.field === "price" ? "ราคา" : "ชื่อสินค้า";
      const directionTh = order.direction === "asc" ? "น้อยไปมาก" : "มากไปน้อย";
      return [{
        templateId: "listing.sort", category: "happy_path", mandatory: true, targetElementId: element.id,
        inputVariant: `sort=${order.field}_${order.direction}`,
        titleTh: `เลือก "${option}" แล้วสินค้าเรียงตาม${fieldTh}${order.field === "price" ? `จาก${directionTh}` : order.direction === "asc" ? " A-Z" : " Z-A"}`,
        steps: [{ kind: "selectOption", elementId: element.id, optionLabel: option }],
        oracle: { kind: "sortedBy", groupId: group.id, field: order.field, direction: order.direction },
        expectedResultTh: `สินค้าทุกชิ้นที่แสดงเรียงตาม${fieldTh}${order.direction === "asc" ? "จากน้อยไปมาก" : "จากมากไปน้อย"}`,
      }];
    });
  },
};

/** Only when the option text appears in the cards, so "every card belongs to the filter" can be checked. */
export const filterTemplate: CaseTemplate = {
  id: "listing.filter",
  description: "Pick one filter value whose label is visible on the cards",
  appliesTo: (context) => withPurpose(context.inventory, "filter").filter((element) => element.interactive && (element.options?.length ?? 0) > 1),
  build: (context, element) => {
    const group = pricedGroups(context.inventory)[0] ?? context.inventory.groups[0];
    if (!element || !group) return [];
    const cardText = inGroup(context.inventory, group.id).map(text).join(" ").toLocaleLowerCase();
    const option = (element.options ?? []).find((candidate) => candidate !== element.value
      && !/^(all|any)\b|ทุก|ทั้งหมด/i.test(candidate) && cardText.includes(candidate.toLocaleLowerCase()));
    if (!option) return [];
    return [{
      templateId: "listing.filter", category: "happy_path", mandatory: false, targetElementId: element.id, inputVariant: `filter=${option}`,
      titleTh: `กรองด้วย "${option}" แล้วแสดงเฉพาะสินค้าในกลุ่มนั้น`,
      steps: [{ kind: "selectOption", elementId: element.id, optionLabel: option }],
      oracle: { kind: "allItemsContain", groupId: group.id, text: option },
      expectedResultTh: `สินค้าทุกชิ้นที่แสดงอยู่ในกลุ่ม "${option}"`,
    }];
  },
};

const searchSubmitSteps = (context: TemplateContext, field: InventoryElement): StructuredStep[] => {
  const button = safeSubmitFor(context, field);
  if (button) return [{ kind: "click", elementId: button.id }];
  return field.attrs?.formRole === "search" ? [{ kind: "press", elementId: field.id, key: "Enter" }] : [];
};

export const searchTemplate: CaseTemplate = {
  id: "search",
  description: "Search for a visible product name (exact and lower case), a word that matches nothing, and nothing",
  appliesTo: (context) => withPurpose(context.inventory, "search").filter((element) => element.interactive && !element.attrs?.disabled),
  build: (context, field) => {
    if (!field) return [];
    const group = pricedGroups(context.inventory)[0];
    const term = group?.label;
    const fill = (value: string): StructuredStep[] => [{ kind: "fill", elementId: field.id, value }, ...searchSubmitSteps(context, field)];
    const drafts: CandidateDraft[] = [];
    if (group && term) {
      drafts.push({
        templateId: "search.found", category: "happy_path", mandatory: true, targetElementId: field.id, inputVariant: `search=${term}`,
        titleTh: `ค้นหา "${term}" แล้วผลลัพธ์ทุกชิ้นมีคำนี้`, steps: fill(term),
        oracle: { kind: "allItemsContain", groupId: group.id, text: term },
        expectedResultTh: `แสดงสินค้าที่ชื่อมี "${term}" อย่างน้อย 1 ชิ้น และทุกชิ้นที่แสดงมีคำนี้`,
      });
      const lower = term.toLocaleLowerCase();
      if (lower !== term) {
        drafts.push({
          templateId: "search.case_insensitive", category: "boundary", mandatory: false, targetElementId: field.id, inputVariant: `search=${lower}`,
          titleTh: `ค้นหาด้วยตัวพิมพ์เล็ก "${lower}" แล้วยังพบ "${term}"`, steps: fill(lower),
          oracle: { kind: "allItemsContain", groupId: group.id, text: lower },
          expectedResultTh: `การค้นหาไม่สนตัวพิมพ์ใหญ่-เล็ก: แสดง "${term}"`,
        });
      }
      drafts.push({
        templateId: "search.empty", category: "boundary", mandatory: false, targetElementId: field.id, inputVariant: "search=empty",
        titleTh: "ค้นหาด้วยค่าว่างแล้วยังแสดงสินค้าทั้งหมด", steps: fill(""),
        oracle: { kind: "countEquals", groupId: group.id, expected: group.count },
        expectedResultTh: `แสดงสินค้าครบ ${group.count} ชิ้นเหมือนก่อนค้นหา (หรือไม่เปลี่ยนแปลง — ให้ผู้ใช้ยืนยัน)`,
      });
    }
    drafts.push({
      templateId: "search.not_found", category: "negative", mandatory: true, targetElementId: field.id, inputVariant: `search=${TEST_DATA.notFoundTerm}`,
      titleTh: `ค้นหาคำที่ไม่มีสินค้า "${TEST_DATA.notFoundTerm}"`, steps: fill(TEST_DATA.notFoundTerm),
      oracle: { kind: "emptyStateShown" },
      expectedResultTh: "ไม่แสดงสินค้า และแสดงข้อความว่าไม่พบสินค้า",
    });
    return drafts;
  },
};

export const outOfStockTemplate: CaseTemplate = {
  id: "product.out_of_stock",
  description: "The buy button of a sold-out product is disabled",
  appliesTo: (context) => (context.pageType === "listing" || context.pageType === "product_detail")
    && withPurpose(context.inventory, "add_to_cart").some((button) => button.attrs?.disabled),
  build: (context) => {
    // Sold out per the card/page stock text, or per the disabled button's own label ("Sold out").
    const button = withPurpose(context.inventory, "add_to_cart").find((candidate) => candidate.attrs?.disabled
      && (matchesAnyTerm(candidate.name, SOLD_OUT_TERMS)
        || (candidate.groupId ? inGroup(context.inventory, candidate.groupId) : context.inventory.elements).some(isOutOfStockText)));
    if (!button) return [];
    const name = productNameFor(context, button);
    return [{
      templateId: "product.out_of_stock", category: "negative", mandatory: true, targetElementId: button.id, inputVariant: "stock=0",
      titleTh: `สินค้าหมด${name ? ` "${name}"` : ""} กดซื้อไม่ได้`,
      steps: [],
      oracle: { kind: "elementDisabled", elementId: button.id },
      expectedResultTh: `ปุ่ม ${describe(button)} ของสินค้าที่หมดถูกปิดใช้งาน`,
    }];
  },
};

/** "Log in to buy" buttons on guest pages lead to login. */
export const buyRequiresLoginTemplate: CaseTemplate = {
  id: "auth.buy_requires_login",
  description: "A guest's buy button asks for login",
  appliesTo: (context) => context.inventory.urlIsStable
    && withPurpose(context.inventory, "add_to_cart").some((button) => isLoginish(button) && !button.attrs?.disabled),
  build: (context) => {
    const button = withPurpose(context.inventory, "add_to_cart").find((candidate) => isLoginish(candidate) && !candidate.attrs?.disabled)!;
    return [{
      templateId: "auth.buy_requires_login", category: "access_control", mandatory: false, targetElementId: button.id, inputVariant: "session=guest",
      titleTh: `ผู้ที่ยังไม่เข้าสู่ระบบกด "${button.name}" แล้วไปหน้าเข้าสู่ระบบ`,
      steps: [{ kind: "click", elementId: button.id }], loggedOut: true,
      oracle: { kind: "urlContains", fragment: "login" },
      expectedResultTh: "ระบบพาไปหน้าเข้าสู่ระบบ ไม่เพิ่มสินค้าลงตะกร้า",
    }];
  },
};

// ---------------------------------------------------------------------------------------------
// Cart

/** Priced rows that the user can change or remove (a filled cart). */
const cartRows = (context: TemplateContext): InventoryGroup[] => context.pageType !== "cart" ? [] :
  pricedGroups(context.inventory).filter((group) => inGroup(context.inventory, group.id).some((element) =>
    element.purpose === "remove_from_cart" || (element.purpose === "quantity" && element.interactive)));

const rowParts = (context: TemplateContext, group: InventoryGroup) => {
  const elements = inGroup(context.inventory, group.id);
  const prices = elements.filter((element) => element.purpose === "price");
  const unit = prices.find((price) => matchesAnyTerm(text(price), ["each", "per item", "/ea", "unit", "ต่อชิ้น", "ต่อหน่วย"])) ?? prices[0];
  const lineTotal = prices.length >= 2 ? prices[prices.length - 1] : undefined;
  const steppers = elements.filter((element) => element.purpose === "quantity" && element.role === "button");
  const plus = steppers.find((button) => /^(\+|plus)$/i.test(button.name.trim()) || matchesAnyTerm(button.name, ["increase", "increment", "เพิ่มจำนวน"]));
  const minus = steppers.find((button) => /^([-−–]|minus)$/i.test(button.name.trim()) || matchesAnyTerm(button.name, ["decrease", "decrement", "ลดจำนวน"]));
  const input = elements.find((element) => element.purpose === "quantity" && element.role !== "button" && element.interactive);
  // The quantity shown between stepper buttons is a bare number text.
  const qtyText = elements.find((element) => element.role === "text" && /^\d+$/.test((element.text ?? "").trim()));
  const remove = elements.find((element) => element.purpose === "remove_from_cart");
  const name = elements.find((element) => element.purpose === "product_name");
  return { elements, unit, lineTotal, plus, minus, input, qty: input ?? qtyText, remove, name, stock: stockIn(elements) };
};

export const cartTemplate: CaseTemplate = {
  id: "cart",
  description: "Line total, subtotal, remove, reload persistence and quantity steppers on a filled cart",
  appliesTo: (context) => cartRows(context).length > 0,
  build: (context) => {
    const rows = cartRows(context);
    const first = rowParts(context, rows[0]);
    const productName = rows[0].label;
    const drafts: CandidateDraft[] = [];

    if (first.unit && first.lineTotal && first.qty && (first.plus || first.input)) {
      drafts.push({
        templateId: "cart.line_total", category: "happy_path", mandatory: true, targetElementId: (first.plus ?? first.input)!.id, inputVariant: "quantity=2",
        titleTh: `เพิ่มจำนวน "${productName}" เป็น 2 แล้วยอดต่อรายการเท่ากับราคาต่อชิ้น × จำนวน`,
        steps: first.plus ? [{ kind: "click", elementId: first.plus.id }] : [{ kind: "fill", elementId: first.input!.id, value: "2" }],
        oracle: { kind: "lineTotalEquals", priceElementId: first.unit.id, qtyElementId: first.qty.id, lineTotalElementId: first.lineTotal.id },
        expectedResultTh: "ยอดต่อรายการ = ราคาต่อชิ้น × จำนวนใหม่",
      });
    }
    const subtotal = withPurpose(context.inventory, "subtotal")[0];
    if (rows.length >= 2 && subtotal && rows.every((row) => rowParts(context, row).lineTotal ?? rowParts(context, row).unit)) {
      drafts.push({
        templateId: "cart.subtotal", category: "happy_path", mandatory: true, targetElementId: subtotal.id, inputVariant: `rows=${rows.length}`,
        titleTh: "ยอดรวมของตะกร้าเท่ากับผลรวมยอดของทุกรายการ",
        steps: [],
        oracle: { kind: "subtotalEqualsSumOfLines", groupId: rows[0].id, subtotalElementId: subtotal.id },
        expectedResultTh: `${describe(subtotal)} เท่ากับผลรวมยอดต่อรายการของสินค้าทุกชิ้นในตะกร้า`,
      });
    }
    // The row's product name text, or (sites that put the name inside a button) the row's own remove button.
    const rowMarker = first.name ?? first.remove;
    if (first.remove && rowMarker) {
      drafts.push(rows.length >= 2 ? {
        templateId: "cart.remove_item", category: "happy_path", mandatory: true, targetElementId: first.remove.id, inputVariant: "remove=1",
        titleTh: `กด "${first.remove.name}" ที่ "${productName}" แล้วรายการนั้นหายไป`,
        steps: [{ kind: "click", elementId: first.remove.id }],
        oracle: { kind: "elementHidden", elementId: rowMarker.id },
        expectedResultTh: `"${productName}" ไม่อยู่ในตะกร้า ส่วนรายการอื่นยังอยู่`,
      } : {
        templateId: "cart.remove_last", category: "happy_path", mandatory: true, targetElementId: first.remove.id, inputVariant: "remove=last",
        titleTh: `ลบสินค้าชิ้นสุดท้าย "${productName}" แล้วตะกร้าว่าง`,
        steps: [{ kind: "click", elementId: first.remove.id }],
        oracle: { kind: "emptyStateShown" },
        expectedResultTh: "ตะกร้าว่างและแสดงข้อความว่าไม่มีสินค้า",
      });
    }
    if (rowMarker) {
      drafts.push({
        templateId: "cart.persist_reload", category: "happy_path", mandatory: false, targetElementId: rowMarker.id, inputVariant: "reload",
        titleTh: `โหลดหน้าใหม่แล้ว "${productName}" ยังอยู่ในตะกร้า`,
        steps: [],
        oracle: { kind: "persistsAfterReload", inner: { kind: "elementVisible", elementId: rowMarker.id } },
        expectedResultTh: "หลังโหลดหน้าใหม่ สินค้ายังอยู่ในตะกร้า",
      });
    }
    // Steppers (carts that change quantity with -/+ instead of an input).
    const qtyValue = first.qty?.role === "text" ? Number(first.qty.text) : undefined;
    if (first.minus?.attrs?.disabled) {
      drafts.push({
        templateId: "cart.stepper_min", category: "boundary", mandatory: true, targetElementId: first.minus.id, inputVariant: `quantity=${qtyValue ?? 1}`,
        titleTh: `ที่จำนวนต่ำสุด ปุ่ม "${first.minus.name}" ของ "${productName}" กดไม่ได้`,
        steps: [],
        oracle: { kind: "elementDisabled", elementId: first.minus.id },
        expectedResultTh: "จำนวนสินค้าลดต่ำกว่า 1 ไม่ได้",
      });
    }
    if (first.plus && first.stock !== undefined && qtyValue !== undefined && first.stock > qtyValue && first.stock - qtyValue <= 10) {
      const clicks = first.stock - qtyValue;
      drafts.push({
        templateId: "cart.stepper_max", category: "boundary", mandatory: false, targetElementId: first.plus.id, inputVariant: `quantity=${first.stock}`,
        titleTh: `เพิ่มจำนวน "${productName}" จนเท่าสต็อก (${first.stock}) แล้วปุ่ม "${first.plus.name}" กดไม่ได้`,
        steps: Array.from({ length: clicks }, (): StructuredStep => ({ kind: "click", elementId: first.plus!.id })),
        oracle: { kind: "elementDisabled", elementId: first.plus.id },
        expectedResultTh: `จำนวนสินค้าในตะกร้าเกินสต็อก ${first.stock} ไม่ได้`,
      });
    }
    return drafts;
  },
};

export const emptyCartCheckoutTemplate: CaseTemplate = {
  id: "cart.empty_checkout",
  description: "An empty cart cannot proceed to checkout",
  appliesTo: (context) => context.pageType === "cart" && cartRows(context).length === 0
    && context.inventory.elements.some((element) => element.role === "text" && matchesAnyTerm(text(element), EMPTY_STATE_TERMS)),
  build: (context) => {
    const checkout = withPurpose(context.inventory, "checkout_button")[0];
    const emptyText = context.inventory.elements.find((element) => element.role === "text" && matchesAnyTerm(text(element), EMPTY_STATE_TERMS))!;
    return [{
      templateId: "cart.empty_checkout", category: "negative", mandatory: false, targetElementId: (checkout ?? emptyText).id, inputVariant: "cart=empty",
      titleTh: checkout ? `ตะกร้าว่างแล้ว "${checkout.name}" ใช้ไม่ได้` : "ตะกร้าว่างไม่มีทางไปหน้าชำระเงิน",
      steps: [],
      oracle: checkout ? { kind: "elementDisabled", elementId: checkout.id } : { kind: "emptyStateShown" },
      expectedResultTh: checkout ? `ปุ่ม ${describe(checkout)} ถูกปิดใช้งานเมื่อไม่มีสินค้า` : "แสดงข้อความว่าตะกร้าว่าง และไม่มีปุ่มชำระเงิน",
    }];
  },
};

// ---------------------------------------------------------------------------------------------
// Checkout

const CHECKOUT_FIELD_PURPOSES = new Set(["name", "address", "phone", "postal_code", "email", "card_number"]);
const MAX_REQUIRED_FIELD_CASES = 8;

const checkoutFields = (context: TemplateContext): InventoryElement[] => context.pageType !== "checkout" ? [] :
  context.inventory.elements.filter((element) => ["textbox", "searchbox", "spinbutton"].includes(element.role) && element.interactive
    && !element.attrs?.disabled && (element.attrs?.required || CHECKOUT_FIELD_PURPOSES.has(element.purpose ?? "")));

export const checkoutTemplate: CaseTemplate = {
  id: "checkout",
  description: "Each required field empty, and a valid form up to (never past) the final confirmation",
  appliesTo: (context) => checkoutFields(context).length > 0,
  build: (context) => {
    const fields = checkoutFields(context);
    const submit = formSubmitFor(context, fields[0]);
    // Never click the final order button unless the job allows mutating tests.
    const clickable = submit && !submit.attrs?.disabled && (context.allowMutatingTests || !isFinalOrderButton(submit)) ? submit : undefined;
    const fillAll = (except?: InventoryElement): StructuredStep[] => fields.map((field): StructuredStep => ({
      kind: "fill", elementId: field.id, value: field.id === except?.id ? "" : validValueFor(field),
    }));
    const drafts: CandidateDraft[] = fields.slice(0, MAX_REQUIRED_FIELD_CASES).map((field): CandidateDraft => ({
      templateId: "checkout.required_fields", category: "validation", mandatory: true, targetElementId: field.id,
      inputVariant: `${field.purpose ?? "field"}=empty`,
      titleTh: `ชำระเงินโดยเว้น${fieldRef(field)} ว่าง`,
      steps: [...fillAll(field), ...(clickable ? [{ kind: "click", elementId: clickable.id } as StructuredStep] : [])],
      oracle: { kind: "validationMessageShown", elementId: field.id, ...(submit ? { submitElementId: submit.id } : {}) },
      expectedResultTh: `ไปต่อไม่ได้เมื่อ${fieldRef(field)} ว่าง: แสดงข้อความแจ้งเตือนหรือปุ่ม${submit ? ` "${submit.name}"` : "ยืนยัน"}ถูกปิดใช้งาน`,
    }));
    if (submit) {
      const oracle: Oracle = clickable ? { kind: "elementHidden", elementId: fields[0].id } : { kind: "elementEnabled", elementId: submit.id };
      drafts.push({
        templateId: "checkout.valid_until_confirm", category: "happy_path", mandatory: true, targetElementId: submit.id, inputVariant: "form=valid",
        titleTh: clickable ? `กรอกข้อมูลจัดส่งครบแล้วกด "${submit.name}" ไปขั้นถัดไป` : `กรอกข้อมูลจัดส่งครบแล้วปุ่ม "${submit.name}" พร้อมกด (ไม่กดยืนยันจริง)`,
        steps: [...fillAll(), ...(clickable ? [{ kind: "click", elementId: clickable.id } as StructuredStep] : [])],
        oracle,
        expectedResultTh: clickable ? "ระบบรับข้อมูลและไปขั้นตอนถัดไป" : `ปุ่ม ${describe(submit)} กดได้เมื่อข้อมูลครบ (ไม่กดเพื่อไม่ให้เกิดคำสั่งซื้อจริง)`,
      });
    }
    return drafts;
  },
};

/** Order summary arithmetic: total = subtotal + fees - discounts; a fee whose label states a rate is that rate. */
export const orderTotalsTemplate: CaseTemplate = {
  id: "checkout.totals",
  description: "Total equals subtotal plus fees minus discounts; a labelled tax rate is applied to the subtotal",
  appliesTo: (context) => (context.pageType === "checkout" || context.pageType === "cart")
    && withPurpose(context.inventory, "total").length > 0 && withPurpose(context.inventory, "subtotal").length > 0,
  build: (context) => {
    const total = withPurpose(context.inventory, "total")[0];
    const subtotal = withPurpose(context.inventory, "subtotal")[0];
    const fees = context.inventory.elements.filter((element) => element.role === "text" && !element.groupId
      && element.id !== total.id && element.id !== subtotal.id && MONEY_PATTERN.test(text(element))
      && matchesAnyTerm(text(element), ["tax", "vat", "shipping", "delivery", "fee", "ภาษี", "ค่าจัดส่ง", "ค่าส่ง", "ค่าธรรมเนียม", ...DISCOUNT_TERMS]));
    const discounts = fees.filter((fee) => matchesAnyTerm(text(fee), DISCOUNT_TERMS));
    const additions = fees.filter((fee) => !discounts.includes(fee));
    const drafts: CandidateDraft[] = [{
      templateId: "checkout.total_formula", category: "happy_path", mandatory: true, targetElementId: total.id, inputVariant: "total=sum",
      titleTh: `${describe(total)} เท่ากับ ${[describe(subtotal), ...additions.map(describe)].join(" + ")}${discounts.length ? ` - ${discounts.map(describe).join(" - ")}` : ""}`,
      steps: [],
      oracle: { kind: "totalEqualsSum", totalElementId: total.id, addElementIds: [subtotal.id, ...additions.map((fee) => fee.id)], subtractElementIds: discounts.map((fee) => fee.id) },
      expectedResultTh: "ยอดสุทธิคำนวณจากยอดสินค้า ค่าธรรมเนียม และส่วนลดที่แสดงได้ถูกต้อง",
    }];
    for (const fee of additions) {
      const rate = text(fee).match(/(\d+(?:\.\d+)?)\s*%/);
      if (!rate) continue;
      drafts.push({
        templateId: "checkout.tax_rate", category: "happy_path", mandatory: true, targetElementId: fee.id, inputVariant: `rate=${rate[1]}%`,
        titleTh: `${describe(fee)} เท่ากับ ${rate[1]}% ของ ${describe(subtotal)}`,
        steps: [],
        oracle: { kind: "percentageOf", elementId: fee.id, baseElementId: subtotal.id, percent: Number(rate[1]) },
        expectedResultTh: `${describe(fee)} = ${describe(subtotal)} × ${rate[1]}%`,
      });
    }
    return drafts;
  },
};

export const invalidCouponTemplate: CaseTemplate = {
  id: "coupon.invalid",
  description: "An invalid coupon code is rejected and the total does not change",
  appliesTo: (context) => withPurpose(context.inventory, "coupon").filter((element) => element.interactive && !element.attrs?.disabled),
  build: (context, field) => {
    if (!field) return [];
    const apply = safeSubmitFor(context, field);
    const total = withPurpose(context.inventory, "total")[0] ?? withPurpose(context.inventory, "subtotal")[0];
    return [{
      templateId: "coupon.invalid", category: "negative", mandatory: false, targetElementId: field.id, inputVariant: `coupon=${TEST_DATA.invalidCoupon}`,
      titleTh: `ใช้โค้ดส่วนลดที่ไม่มีอยู่ "${TEST_DATA.invalidCoupon}"`,
      steps: [{ kind: "fill", elementId: field.id, value: TEST_DATA.invalidCoupon }, ...(apply ? [{ kind: "click", elementId: apply.id } as StructuredStep] : [])],
      oracle: total ? { kind: "textUnchanged", elementId: total.id } : { kind: "validationMessageShown", elementId: field.id },
      expectedResultTh: total ? `ระบบไม่ยอมรับโค้ด และ ${describe(total)} ไม่เปลี่ยน` : "ระบบแจ้งว่าโค้ดไม่ถูกต้อง",
    }];
  },
};

// ---------------------------------------------------------------------------------------------
// Auth

const loginFields = (context: TemplateContext) => {
  if (context.pageType !== "login") return undefined;
  const password = withPurpose(context.inventory, "password").find((element) => element.interactive);
  const user = context.inventory.elements.find((element) => element.interactive && (element.purpose === "email" || element.purpose === "name"));
  const button = password ? (safeSubmitFor(context, password) ?? nearbyButtons(context.inventory, password).find(isLoginish)) : undefined;
  return password && user && button ? { password, user, button } : undefined;
};

export const loginTemplate: CaseTemplate = {
  id: "auth.login",
  description: "Wrong password stays on the form; the job's own account logs in",
  appliesTo: (context) => Boolean(loginFields(context)),
  build: (context) => {
    const { password, user, button } = loginFields(context)!;
    const drafts: CandidateDraft[] = [{
      templateId: "auth.login_invalid", category: "negative", mandatory: true, targetElementId: password.id, inputVariant: "password=wrong",
      titleTh: "เข้าสู่ระบบด้วยรหัสผ่านผิด", loggedOut: true,
      steps: [
        { kind: "fill", elementId: user.id, value: user.purpose === "email" ? TEST_DATA.email : "invalid_user" },
        { kind: "fill", elementId: password.id, value: TEST_DATA.wrongPassword },
        { kind: "click", elementId: button.id },
      ],
      oracle: { kind: "elementVisible", elementId: password.id },
      expectedResultTh: "เข้าสู่ระบบไม่สำเร็จ ยังอยู่ที่ฟอร์มเข้าสู่ระบบ และแสดงข้อความแจ้งเตือน",
    }];
    if (context.credentials.hasLogin) {
      drafts.push({
        templateId: "auth.login_valid", category: "happy_path", mandatory: true, targetElementId: button.id, inputVariant: "credentials=valid",
        titleTh: "เข้าสู่ระบบด้วยบัญชีทดสอบ", loggedOut: true,
        steps: [
          { kind: "fill", elementId: user.id, value: ENV_EMAIL },
          { kind: "fill", elementId: password.id, value: ENV_PASSWORD },
          { kind: "click", elementId: button.id },
        ],
        oracle: { kind: "elementHidden", elementId: password.id },
        expectedResultTh: "เข้าสู่ระบบสำเร็จและออกจากฟอร์มเข้าสู่ระบบ",
      });
    }
    return drafts;
  },
};

/** A page that needs a session hides its content from guests. */
export const protectedPageTemplate: CaseTemplate = {
  id: "auth.protected_page",
  description: "Open a login-only page without a session",
  appliesTo: (context) => Boolean(context.pageRequiresLogin) && context.inventory.urlIsStable,
  build: (context) => {
    const key = context.inventory.elements.find((element) => element.role === "heading" && element.region !== "header" && element.region !== "nav")
      ?? context.inventory.elements.find((element) => element.purpose === "checkout_button" || element.purpose === "add_to_cart" || element.purpose === "remove_from_cart");
    if (!key) return [];
    return [{
      templateId: "auth.protected_page", category: "access_control", mandatory: true, targetElementId: key.id, inputVariant: "session=none",
      titleTh: "เปิดหน้าที่ต้องเข้าสู่ระบบโดยไม่ได้เข้าสู่ระบบ", loggedOut: true,
      steps: [],
      oracle: { kind: "elementHidden", elementId: key.id },
      expectedResultTh: `ไม่เห็นเนื้อหาของหน้า (${describe(key)}) และระบบให้เข้าสู่ระบบก่อน`,
    }];
  },
};

export const SHOP_TEMPLATES: CaseTemplate[] = [
  addToCartTemplate,
  sortTemplate,
  filterTemplate,
  searchTemplate,
  outOfStockTemplate,
  buyRequiresLoginTemplate,
  cartTemplate,
  emptyCartCheckoutTemplate,
  checkoutTemplate,
  orderTotalsTemplate,
  invalidCouponTemplate,
  loginTemplate,
  protectedPageTemplate,
];

/** Money in any element of a group (exported for tests). */
export const groupHasPrice = (elements: InventoryElement[]): boolean => elements.some((element) => MONEY_PATTERN.test(text(element)));
export const amountOf = (element: InventoryElement): number | undefined => parseAmount(text(element));
