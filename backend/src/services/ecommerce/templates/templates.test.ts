import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyInventory } from "../elementClassifier.js";
import { classifyPageType } from "../pageClassifier.js";
import { buildInventory } from "../snapshotCompactor.js";
import type { CandidateCase, ElementInventory, InventoryElement, PageType } from "../types.js";
import { generateCandidates, isGuestSnapshot } from "./index.js";
import type { TemplateContext } from "./types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "..", "__fixtures__");
const fixture = (name: string): string => readFileSync(path.join(FIXTURES, `${name}.txt`), "utf8");

/** Same preparation as the pipeline: purposes -> page type -> purposes with the page type. */
const prepare = (snapshot: string): { inventory: ElementInventory; pageType: PageType } => {
  const first = classifyInventory(buildInventory(snapshot));
  const pageType = classifyPageType(first.inventory).pageType;
  return { inventory: classifyInventory({ ...first.inventory, pageType }, pageType).inventory, pageType };
};

const candidatesFor = (name: string, overrides: Partial<TemplateContext> = {}) => {
  const { inventory, pageType } = prepare(fixture(name));
  const context: TemplateContext = {
    inventory, pageType, allowMutatingTests: false, availablePreconditions: [], credentials: { hasLogin: true }, ...overrides,
  };
  const result = generateCandidates(context);
  const element = (id: string): InventoryElement => inventory.elements.find((candidate) => candidate.id === id)!;
  const byTemplate = (templateId: string) => result.candidates.filter((candidate) => candidate.templateId === templateId);
  return { ...result, inventory, pageType, element, byTemplate };
};

const clicks = (candidate: CandidateCase): string[] => candidate.steps.flatMap((step) => step.kind === "click" ? [step.elementId] : []);

// ---------------------------------------------------------------------------------------------
// 4a page types

test("page types of the captured fixtures", () => {
  const expected: Record<string, PageType> = {};
  for (const site of ["react-cart-web", "saucedemo"]) {
    for (const file of readdirSync(path.join(FIXTURES, site)).filter((name) => name.endsWith(".expected.json"))) {
      expected[`${site}/${file.replace(/\.expected\.json$/, "")}`] = JSON.parse(readFileSync(path.join(FIXTURES, site, file), "utf8")).pageType;
    }
  }
  Object.assign(expected, {
    "react-cart-web/register": "other",
    "react-cart-web/guest-home": "other",
    "react-cart-web/guest-product-detail-in-stock": "product_detail",
    "saucedemo/cart-empty": "cart",
    "saucedemo/cart-one-item": "cart",
  });
  for (const [name, pageType] of Object.entries(expected)) assert.equal(prepare(fixture(name)).pageType, pageType, name);
});

test("an SPA state without a meaningful URL is classified from its content", () => {
  const { inventory } = prepare(fixture("react-cart-web/cart-two-items"));
  const spa: ElementInventory = { ...inventory, pageUrl: "http://localhost:5173/", urlIsStable: false };
  assert.equal(classifyPageType(spa).pageType, "cart");
});

// ---------------------------------------------------------------------------------------------
// Listing and product pages

test("add to cart: a counting header badge gives countChangedBy(+1) and an add-twice variant", () => {
  const { byTemplate, element } = candidatesFor("saucedemo/inventory");
  const [add] = byTemplate("listing.add_to_cart");
  assert.equal(add.mandatory, true);
  assert.deepEqual(add.oracle, { kind: "countChangedBy", elementId: add.oracle.kind === "countChangedBy" ? add.oracle.elementId : "", delta: 1 });
  assert.equal(element((add.oracle as { elementId: string }).elementId).purpose, "cart_badge");
  assert.equal(element(add.targetElementId).groupId, "G1", "the representative card");
  assert.equal(byTemplate("listing.add_twice")[0].oracle.kind, "countChangedBy");
});

test("add to cart without a counter opens the cart and looks for the product (REACT_CART_WEB_PROFILE.md §6.3)", () => {
  const { byTemplate, element } = candidatesFor("react-cart-web/catalog");
  const [add] = byTemplate("listing.add_to_cart");
  assert.deepEqual(clicks(add).map((id) => element(id).name), ["เพิ่มลงตะกร้า", "ตะกร้าสินค้า"]);
  assert.deepEqual(add.oracle, { kind: "textVisible", text: "AirPods Pro 2 USB-C" });
  assert.equal(byTemplate("listing.add_twice").length, 0, "no counter: the double add cannot be checked");
});

