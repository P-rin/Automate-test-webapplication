import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePlaywrightActions } from "../playwrightActionParser.js";
import { validateGeneratedScript } from "../ollamaService.js";
import { compileOracle, UnsupportedOracleError } from "./oracleCompiler.js";
import {
  compileCase,
  compileSteps,
  dynamicNameRegex,
  LocatorResolutionError,
  resolveLocator,
  valueExpression,
  type CompilableCase,
} from "./scriptCompiler.js";
import { buildInventory } from "./snapshotCompactor.js";
import type { ElementInventory, InventoryElement, Oracle } from "./types.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const page = (name: string) => {
  const snapshot = readFileSync(path.join(FIXTURES, `${name}.txt`), "utf8");
  const inventory = buildInventory(snapshot);
  const id = (predicate: (element: InventoryElement) => boolean): string => {
    const element = inventory.elements.find(predicate);
    assert.ok(element, `${name}: element not found`);
    return element.id;
  };
  return { snapshot, inventory, id, context: { inventory, fullSnapshot: snapshot } };
};
const named = (role: string, name: string, groupId?: string) => (element: InventoryElement) =>
  element.role === role && element.name === name && (groupId === undefined || element.groupId === groupId);

const rcwLogin = page("react-cart-web/login");
const loginCase: CompilableCase = {
  titleTh: "เข้าสู่ระบบด้วยบัญชีทดสอบ",
  steps: [
    { kind: "fill", elementId: rcwLogin.id(named("textbox", "อีเมล")), value: "{{env.TEST_EMAIL}}" },
    { kind: "fill", elementId: rcwLogin.id(named("textbox", "รหัสผ่าน")), value: "{{env.TEST_PASSWORD}}" },
    { kind: "click", elementId: rcwLogin.id(named("button", "เข้าสู่ระบบ")) },
  ],
  oracle: { kind: "urlContains", fragment: "/products" },
};

test("round-trip: basic steps parse back into the same MCP actions", () => {
  const compiled = compileCase(loginCase, rcwLogin.context);
  assert.equal(compiled.requiresPlaywrightEngine, false);
  assert.deepEqual(compiled.mcpUnsupported, []);
  const actions = parsePlaywrightActions(compiled.script, { TEST_EMAIL: "user@example.test", TEST_PASSWORD: "pw" });
  assert.deepEqual(actions, [
    { kind: "goto", url: "http://localhost:5173/login" },
    { kind: "fill", label: "อีเมล", labelIsRegex: false, role: "textbox", value: "user@example.test" },
    { kind: "fill", label: "รหัสผ่าน", labelIsRegex: false, role: "textbox", value: "pw" },
    { kind: "clickRole", role: "button", name: "เข้าสู่ระบบ", nameIsRegex: false },
    { kind: "assertUrl", expected: "\\/products", isRegex: true },
  ]);
});

test("login values come from env, never from literals", () => {
  const { script } = compileCase(loginCase, rcwLogin.context);
  assert.match(script, /\.fill\(process\.env\.TEST_EMAIL \?\? ''\);/);
  assert.match(script, /\.fill\(process\.env\.TEST_PASSWORD \?\? ''\);/);
  assert.equal(valueExpression("{{env.SAUCE_USERNAME}}"), "process.env.SAUCE_USERNAME ?? ''");
  assert.equal(valueExpression("{{env.bad name}}"), "\"{{env.bad name}}\"", "only valid env names are expanded");
});

