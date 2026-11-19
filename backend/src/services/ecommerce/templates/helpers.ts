/** Shared helpers for templates: element lookup, Thai wording, safe submit buttons. */
import { matchesAnyTerm, MONEY_PATTERN } from "../keywords.js";
import type { ElementInventory, ElementPurpose, InventoryElement, InventoryGroup } from "../types.js";
import type { TemplateContext } from "./types.js";

export const LOGIN_TERMS = ["login", "log in", "sign in", "signin", "เข้าสู่ระบบ", "ลงชื่อเข้าใช้"];
/** Buttons that complete a purchase/payment/order: never clicked when allowMutatingTests=false. */
export const FINAL_ORDER_TERMS = ["place order", "confirm order", "pay", "pay now", "finish", "complete order", "submit order", "buy now", "ชำระเงิน", "ยืนยันคำสั่งซื้อ", "สั่งซื้อ", "ยืนยันการสั่งซื้อ"];
export const EMPTY_STATE_TERMS = ["empty", "no items", "no products", "no results", "nothing", "not found", "ว่าง", "ไม่มีสินค้า", "ไม่พบ", "ยังไม่มี"];

export const visible = (inventory: ElementInventory): InventoryElement[] => inventory.elements;

export const withPurpose = (inventory: ElementInventory, purpose: ElementPurpose): InventoryElement[] =>
  inventory.elements.filter((element) => element.purpose === purpose);

export const groupOf = (inventory: ElementInventory, element: InventoryElement): InventoryGroup | undefined =>
  element.groupId ? inventory.groups.find((group) => group.id === element.groupId) : undefined;

export const inGroup = (inventory: ElementInventory, groupId: string): InventoryElement[] =>
  inventory.elements.filter((element) => element.groupId === groupId);

/** First container of each repeated set (the representative card/row). */
export const representativeGroups = (inventory: ElementInventory): InventoryGroup[] =>
  inventory.groups.filter((group) => group.index === 1);

/** Cards/rows that show a price. */
export const pricedGroups = (inventory: ElementInventory): InventoryGroup[] =>
  inventory.groups.filter((group) => inGroup(inventory, group.id).some((element) => MONEY_PATTERN.test(`${element.name} ${element.text ?? ""}`)));

export const isLoginish = (element: InventoryElement): boolean => matchesAnyTerm(element.name, LOGIN_TERMS);
export const isFinalOrderButton = (element: InventoryElement): boolean => matchesAnyTerm(element.name, FINAL_ORDER_TERMS);

/** Thai wording for an element in titles: its label, or a noun from its purpose when it has none. */
export const describe = (element: InventoryElement): string => {
  if (element.name) return `"${element.name}"`;
  if (element.attrs?.placeholder) return `"${element.attrs.placeholder}"`;
  if (element.text) return `"${element.text.split(":")[0].trim()}"`;
  const nouns: Partial<Record<ElementPurpose, string>> = {
    search: "ช่องค้นหา",
    quantity: "ช่องจำนวน",
    filter: "ตัวกรอง",
    sort: "ตัวเรียงลำดับ",
    coupon: "ช่องคูปอง",
  };
  return nouns[element.purpose ?? "unknown"] ?? `${element.role}`;
};

/** "ช่อง "อีเมล"" for a labelled field, "ช่องจำนวน" for an unlabelled one (avoids "ช่อง ช่องจำนวน"). */
export const fieldRef = (element: InventoryElement): string => {
  const label = describe(element);
  return label.startsWith("\"") ? `ช่อง ${label}` : label;
};

/** The label to put in a candidate's targetElement-like texts (dedup + prompts). */
export const elementLabel = (element: InventoryElement): string =>
  element.name || element.attrs?.placeholder || `${element.purpose ?? element.role}`;

/** Buttons that act on a field: same DOM form first, then same card/row or same section. */
export const nearbyButtons = (inventory: ElementInventory, element: InventoryElement): InventoryElement[] => {
  const formNames = new Set(element.attrs?.formButtons ?? []);
  const buttons = inventory.elements.filter((other) => other.role === "button" && other.id !== element.id);
  const fromForm = buttons.filter((button) => formNames.has(button.name));
  const near = buttons.filter((button) => element.groupId
    ? button.groupId === element.groupId
    : !button.groupId && Boolean(element.sectionHeading) && button.sectionHeading === element.sectionHeading && button.region === element.region);
  return [...new Map([...fromForm, ...near].map((button) => [button.id, button])).values()];
};

/** A submit-like button for a field that is safe to click under the context's mutation policy. */
export const safeSubmitFor = (context: TemplateContext, element: InventoryElement): InventoryElement | undefined =>
  nearbyButtons(context.inventory, element).find((button) =>
    !button.attrs?.disabled && (context.allowMutatingTests || !isFinalOrderButton(button)));

/** The submit button of a field's form (even if unsafe/disabled), for "submit stays disabled" checks. */
export const formSubmitFor = (context: TemplateContext, element: InventoryElement): InventoryElement | undefined => {
  const buttons = nearbyButtons(context.inventory, element);
  return buttons.find((button) => button.attrs?.type === "submit") ?? buttons.find((button) => button.purpose === "checkout_button") ?? buttons[0];
};

/** Visible amount in an element (currency sign + "1,234.50" -> 1234.5). */
export const parseAmount = (value: string): number | undefined => {
  const match = value.match(/-?\d[\d,]*(?:\.\d+)?/);
  return match ? Number(match[0].replace(/,/g, "")) : undefined;
};

/** Stock number shown in a card/row/page ("คงเหลือ 43", "Only 3 left"). */
export const stockIn = (elements: InventoryElement[]): number | undefined => {
  for (const element of elements) {
    if (element.purpose !== "stock_status") continue;
    const amount = parseAmount(`${element.name} ${element.text ?? ""}`);
    if (amount !== undefined) return amount;
  }
  return undefined;
};

export const isOutOfStockText = (element: InventoryElement): boolean => {
  if (element.purpose !== "stock_status") return false;
  const text = `${element.name} ${element.text ?? ""}`;
  return parseAmount(text) === 0 || matchesAnyTerm(text, ["out of stock", "sold out", "unavailable", "สินค้าหมด", "หมดแล้ว", "หมดสต็อก"]);
};
