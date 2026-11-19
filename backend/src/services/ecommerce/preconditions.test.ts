import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateGeneratedScript } from "../ollamaService.js";
import { classifyInventory } from "./elementClassifier.js";
import { classifyPageType } from "./pageClassifier.js";
import {
  addToCartTargets,
  allRemoveButtonsLocator,
  appendPreconditionSection,
  buildRecipe,
  parsePreconditionSection,
  type PageSnapshot,
} from "./preconditions.js";
import { SHARED_STATE_MARKER } from "./scriptCompiler.js";
import { buildInventory } from "./snapshotCompactor.js";
import { compileStoredCase } from "./storedCase.js";
import { generateCandidates } from "./templates/index.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");

const page = (name: string): PageSnapshot => {
  const snapshot = readFileSync(path.join(FIXTURES, `${name}.txt`), "utf8");
  const first = classifyInventory(buildInventory(snapshot));
  const pageType = classifyPageType(first.inventory).pageType;
  return { snapshot, inventory: classifyInventory({ ...first.inventory, pageType }, pageType).inventory };
};

const names = (listing: PageSnapshot, count: number) =>
  addToCartTargets(listing.inventory, count)?.map((element) => `${element.groupLabel ?? ""}:${element.name}`);

test("add targets: one button per product card, or the product page's own button", () => {
  assert.deepEqual(names(page("saucedemo/inventory"), 2), ["Sauce Labs Backpack:Add to cart", "Sauce Labs Bike Light:Add to cart"]);
  // The out-of-stock card's disabled "สินค้าหมด" button is never a target.
  const rcw = names(page("react-cart-web/catalog"), 9);
  assert.equal(rcw, undefined);
  assert.ok(names(page("react-cart-web/catalog"), 2)!.every((entry) => entry.endsWith(":เพิ่มลงตะกร้า")));
  assert.deepEqual(names(page("react-cart-web/product-detail-in-stock"), 1), [":เพิ่มลงตะกร้า"]);
  assert.equal(addToCartTargets(page("react-cart-web/product-detail-in-stock").inventory, 2), null, "one product page cannot give two products");
});

test("no recipe without an add button: login, out-of-stock product, guest catalog", () => {
  for (const name of ["react-cart-web/login", "react-cart-web/product-detail-out-of-stock", "react-cart-web/guest-catalog"]) {
    assert.equal(addToCartTargets(page(name).inventory, 1), null, name);
  }
});

test("the remove locator covers every row of the cart", () => {
  assert.equal(allRemoveButtonsLocator(page("react-cart-web/cart-two-items").inventory), "page.locator(\"article\").getByRole(\"button\", { name: \"ลบสินค้า\", exact: true })");
  assert.equal(allRemoveButtonsLocator(page("saucedemo/cart-two-items").inventory), "page.locator(\"[data-test=\\\"inventory-item\\\"]\").getByRole(\"button\", { name: \"Remove\", exact: true })");
  assert.equal(allRemoveButtonsLocator(page("react-cart-web/cart-empty").inventory), null);
  // One row is not a repeated group: its remove button still counts (found in the Phase 7 live run).
  assert.equal(allRemoveButtonsLocator(page("saucedemo/cart-one-item").inventory), "page.getByRole(\"button\", { name: \"Remove\", exact: true })");
});

