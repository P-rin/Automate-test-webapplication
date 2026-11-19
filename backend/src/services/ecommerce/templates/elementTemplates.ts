/**
 * Group A templates (ECOMMERCE_TESTGEN_CONTEXT.md §4c): driven by the kind of element, usable on any site.
 * Invalid input is only "submitted" with a button that is safe under the mutation policy; when there is
 * none, the oracle relies on the field's own validity / the form's disabled submit button.
 */
import { ENV_PASSWORD, TEST_DATA, validValueFor } from "../testData.js";
import type { InventoryElement, StructuredStep } from "../types.js";
import {
  describe,
  fieldRef,
  formSubmitFor,
  groupOf,
  inGroup,
  isLoginish,
  nearbyButtons,
  safeSubmitFor,
  stockIn,
} from "./helpers.js";
import type { CandidateDraft, CaseTemplate, TemplateContext } from "./types.js";

const INPUT_ROLES = new Set(["textbox", "searchbox", "spinbutton"]);
const FORM_PURPOSES = new Set(["email", "password", "name", "phone", "address", "postal_code", "card_number"]);

/** Other inputs of the same form (same DOM form buttons, or same section) that must be valid for a single-field test. */
const formSiblings = (context: TemplateContext, field: InventoryElement): InventoryElement[] => {
  const signature = (element: InventoryElement) => (element.attrs?.formButtons ?? []).join("|");
  return context.inventory.elements.filter((other) => other.id !== field.id && other.interactive && INPUT_ROLES.has(other.role)
    && !other.attrs?.disabled && other.purpose !== "search"
    && (signature(field) ? signature(other) === signature(field) : other.sectionHeading === field.sectionHeading && other.region === field.region));
};

const siblingValue = (element: InventoryElement): string =>
  element.purpose === "password" ? ENV_PASSWORD : validValueFor(element);

/** Fill the other required fields validly, set the field under test, then submit when that is safe. */
const singleFieldSteps = (context: TemplateContext, field: InventoryElement, value: string): StructuredStep[] => {
  const submit = safeSubmitFor(context, field);
  return [
    ...formSiblings(context, field).filter((other) => other.attrs?.required || FORM_PURPOSES.has(other.purpose ?? ""))
      .map((other): StructuredStep => ({ kind: "fill", elementId: other.id, value: siblingValue(other) })),
    { kind: "fill", elementId: field.id, value },
    ...(submit ? [{ kind: "click", elementId: submit.id } as StructuredStep] : []),
  ];
};

const validationOracle = (context: TemplateContext, field: InventoryElement) => {
  const submit = formSubmitFor(context, field);
  return { kind: "validationMessageShown" as const, elementId: field.id, ...(submit ? { submitElementId: submit.id } : {}) };
};

const isLoginForm = (context: TemplateContext): boolean => context.pageType === "login";

// ---------------------------------------------------------------------------------------------