test("sort: one case per recognized option, with field and direction", () => {
  const { byTemplate } = candidatesFor("saucedemo/inventory");
  assert.deepEqual(byTemplate("listing.sort").map((candidate) => candidate.oracle), [
    { kind: "sortedBy", groupId: "G1", field: "name", direction: "asc" },
    { kind: "sortedBy", groupId: "G1", field: "name", direction: "desc" },
    { kind: "sortedBy", groupId: "G1", field: "price", direction: "asc" },
    { kind: "sortedBy", groupId: "G1", field: "price", direction: "desc" },
  ]);
});

test("features a page lacks produce no cases (no sort, coupon or review on React-cart-web)", () => {
  for (const name of ["react-cart-web/catalog", "react-cart-web/guest-catalog", "react-cart-web/product-detail-in-stock", "react-cart-web/checkout-with-item"]) {
    const { candidates } = candidatesFor(name, { statePreconditionId: "seed_cart_one_item" });
    assert.ok(!candidates.some((candidate) => ["listing.sort", "coupon.invalid"].includes(candidate.templateId)), name);
  }
  // The category filter cannot be verified when the cards do not show the category.
  assert.equal(candidatesFor("react-cart-web/catalog").byTemplate("listing.filter").length, 0);
  // saucedemo has no search box.
  assert.ok(!candidatesFor("saucedemo/inventory").candidates.some((candidate) => candidate.templateId.startsWith("search.")));
});

test("search: visible product name, lower case, a term with no results, and empty", () => {
  const { byTemplate, element } = candidatesFor("react-cart-web/catalog");
  const [found] = byTemplate("search.found");
  assert.equal(element(found.targetElementId).purpose, "search");
  assert.deepEqual(found.oracle, { kind: "allItemsContain", groupId: "G1", text: "AirPods Pro 2 USB-C" });
  assert.deepEqual(found.steps, [{ kind: "fill", elementId: found.targetElementId, value: "AirPods Pro 2 USB-C" }], "instant search: no submit");
  assert.equal(byTemplate("search.case_insensitive")[0].inputVariant, "search=airpods pro 2 usb-c");
  assert.deepEqual(byTemplate("search.not_found")[0].oracle, { kind: "emptyStateShown" });
  assert.equal(byTemplate("search.not_found")[0].mandatory, true);
  assert.deepEqual(byTemplate("search.empty")[0].oracle, { kind: "countEquals", groupId: "G1", expected: 9 });
});

test("quantity input: equivalence classes and bounds from min/max, invalid ones submitted with add to cart", () => {
  const { byTemplate, element } = candidatesFor("react-cart-web/product-detail-in-stock");
  const variants = (templateId: string) => byTemplate(templateId).map((candidate) => candidate.inputVariant);
  assert.deepEqual(variants("num.valid"), ["quantity=2"]);
  assert.deepEqual(variants("num.min"), ["quantity=1"]);
  assert.deepEqual(variants("num.zero"), ["quantity=0"]);
  assert.deepEqual(variants("num.negative"), ["quantity=-1"]);
  assert.deepEqual(variants("num.max"), ["quantity=43"]);
  assert.deepEqual(variants("num.over_max"), ["quantity=44"]);
  assert.deepEqual(variants("num.empty"), ["quantity=empty"]);
  assert.equal(byTemplate("num.not_number").length, 0, "a number input cannot hold letters");
  const [zero] = byTemplate("num.zero");
  assert.equal(zero.mandatory, true);
  assert.equal(zero.oracle.kind, "validationMessageShown");
  assert.deepEqual(clicks(zero).map((id) => element(id).purpose), ["add_to_cart"]);
  assert.equal(byTemplate("num.valid")[0].steps.length, 1, "valid values are not added to the cart");
  assert.match(zero.titleTh, /^ใส่ 0 ในช่องจำนวน แล้วกด "เพิ่มลงตะกร้า"/);
});