test("a recipe empties the cart, adds N products and waits for N rows", () => {
  const recipe = buildRecipe("seed_cart_two_items", page("react-cart-web/catalog"), page("react-cart-web/cart-two-items"), "cart_with_2_items")!;
  const lines = recipe.lines;
  assert.equal(recipe.itemCount, 2);
  const at = (pattern: RegExp) => lines.findIndex((line) => pattern.test(line));
  const clearLoop = at(/^for \(let removed = 0;/);
  const toCatalog = at(/^await page\.goto\("http:\/\/localhost:5173\/products"\);$/);
  const adds = lines.filter((line) => /getByRole\("button", \{ name: "เพิ่มลงตะกร้า", exact: true \}\)\.click\(\);$/.test(line));
  assert.ok(at(/^await page\.goto\("http:\/\/localhost:5173\/cart"\);$/) < clearLoop);
  assert.ok(clearLoop < toCatalog && toCatalog < lines.indexOf(adds[0]));
  assert.ok(lines.lastIndexOf("await page.goto(\"http://localhost:5173/products\");") < lines.indexOf(adds[1]), "back to the listing before the second add");
  assert.equal(adds.length, 2);
  assert.match(adds[0], /filter\(\{ hasText: "AirPods Pro 2 USB-C" \}\)/);
  assert.notEqual(adds[0], adds[1]);
  // Each product is added, then the cart is opened with the page's cart link (no page load) and the new row
  // awaited before the next product: rapid adds can overwrite each other (found in the Phase 7 live run).
  for (const [index, add] of adds.entries()) {
    assert.equal(lines[lines.indexOf(add) + 1], "await page.getByRole(\"link\", { name: /^ตะกร้าสินค้า/ }).click();");
    assert.equal(lines[lines.indexOf(add) + 2], `await expect(removeButtons).toHaveCount(${index + 1}, { timeout: 15_000 });`);
  }
  assert.equal(lines.at(-2), "await page.goto(\"http://localhost:5173/cart\");");
  assert.equal(lines.at(-1), "await expect(removeButtons).toHaveCount(2, { timeout: 15_000 });");
  // Never an order/payment button or a login step.
  assert.doesNotMatch(lines.join("\n"), /ยืนยันและชำระเงิน|TEST_PASSWORD|เข้าสู่ระบบ/);
});

test("no recipe when the cart has no remove buttons to clear it with", () => {
  assert.equal(buildRecipe("seed_cart_one_item", page("saucedemo/inventory"), page("react-cart-web/cart-empty"), "cart_with_1_item"), null);
});

test("the precondition section round-trips and does not change the inventory", () => {
  const cart = page("saucedemo/cart-two-items");
  const recipe = buildRecipe("seed_cart_two_items", page("saucedemo/inventory"), cart, "cart_with_2_items")!;
  const withSection = appendPreconditionSection(cart.snapshot, recipe);
  assert.deepEqual(parsePreconditionSection(withSection), recipe);
  assert.equal(parsePreconditionSection(cart.snapshot), undefined);
  assert.equal(parsePreconditionSection(`${cart.snapshot}\n### Precondition\n\`\`\`json\n{"id":"other"}\n\`\`\``), undefined);
  assert.deepEqual(buildInventory(withSection), buildInventory(cart.snapshot));
});

test("cases planned on a state snapshot compile with the recipe first and the shared-state marker", () => {
  const cart = page("react-cart-web/cart-two-items");
  const recipe = buildRecipe("seed_cart_two_items", page("react-cart-web/catalog"), cart, "cart_with_2_items")!;
  const snapshot = appendPreconditionSection(cart.snapshot, recipe);
  const { candidates } = generateCandidates({
    inventory: cart.inventory, pageType: "cart", allowMutatingTests: false, availablePreconditions: [recipe.id],
    statePreconditionId: recipe.id, credentials: { hasLogin: true },
  });
  const subtotal = candidates.find((candidate) => candidate.templateId === "cart.subtotal")!;
  assert.equal(subtotal.preconditionId, "seed_cart_two_items");
  const compiled = compileStoredCase(subtotal.titleTh, { version: 1, steps: subtotal.steps, oracle: subtotal.oracle, preconditionId: subtotal.preconditionId }, snapshot);
  validateGeneratedScript(compiled.script);
  const body = compiled.script.split("\n").map((line) => line.trim());
  assert.equal(body[1], SHARED_STATE_MARKER);
  const recipeStart = body.indexOf("// Precondition seed_cart_two_items: empty the cart, then add 2 product(s)");
  const check = body.findIndex((line) => line.startsWith("await expect.poll(async () => checkSubtotal("));
  assert.ok(recipeStart > 0 && recipeStart < body.lastIndexOf("await expect(removeButtons).toHaveCount(2, { timeout: 15_000 });") && check > recipeStart);
});

// ---------------------------------------------------------------------------------------------
// capture plan (discovery)

const step = (name: string, pageId?: string) => ({ title: name, snapshot: readFileSync(path.join(FIXTURES, `${name}.txt`), "utf8"), ...(pageId ? { pageId } : {}) });

test("the capture plan uses a listing with add buttons, the cart page and the login page", async () => {
  const { planPreconditionCapture } = await import("./preconditionDiscovery.js");
  const { plan } = planPreconditionCapture([step("react-cart-web/login"), step("react-cart-web/catalog"), step("react-cart-web/cart-empty", "cart-page")]);
  assert.deepEqual(plan, {
    listingUrl: "http://localhost:5173/products",
    listingKind: "listing",
    cartUrl: "http://localhost:5173/cart",
    cartPageId: "cart-page",
    loginUrl: "http://localhost:5173/login",
  });
  // Without a cart snapshot, the cart link of the page chrome gives the URL.
  assert.equal(planPreconditionCapture([step("react-cart-web/catalog")]).plan?.cartUrl, "http://localhost:5173/cart");
  // A product page gives a one-product recipe only.
  assert.equal(planPreconditionCapture([step("react-cart-web/product-detail-in-stock")]).plan?.listingKind, "product_detail");
  assert.match(planPreconditionCapture([step("react-cart-web/login")]).reason ?? "", /no listing or product page/);
});

test("refOf finds the snapshot ref of an inventory element", async () => {
  const { classifySnapshot, refOf } = await import("./preconditionDiscovery.js");
  const catalog = classifySnapshot(step("react-cart-web/catalog").snapshot);
  const [add] = addToCartTargets(catalog.inventory, 1)!;
  assert.match(refOf(catalog.snapshot, add) ?? "", /^[a-z0-9]+$/);
});