/** Number fields: valid, bounds, 0, -1, above max/stock, empty, not a number. */
export const numericTemplate: CaseTemplate = {
  id: "num",
  description: "Quantity/number inputs: equivalence classes and boundary values",
  appliesTo: (context) => context.inventory.elements.filter((element) =>
    element.purpose === "quantity" && element.role !== "button" && INPUT_ROLES.has(element.role) && !element.attrs?.disabled),
  build: (context, element) => {
    if (!element) return [];
    const min = element.attrs?.min !== undefined && Number.isFinite(Number(element.attrs.min)) ? Number(element.attrs.min) : 1;
    const group = groupOf(context.inventory, element);
    const stock = stockIn(group ? inGroup(context.inventory, group.id) : context.inventory.elements);
    const max = element.attrs?.max !== undefined && Number.isFinite(Number(element.attrs.max)) ? Number(element.attrs.max) : stock;
    // Invalid values are submitted with the page's add-to-cart button (where the app validates), never a login link.
    const buy = nearbyButtons(context.inventory, element).find((button) => button.purpose === "add_to_cart" && !button.attrs?.disabled && !isLoginish(button));
    const label = fieldRef(element);
    const valid = (templateId: string, value: number, category: CandidateDraft["category"], titleTh: string): CandidateDraft => ({
      templateId, category, mandatory: false, targetElementId: element.id, inputVariant: `quantity=${value}`,
      titleTh, steps: [{ kind: "fill", elementId: element.id, value: String(value) }],
      oracle: { kind: "inputValueEquals", elementId: element.id, expected: String(value) },
      expectedResultTh: `${label} รับค่า ${value} และแสดงค่า ${value}`,
    });
    const invalid = (templateId: string, value: string, category: CandidateDraft["category"], mandatory: boolean, why: string): CandidateDraft => ({
      templateId, category, mandatory, targetElementId: element.id, inputVariant: `quantity=${value === "" ? "empty" : value}`,
      titleTh: `ใส่${value === "" ? "ค่าว่าง" : ` ${value}`} ใน${label}${buy ? ` แล้วกด "${buy.name}"` : ""} (${why})`,
      steps: [{ kind: "fill", elementId: element.id, value }, ...(buy ? [{ kind: "click", elementId: buy.id } as StructuredStep] : [])],
      oracle: { kind: "validationMessageShown", elementId: element.id },
      expectedResultTh: `ระบบไม่ยอมรับจำนวน${value === "" ? "ว่าง" : ` ${value}`}: แสดงข้อความแจ้งเตือนหรือช่องไม่ผ่านการตรวจสอบ${buy ? " และไม่เพิ่มสินค้าลงตะกร้า" : ""}`,
    });

    const drafts: CandidateDraft[] = [];
    if (max === undefined || max >= 2) drafts.push(valid("num.valid", Math.max(2, min), "happy_path", `ใส่จำนวน ${Math.max(2, min)} ใน${label}`));
    drafts.push(valid("num.min", min, "boundary", `ใส่จำนวนต่ำสุดที่อนุญาต (${min}) ใน${label}`));
    if (min >= 1) drafts.push(invalid("num.zero", "0", "boundary", true, "ต่ำกว่าขั้นต่ำ"));
    drafts.push(invalid("num.negative", "-1", "negative", true, "ค่าติดลบ"));
    if (max !== undefined && max > min) drafts.push(valid("num.max", max, "boundary", `ใส่จำนวนสูงสุดที่อนุญาต (${max}) ใน${label}`));
    if (max !== undefined) drafts.push(invalid("num.over_max", String(max + 1), "boundary", true, `เกินสูงสุด ${max}`));
    drafts.push(invalid("num.empty", "", "validation", false, "ไม่ระบุจำนวน"));
    // A type=number input cannot hold letters (the browser rejects them), so only text inputs get this case.
    if (element.attrs?.type !== "number" && element.role !== "spinbutton") drafts.push(invalid("num.not_number", "abc", "negative", false, "ไม่ใช่ตัวเลข"));
    return drafts;
  },
};

/** Required fields left empty (filled fields are cleared first: some forms pre-fill from the profile). */
export const requiredEmptyTemplate: CaseTemplate = {
  id: "req.empty",
  description: "Leave one required field empty and submit when safe",
  appliesTo: (context) => context.pageType === "checkout" ? [] : context.inventory.elements.filter((element) =>
    INPUT_ROLES.has(element.role) && element.interactive && !element.attrs?.disabled && element.purpose !== "search" && element.purpose !== "quantity"
    && (element.attrs?.required || (isLoginForm(context) && FORM_PURPOSES.has(element.purpose ?? "")))),
  build: (context, element) => element ? [{
    templateId: "req.empty",
    category: "validation",
    mandatory: true,
    targetElementId: element.id,
    inputVariant: `${element.purpose ?? "field"}=empty`,
    titleTh: `ปล่อย${fieldRef(element)} ว่างแล้วส่งฟอร์ม`,
    steps: singleFieldSteps(context, element, ""),
    oracle: validationOracle(context, element),
    ...(isLoginForm(context) ? { loggedOut: true } : {}),
    expectedResultTh: `ระบบไม่ยอมรับเมื่อ${fieldRef(element)} ว่าง: แสดงข้อความแจ้งเตือนที่ช่อง หรือปุ่มส่งถูกปิดใช้งาน`,
  }] : [],
};

export const invalidEmailTemplate: CaseTemplate = {
  id: "email.invalid",
  description: "Malformed email addresses",
  appliesTo: (context) => context.inventory.elements.filter((element) => element.purpose === "email" && element.interactive && !element.attrs?.disabled),
  build: (context, element) => element ? TEST_DATA.invalidEmails.map((value): CandidateDraft => ({
    templateId: "email.invalid",
    category: "validation",
    mandatory: true,
    targetElementId: element.id,
    inputVariant: `email=${value}`,
    titleTh: `กรอกอีเมลรูปแบบไม่ถูกต้อง "${value}" ใน${fieldRef(element)}`,
    steps: singleFieldSteps(context, element, value),
    oracle: validationOracle(context, element),
    ...(isLoginForm(context) ? { loggedOut: true } : {}),
    expectedResultTh: `ระบบไม่ยอมรับอีเมล "${value}": แสดงข้อความแจ้งเตือนที่ช่อง หรือปุ่มส่งถูกปิดใช้งาน`,
  })) : [],
};

const FREE_TEXT_EXCLUDED = new Set(["email", "password", "search", "quantity", "phone", "postal_code", "card_number", "coupon"]);