test("sold-out products: the buy button is disabled; the disabled quantity input gets no input cases", () => {
  const detail = candidatesFor("react-cart-web/product-detail-out-of-stock");
  assert.deepEqual(detail.candidates.map((candidate) => candidate.templateId), ["product.out_of_stock"]);
  assert.equal(detail.candidates[0].oracle.kind, "elementDisabled");
  const listing = candidatesFor("react-cart-web/catalog").byTemplate("product.out_of_stock")[0];
  assert.equal(listing.titleTh, "สินค้าหมด \"ErgoFlex Pro Office Chair\" กดซื้อไม่ได้");
});

test("guest pages: every case starts logged out; a 'log in to buy' button leads to login", () => {
  const guest = candidatesFor("react-cart-web/guest-catalog");
  assert.ok(isGuestSnapshot({ inventory: guest.inventory } as TemplateContext));
  assert.ok(guest.candidates.every((candidate) => candidate.loggedOut));
  assert.deepEqual(guest.byTemplate("auth.buy_requires_login")[0].oracle, { kind: "urlContains", fragment: "login" });
  assert.equal(guest.byTemplate("listing.add_to_cart").length, 0, "guests cannot add to the cart directly");
  assert.ok(candidatesFor("react-cart-web/catalog").candidates.every((candidate) => !candidate.loggedOut || candidate.templateId.startsWith("auth.")));
});

// ---------------------------------------------------------------------------------------------
// Cart and checkout

test("filled carts need the precondition that produced them", () => {
  const without = candidatesFor("react-cart-web/cart-two-items");
  assert.equal(without.candidates.length, 0);
  assert.match(without.notes[0], /precondition/);
  const withRecipe = candidatesFor("react-cart-web/cart-two-items", { statePreconditionId: "seed_cart_two_items" });
  assert.ok(withRecipe.candidates.length > 0);
  assert.ok(withRecipe.candidates.every((candidate) => candidate.preconditionId === "seed_cart_two_items"));
});

test("cart with steppers: line total, subtotal, remove, reload and the minimum stepper", () => {
  const { byTemplate, element } = candidatesFor("react-cart-web/cart-two-items", { statePreconditionId: "seed_cart_two_items" });
  const [line] = byTemplate("cart.line_total");
  assert.equal(line.oracle.kind, "lineTotalEquals");
  if (line.oracle.kind === "lineTotalEquals") {
    assert.equal(element(line.oracle.priceElementId).text, "฿7,990 ต่อชิ้น");
    assert.equal(element(line.oracle.qtyElementId).text, "1");
    assert.equal(element(line.oracle.lineTotalElementId).text, "฿7,990");
  }
  assert.equal(element(clicks(line)[0]).name, "+");
  const [subtotal] = byTemplate("cart.subtotal");
  assert.equal(subtotal.oracle.kind === "subtotalEqualsSumOfLines" && element(subtotal.oracle.subtotalElementId).name, "ยอดรวม");
  const [remove] = byTemplate("cart.remove_item");
  assert.equal(remove.oracle.kind === "elementHidden" && element(remove.oracle.elementId).text, "AirPods Pro 2 USB-C");
  assert.equal(byTemplate("cart.stepper_min")[0].oracle.kind, "elementDisabled");
  assert.equal(byTemplate("cart.persist_reload")[0].oracle.kind, "persistsAfterReload");
  assert.equal(byTemplate("cart.stepper_max").length, 0, "stock 43 is too many clicks for a test");
});

test("a one-item cart removes the last item into the empty state; saucedemo rows use their own remove button", () => {
  const one = candidatesFor("react-cart-web/cart-one-item", { statePreconditionId: "seed_cart_one_item" });
  assert.deepEqual(one.byTemplate("cart.remove_last")[0].oracle, { kind: "emptyStateShown" });
  const sauce = candidatesFor("saucedemo/cart-two-items", { statePreconditionId: "seed_cart_two_items" });
  const [remove] = sauce.byTemplate("cart.remove_item");
  assert.equal(remove.oracle.kind === "elementHidden" && remove.oracle.elementId, remove.targetElementId);
  assert.equal(sauce.byTemplate("cart.line_total").length, 0, "one price per row: no line total to check");
});