test("compiled scripts pass validateGeneratedScript and follow the file rules", () => {
  const sauce = page("saucedemo/inventory");
  const scripts = [
    compileCase(loginCase, rcwLogin.context).script,
    compileCase({
      titleTh: "เรียงราคา",
      steps: [{ kind: "selectOption", elementId: sauce.id((element) => element.role === "combobox"), optionLabel: "Price (low to high)" }],
      oracle: { kind: "elementVisible", elementId: sauce.id(named("button", "Add to cart", "G2")) },
    }, sauce.context).script,
  ];
  for (const script of scripts) {
    validateGeneratedScript(script);
    assert.equal(script.match(/import \{ test, expect \} from '@playwright\/test';/g)?.length, 1);
    assert.equal(script.match(/\btest\(/g)?.length, 1);
    assert.doesNotMatch(script, /waitForTimeout|waitForSelector|page\.\$|\[ref=|browser_/);
  }
});

test("quotes in titles, names and values cannot break the file", () => {
  const snapshot = [
    "### Page",
    "- Page URL: https://shop.example/p/1",
    "### Snapshot",
    "```yaml",
    "- main [ref=e1]:",
    "  - heading \"Kid's \\\"Pro\\\" shoe\" [level=1] [ref=e2]",
    "  - textbox \"Note\" [ref=e3]",
    "  - button \"Add 'Kid\\\"s' to cart\" [ref=e4]",
    "```",
  ].join("\n");
  const inventory = buildInventory(snapshot);
  const button = inventory.elements.find((element) => element.role === "button")!;
  assert.equal(button.name, "Add 'Kid\"s' to cart");
  const compiled = compileCase({
    titleTh: "สั่ง 'Kid's \"Pro\"' shoe `x` ${y}",
    steps: [
      { kind: "fill", elementId: inventory.elements.find((element) => element.role === "textbox")!.id, value: "it's \"quoted\" \\ ${not}" },
      { kind: "click", elementId: button.id },
    ],
    oracle: { kind: "textVisible", text: "Kid's \"Pro\" shoe" },
  }, { inventory, fullSnapshot: snapshot });
  validateGeneratedScript(compiled.script);
  const actions = parsePlaywrightActions(compiled.script, {});
  assert.deepEqual(actions[1], { kind: "fill", label: "Note", labelIsRegex: false, role: "textbox", value: "it's \"quoted\" \\ ${not}" });
  assert.deepEqual(actions[2], { kind: "clickRole", role: "button", name: "Add 'Kid\"s' to cart", nameIsRegex: false });
});

test("Add to cart repeated in 6 cards is scoped by the card container and label", () => {
  const sauce = page("saucedemo/inventory");
  const locator = resolveLocator(sauce.id(named("button", "Add to cart", "G2")), sauce.inventory, sauce.snapshot);
  assert.equal(
    locator,
    "page.locator(\"[data-test=\\\"inventory-item\\\"]\").filter({ hasText: \"Sauce Labs Bike Light\" }).getByRole(\"button\", { name: \"Add to cart\", exact: true })",
  );

  const rcw = page("react-cart-web/catalog");
  assert.equal(
    resolveLocator(rcw.id(named("button", "เพิ่มลงตะกร้า", "G1")), rcw.inventory, rcw.snapshot),
    "page.locator(\"article\").filter({ hasText: \"AirPods Pro 2 USB-C\" }).getByRole(\"button\", { name: \"เพิ่มลงตะกร้า\", exact: true })",
  );
});

test("duplicates get .nth() counted the way Playwright matches: in the card, on the page, unnamed roles", () => {
  // Two identical "View details for ..." buttons (image + title) in one card.
  const sauce = page("saucedemo/inventory");
  const details = sauce.inventory.elements.filter((element) => element.groupId === "G1" && element.name.startsWith("View details"));
  assert.equal(details.length, 2);
  assert.match(resolveLocator(details[0].id, sauce.inventory, sauce.snapshot), /\.getByRole\("button", \{ name: "View details for Sauce Labs Backpack", exact: true \}\)\.nth\(0\)$/);
  assert.match(resolveLocator(details[1].id, sauce.inventory, sauce.snapshot), /\.nth\(1\)$/);

  // Unnamed buttons: getByRole("button") matches every button, so the index counts all of them.
  const detail = page("react-cart-web/product-detail-in-stock");
  const unnamed = detail.inventory.elements.filter((element) => element.role === "button" && !element.name);
  assert.equal(resolveLocator(unnamed[1].id, detail.inventory, detail.snapshot), "page.getByRole(\"button\").nth(1)");
  assert.equal(resolveLocator(detail.id((element) => element.role === "spinbutton"), detail.inventory, detail.snapshot), "page.getByRole(\"spinbutton\")");
});

test("combobox options are selected by label, never clicked", () => {
  const sauce = page("saucedemo/inventory");
  const lines = compileSteps([{ kind: "selectOption", elementId: sauce.id((element) => element.role === "combobox"), optionLabel: "Price (high to low)" }], sauce.context);
  assert.deepEqual(lines, ["await page.getByRole(\"combobox\", { name: \"Sort products\", exact: true }).selectOption({ label: \"Price (high to low)\" });"]);

  const rcw = page("react-cart-web/guest-catalog");
  const [unnamed] = compileSteps([{ kind: "selectOption", elementId: rcw.id((element) => element.role === "combobox"), optionLabel: "เกมมิ่ง" }], rcw.context);
  assert.equal(unnamed, "await page.getByRole(\"combobox\").selectOption({ label: \"เกมมิ่ง\" });");
});

test("textboxes without a name use the placeholder; text elements use getByText", () => {
  const snapshot = [
    "### Page", "- Page URL: https://shop.example/", "### Snapshot", "```yaml",
    "- main [ref=e1]:",
    "  - textbox [ref=e2]:",
    "    - /placeholder: Search products",
    "  - generic [ref=e3]:",
    "    - generic [ref=e4]: Subtotal",
    "    - generic [ref=e5]: $10.00",
    "  - paragraph [ref=e6]: No products match your search because nothing in the catalog contains that word",
    "```",
  ].join("\n");
  const inventory = buildInventory(snapshot);
  const locate = (predicate: (element: InventoryElement) => boolean) =>
    resolveLocator(inventory.elements.find(predicate)!.id, inventory, snapshot);
  assert.equal(locate((element) => element.role === "textbox"), "page.getByPlaceholder(\"Search products\", { exact: true })");
  assert.equal(locate((element) => element.name === "Subtotal"), "page.getByText(\"Subtotal\", { exact: true })");
  assert.equal(
    locate((element) => Boolean(element.textTruncated)),
    "page.getByText(\"No products match your search because nothing in the catalo\")",
    "truncated text matches by prefix, without the ellipsis",
  );
});

test("cart/account names in the header are matched by their stable prefix", () => {
  assert.equal(dynamicNameRegex("Cart, empty"), "/^Cart/");
  assert.equal(dynamicNameRegex("Cart, 1 items"), "/^Cart/");
  assert.equal(dynamicNameRegex("3"), "/^\\d+$/");
  const sauce = page("saucedemo/inventory-one-in-cart");
  assert.equal(
    resolveLocator(sauce.id((element) => element.name === "Cart, 1 items"), sauce.inventory, sauce.snapshot),
    "page.getByRole(\"button\", { name: /^Cart/ })",
  );
  // Product buttons with digits in their names are not dynamic.
  const rcw = page("react-cart-web/catalog");
  assert.match(resolveLocator(rcw.id((element) => element.role === "link" && element.name === "AirPods Pro 2 USB-C -11%"), rcw.inventory, rcw.snapshot), /name: "AirPods Pro 2 USB-C -11%", exact: true/);
});

test("precondition steps come first, then the page's navigation path, then the case steps", () => {
  const sauce = page("saucedemo/inventory");
  const precondition = { lines: ["await page.goto(\"https://www.saucedemo.com/\");", "await page.getByRole(\"button\", { name: \"Login\", exact: true }).click();"] };
  const compiled = compileCase({
    titleTh: "เพิ่มสินค้าลงตะกร้า",
    preconditionId: "logged_in",
    steps: [{ kind: "click", elementId: sauce.id(named("button", "Add to cart", "G1")) }],
    oracle: { kind: "elementHidden", elementId: sauce.id(named("button", "Add to cart", "G1")) },
  }, { ...sauce.context, preconditions: { logged_in: precondition } });
  const body = compiled.script.split("\n").filter((line) => line.startsWith("  ")).map((line) => line.trim());
  assert.deepEqual(body.slice(0, 3), [
    ...precondition.lines,
    "await page.goto(\"https://www.saucedemo.com/inventory.html\");",
  ]);
  assert.match(body[3], /Add to cart.*\.click\(\);$/);
  assert.match(body[4], /toBeHidden\(\);$/);

  assert.throws(() => compileCase({ titleTh: "x", preconditionId: "seed_cart_one_item", steps: [], oracle: { kind: "urlUnchanged" } }, sauce.context), LocatorResolutionError);
});

test("SPA pages: navigation path clicks are replayed and reloads re-navigate", () => {
  const rcw = page("react-cart-web/cart-one-item");
  const navLink = rcw.id(named("link", "ตะกร้าสินค้า"));
  const spa: ElementInventory = {
    ...rcw.inventory,
    urlIsStable: false,
    navigationPath: [{ kind: "goto", url: "http://localhost:5173/" }, { kind: "click", elementId: navLink }],
  };
  const compiled = compileCase({
    titleTh: "ตะกร้ายังมีสินค้าหลัง reload",
    steps: [],
    oracle: { kind: "persistsAfterReload", inner: { kind: "elementVisible", elementId: rcw.id(named("button", "ลบสินค้า")) } },
  }, { inventory: spa, fullSnapshot: rcw.snapshot });
  const body = compiled.script.split("\n").map((line) => line.trim());
  const reload = body.indexOf("await page.reload();");
  assert.ok(reload > 0);
  assert.match(body[1 + body.indexOf("await page.goto(\"http://localhost:5173/\");")], /ตะกร้าสินค้า.*\.click\(\);/);
  // After the reload the whole navigation path is replayed to reach the SPA state again.
  assert.equal(body[reload + 1], "await page.goto(\"http://localhost:5173/\");");
  assert.match(body[reload + 2], /ตะกร้าสินค้า.*\.click\(\);/);
  assert.match(body[reload + 3], /ลบสินค้า.*toBeVisible/);
  validateGeneratedScript(compiled.script);
});

test("oracles compile to web-first assertions; computed oracles wait for Phase 5", () => {
  const context = { locate: (id: string) => `page.getByRole("button", { name: ${JSON.stringify(id)} })`, startUrl: "https://shop.example/cart", renavigate: () => [] };
  const cases: Array<[Oracle, string]> = [
    [{ kind: "textVisible", text: "ไม่พบสินค้า" }, "await expect(page.getByText(\"ไม่พบสินค้า\").first()).toBeVisible();"],
    [{ kind: "elementDisabled", elementId: "E1" }, "await expect(page.getByRole(\"button\", { name: \"E1\" })).toBeDisabled();"],
    [{ kind: "elementEnabled", elementId: "E1" }, "await expect(page.getByRole(\"button\", { name: \"E1\" })).toBeEnabled();"],
    [{ kind: "elementHidden", elementId: "E1" }, "await expect(page.getByRole(\"button\", { name: \"E1\" })).toBeHidden();"],
    [{ kind: "inputValueEquals", elementId: "E1", expected: "2" }, "await expect(page.getByRole(\"button\", { name: \"E1\" })).toHaveValue(\"2\");"],
    [{ kind: "urlContains", fragment: "/cart?x=1" }, "await expect(page).toHaveURL(/\\/cart\\?x=1/);"],
    [{ kind: "urlUnchanged" }, "await expect(page).toHaveURL(\"https://shop.example/cart\");"],
  ];
  for (const [oracle, expected] of cases) assert.deepEqual(compileOracle(oracle, context).after, [expected]);
  for (const oracle of [
    { kind: "sortedBy", groupId: "G1", field: "price", direction: "asc" },
    { kind: "lineTotalEquals", priceElementId: "E1", qtyElementId: "E2", lineTotalElementId: "E3" },
    { kind: "countChangedBy", elementId: "E1", delta: 1 },
    { kind: "validationMessageShown", elementId: "E1" },
  ] as Oracle[]) {
    assert.throws(() => compileOracle(oracle, context), UnsupportedOracleError);
  }
});

test("unknown elements and empty titles are rejected", () => {
  assert.throws(() => resolveLocator("E999", rcwLogin.inventory, rcwLogin.snapshot), LocatorResolutionError);
  assert.throws(() => compileCase({ ...loginCase, titleTh: "  " }, rcwLogin.context), LocatorResolutionError);
});

test("scoped locators are flagged for the playwright engine", () => {
  const sauce = page("saucedemo/inventory");
  const compiled = compileCase({
    titleTh: "เพิ่มสินค้าชิ้นที่สอง",
    steps: [{ kind: "click", elementId: sauce.id(named("button", "Add to cart", "G2")) }],
    oracle: { kind: "urlUnchanged" },
  }, sauce.context);
  assert.equal(compiled.requiresPlaywrightEngine, true);
  assert.equal(compiled.mcpUnsupported.length, 1);
  assert.match(compiled.mcpUnsupported[0], /inventory-item/);
});