/** Text longer than maxlength is cut at maxlength (only when the page declares maxlength: otherwise no oracle). */
export const longTextTemplate: CaseTemplate = {
  id: "text.long",
  description: "Text longer than maxlength",
  appliesTo: (context) => context.inventory.elements.filter((element) => element.role === "textbox" && element.interactive
    && !element.attrs?.disabled && element.attrs?.maxLength !== undefined && !FREE_TEXT_EXCLUDED.has(element.purpose ?? "")),
  build: (context, element) => {
    const maxLength = element?.attrs?.maxLength;
    if (!element || maxLength === undefined) return [];
    return [{
      templateId: "text.long",
      category: "boundary",
      mandatory: false,
      targetElementId: element.id,
      inputVariant: `length=${maxLength + 1}`,
      titleTh: `กรอกข้อความยาว ${maxLength + 1} ตัวอักษร (เกิน ${maxLength}) ใน${fieldRef(element)}`,
      steps: [{ kind: "fill", elementId: element.id, value: "a".repeat(maxLength + 1) }],
      oracle: { kind: "inputValueEquals", elementId: element.id, expected: "a".repeat(maxLength) },
      expectedResultTh: `${fieldRef(element)} เก็บข้อความได้ไม่เกิน ${maxLength} ตัวอักษร`,
    }];
  },
};

export const whitespaceTemplate: CaseTemplate = {
  id: "text.whitespace",
  description: "Only spaces in a required text field",
  appliesTo: (context) => context.inventory.elements.filter((element) => element.role === "textbox" && element.interactive
    && !element.attrs?.disabled && Boolean(element.attrs?.required) && !FREE_TEXT_EXCLUDED.has(element.purpose ?? "")),
  build: (context, element) => element ? [{
    templateId: "text.whitespace",
    category: "validation",
    mandatory: false,
    targetElementId: element.id,
    inputVariant: `${element.purpose ?? "field"}=whitespace`,
    titleTh: `กรอกช่องว่างล้วนใน${fieldRef(element)}`,
    steps: singleFieldSteps(context, element, TEST_DATA.whitespace),
    oracle: validationOracle(context, element),
    expectedResultTh: `ระบบไม่ยอมรับช่องว่างล้วนใน${fieldRef(element)}: แสดงข้อความแจ้งเตือนหรือปุ่มส่งถูกปิดใช้งาน`,
  }] : [],
};

/** Each option of a plain dropdown (sort/filter dropdowns have their own templates). */
export const selectEachTemplate: CaseTemplate = {
  id: "select.each",
  description: "Choose each option of a generic dropdown (up to 3)",
  appliesTo: (context) => context.inventory.elements.filter((element) => element.role === "combobox" && element.interactive
    && !element.attrs?.disabled && (element.options?.length ?? 0) > 1 && element.purpose !== "sort" && element.purpose !== "filter"),
  build: (context, element) => (element?.options ?? []).filter((option) => option !== element?.value).slice(0, 3).map((option): CandidateDraft => ({
    templateId: "select.each",
    category: "happy_path",
    mandatory: false,
    targetElementId: element!.id,
    inputVariant: `option=${option}`,
    titleTh: `เลือก "${option}" ใน ${describe(element!)}`,
    steps: [{ kind: "selectOption", elementId: element!.id, optionLabel: option }],
    oracle: { kind: "selectedOptionIs", elementId: element!.id, label: option },
    expectedResultTh: `${describe(element!)} แสดงตัวเลือก "${option}"`,
  })),
};

/** Buttons the page shows disabled (stepper and sold-out buttons have more specific templates). */
export const disabledButtonTemplate: CaseTemplate = {
  id: "button.disabled",
  description: "A disabled button cannot be used in this state",
  appliesTo: (context) => context.inventory.elements.filter((element) => element.role === "button" && element.attrs?.disabled
    && element.purpose !== "add_to_cart" && element.purpose !== "quantity"),
  build: (context, element) => element ? [{
    templateId: "button.disabled",
    category: "validation",
    mandatory: true,
    targetElementId: element.id,
    inputVariant: "state=disabled",
    titleTh: `ปุ่ม ${describe(element)} ถูกปิดใช้งานในสถานะนี้`,
    steps: [],
    oracle: { kind: "elementDisabled", elementId: element.id },
    expectedResultTh: `ปุ่ม ${describe(element)} แสดงอยู่แต่กดไม่ได้`,
  }] : [],
};

export const ELEMENT_TEMPLATES: CaseTemplate[] = [
  numericTemplate,
  requiredEmptyTemplate,
  invalidEmailTemplate,
  longTextTemplate,
  whitespaceTemplate,
  selectEachTemplate,
  disabledButtonTemplate,
];