test("an empty cart cannot go to checkout", () => {
  const { byTemplate } = candidatesFor("react-cart-web/cart-empty");
  assert.deepEqual(byTemplate("cart.empty_checkout")[0].oracle, { kind: "emptyStateShown" });
});

test("checkout: each required field empty, a valid form, totals; the final order button is never clicked", () => {
  const { byTemplate, element, candidates } = candidatesFor("react-cart-web/checkout-with-item", { statePreconditionId: "seed_cart_one_item" });
  const required = byTemplate("checkout.required_fields");
  assert.equal(required.length, 7);
  for (const candidate of required) {
    const empty = candidate.steps.filter((step) => step.kind === "fill" && step.value === "");
    assert.deepEqual(empty.map((step) => step.kind === "fill" && step.elementId), [candidate.targetElementId], "only the field under test is empty");
    assert.ok(candidate.oracle.kind === "validationMessageShown" && candidate.oracle.submitElementId);
  }
  const confirm = withPurposeName(element, "ยืนยันและชำระเงิน");
  assert.ok(candidates.every((candidate) => !clicks(candidate).includes(confirm)), "no case clicks the order button");
  assert.deepEqual(byTemplate("checkout.valid_until_confirm")[0].oracle, { kind: "elementEnabled", elementId: confirm });
  const [formula] = byTemplate("checkout.total_formula");
  assert.ok(formula.oracle.kind === "totalEqualsSum");
  if (formula.oracle.kind === "totalEqualsSum") {
    assert.equal(element(formula.oracle.totalElementId).name, "ยอดสุทธิ");
    assert.deepEqual(formula.oracle.addElementIds.map((id) => element(id).name), ["ยอดรวมสินค้า", "ค่าจัดส่ง", "ภาษี (7%)"]);
    assert.deepEqual(formula.oracle.subtractElementIds.map((id) => element(id).name), ["ส่วนลด"]);
  }
  const [tax] = byTemplate("checkout.tax_rate");
  assert.equal(tax.oracle.kind === "percentageOf" && tax.oracle.percent, 7);
  assert.equal(byTemplate("req.empty").length, 0, "checkout fields are covered by checkout.required_fields");
});

const withPurposeName = (element: (id: string) => InventoryElement, name: string): string => {
  for (let index = 1; index < 200; index += 1) {
    const candidate = element(`E${index}`);
    if (candidate?.name === name) return candidate.id;
  }
  throw new Error(`${name} not found`);
};

test("a multi-step checkout's Continue button is clicked; the overview gets the total formula", () => {
  const stepOne = candidatesFor("saucedemo/checkout-step-one", { statePreconditionId: "seed_cart_two_items" });
  const [valid] = stepOne.byTemplate("checkout.valid_until_confirm");
  assert.deepEqual(clicks(valid).map((id) => stepOne.element(id).name), ["Continue"]);
  assert.equal(valid.oracle.kind, "elementHidden");
  assert.deepEqual(stepOne.byTemplate("checkout.valid_until_confirm")[0].steps.filter((step) => step.kind === "fill").map((step) => step.kind === "fill" && step.value), ["Test", "User", "10110"]);
  const overview = candidatesFor("saucedemo/checkout-step-two", { statePreconditionId: "seed_cart_two_items" });
  const [formula] = overview.byTemplate("checkout.total_formula");
  assert.ok(formula.oracle.kind === "totalEqualsSum" && formula.oracle.addElementIds.length === 2);
  assert.ok(!overview.candidates.some((candidate) => clicks(candidate).some((id) => overview.element(id).name === "Finish")));
});

test("coupon: an invalid code keeps the total (synthetic page)", () => {
  const snapshot = [
    "### Page", "- Page URL: https://shop.example/cart", "### Snapshot", "```yaml",
    "- main [ref=e1]:",
    "  - heading \"Your cart\" [level=1] [ref=e2]",
    "  - textbox \"Promo code\" [ref=e3]",
    "  - button \"Apply\" [ref=e4]",
    "  - generic [ref=e5]:",
    "    - generic [ref=e6]: Subtotal",
    "    - generic [ref=e7]: $20.00",
    "  - generic [ref=e8]:",
    "    - generic [ref=e9]: Total",
    "    - generic [ref=e10]: $21.40",
    "```",
    "### Element Attributes", "```json",
    JSON.stringify([{ role: "textbox", name: "Promo code", tag: "input", formButtons: ["Apply"] }, { role: "button", name: "Apply", tag: "button" }]),
    "```",
  ].join("\n");
  const { inventory, pageType } = prepare(snapshot);
  const { candidates } = generateCandidates({ inventory, pageType, allowMutatingTests: false, availablePreconditions: [], credentials: { hasLogin: false } });
  const coupon = candidates.find((candidate) => candidate.templateId === "coupon.invalid")!;
  assert.deepEqual(coupon.steps.map((step) => step.kind), ["fill", "click"]);
  assert.equal(coupon.oracle.kind, "textUnchanged");
});

// ---------------------------------------------------------------------------------------------
// Login and access

test("login page: wrong password, the job's account from env, empty and malformed fields; all start logged out", () => {
  const { byTemplate, candidates } = candidatesFor("react-cart-web/login");
  assert.ok(candidates.every((candidate) => candidate.loggedOut));
  assert.equal(byTemplate("auth.login_invalid")[0].oracle.kind, "elementVisible");
  const valid = byTemplate("auth.login_valid")[0];
  assert.deepEqual(valid.steps.filter((step) => step.kind === "fill").map((step) => step.kind === "fill" && step.value), ["{{env.TEST_EMAIL}}", "{{env.TEST_PASSWORD}}"]);
  assert.equal(byTemplate("req.empty").length, 2);
  assert.deepEqual(byTemplate("email.invalid").map((candidate) => candidate.inputVariant), ["email=abc", "email=abc@"]);
  assert.equal(candidatesFor("react-cart-web/login", { credentials: { hasLogin: false } }).byTemplate("auth.login_valid").length, 0);
});

test("pages that need a session are opened without one", () => {
  const { byTemplate, element } = candidatesFor("react-cart-web/cart-empty", { pageRequiresLogin: true });
  const [guarded] = byTemplate("auth.protected_page");
  assert.equal(guarded.loggedOut, true);
  assert.equal(guarded.oracle.kind === "elementHidden" && element(guarded.oracle.elementId).name, "ตะกร้าสินค้า");
  assert.equal(candidatesFor("react-cart-web/cart-empty").byTemplate("auth.protected_page").length, 0);
});

// ---------------------------------------------------------------------------------------------
// Generator rules

test("candidates are numbered C1.. without duplicate (template, element, variant) keys", () => {
  const { candidates } = candidatesFor("react-cart-web/checkout-with-item", { statePreconditionId: "seed_cart_one_item" });
  assert.deepEqual(candidates.map((candidate) => candidate.id), candidates.map((_, index) => `C${index + 1}`));
  const keys = candidates.map((candidate) => `${candidate.templateId}|${candidate.targetElementId}|${candidate.inputVariant}`);
  assert.equal(new Set(keys).size, keys.length);
  for (const candidate of candidates) {
    assert.ok(candidate.titleTh && candidate.expectedResultTh, candidate.templateId);
    assert.ok(!/undefined|\[object/.test(`${candidate.titleTh} ${candidate.expectedResultTh}`), candidate.titleTh);
  }
});

test("template code contains no site-specific names, labels or prices (overfitting guard)", () => {
  const sources = [
    ...readdirSync(HERE).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts")).map((file) => path.join(HERE, file)),
    path.join(HERE, "..", "keywords.ts"),
    path.join(HERE, "..", "elementClassifier.ts"),
    path.join(HERE, "..", "pageClassifier.ts"),
    path.join(HERE, "..", "testData.ts"),
  ];
  // Generic shop words ("add to cart" / "เพิ่มลงตะกร้า") are allowed; product names, page titles, button labels
  // that only one site uses, URLs and prices are not.
  const siteSpecific = /AirPods|iPhone|Galaxy|MacBook|Dell XPS|ErgoFlex|Logitech|Sauce Labs|Swag Labs|saucedemo|Nimman|localhost:5173|เลือกซื้อสินค้า|ยืนยันและชำระเงิน|inventory-item|฿\d/;
  for (const source of sources) {
    const code = readFileSync(source, "utf8");
    const match = code.match(siteSpecific);
    assert.ok(!match, `${path.basename(source)} contains "${match?.[0]}"`);
  }
});
