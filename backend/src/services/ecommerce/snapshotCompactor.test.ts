import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildInventory,
  compactSnapshotBudget,
  findPromptReferenceMisses,
  referencedLabels,
  findElement,
  navigationKeysOf,
  parseSnapshot,
  renderInventoryForPrompt,
  sequenceSimilarity,
} from "./snapshotCompactor.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const fixture = (name: string): string => readFileSync(path.join(FIXTURES, `${name}.txt`), "utf8");

interface Expected {
  pageType: string;
  compactor: {
    repeatedGroups: Array<{ count: number; containerHint?: string; firstLabel: string }>;
    mustKeep: string[];
  };
}

const expectedFixtures = (): Array<{ name: string; expected: Expected }> =>
  ["react-cart-web", "saucedemo"].flatMap((site) =>
    readdirSync(path.join(FIXTURES, site))
      .filter((file) => file.endsWith(".expected.json"))
      .map((file) => ({
        name: `${site}/${file.replace(/\.expected\.json$/, "")}`,
        expected: JSON.parse(readFileSync(path.join(FIXTURES, site, file), "utf8")) as Expected,
      })));

/** A listing snapshot with `count` identical product cards, for budget/grouping tests. */
const syntheticListing = (count: number, withFooter = true): string => {
  const cards = Array.from({ length: count }, (_, index) => [
    `        - article [ref=e${100 + index * 10}]:`,
    `          - link "Product ${index + 1}" [ref=e${101 + index * 10}] [cursor=pointer]:`,
    `            - /url: /products/p${index + 1}`,
    `            - img "Product ${index + 1}" [ref=e${102 + index * 10}]`,
    `          - paragraph [ref=e${103 + index * 10}]: Product ${index + 1}`,
    `          - paragraph [ref=e${104 + index * 10}]: A long marketing description of product ${index + 1} that goes on and on for many words`,
    `          - paragraph [ref=e${105 + index * 10}]: $${index + 10}.99`,
    `          - button "Add to cart" [ref=e${106 + index * 10}]`,
  ].join("\n"));
  return [
    "### Page",
    "- Page URL: https://shop.example/products",
    "- Page Title: Shop",
    "### Snapshot",
    "```yaml",
    "- generic [ref=e1]:",
    "  - banner [ref=e2]:",
    "    - link \"Home\" [ref=e3] [cursor=pointer]:",
    "      - /url: /",
    "    - link \"Cart\" [ref=e4] [cursor=pointer]:",
    "      - /url: /cart",
    "      - generic [ref=e5]: \"3\"",
    "    - navigation [ref=e6]:",
    "      - link \"Deals\" [ref=e7] [cursor=pointer]:",
    "        - /url: /deals",
    "      - link \"About us\" [ref=e8] [cursor=pointer]:",
    "        - /url: /about",
    "  - main [ref=e9]:",
    "    - heading \"Products\" [level=1] [ref=e10]",
    "    - generic [ref=e11]:",
    "      - generic [ref=e12]:",
    cards.join("\n"),
    "    - generic [ref=e90]:",
    "      - generic [ref=e91]: \"Subtotal:\"",
    "      - generic [ref=e92]: $0.00",
    "    - button \"Checkout\" [ref=e93]",
    ...(withFooter ? [
      "  - contentinfo [ref=e94]:",
      ...Array.from({ length: 12 }, (_, index) => [
        `    - link "Footer link ${index + 1}" [ref=e${95 + index}] [cursor=pointer]:`,
        `      - /url: /footer-${index + 1}`,
      ].join("\n")),
    ] : []),
    "```",
  ].join("\n");
};

test("parseSnapshot reads roles, names, attributes, inline text, props and Test IDs", () => {
  const parsed = parseSnapshot(fixture("saucedemo/inventory"));
  assert.equal(parsed.pageUrl, "https://www.saucedemo.com/inventory.html");
  assert.equal(parsed.pageTitle, "Swag Labs");
  assert.ok(parsed.testIds.some((entry) => entry.value === "inventory-item" && entry.count === 6 && entry.tag === "div"));

  const sort = parsed.nodes.find((node) => node.role === "combobox");
  assert.equal(sort?.name, "Sort products");
  assert.deepEqual(
    sort?.children.map((child) => parsed.nodes[child].name),
    ["Name (A to Z)", "Name (Z to A)", "Price (low to high)", "Price (high to low)"],
  );
  assert.equal(parsed.nodes[sort!.children[0]].attrs.selected, true);

  const rcw = parseSnapshot(fixture("react-cart-web/cart-one-item"));
  const minus = rcw.nodes.find((node) => node.role === "button" && node.name === "-");
  assert.equal(minus?.attrs.disabled, true);
  assert.match(minus?.ref ?? "", /e\d+$/);
  const quantity = rcw.nodes.find((node) => node.parent === minus?.parent && node.role === "generic");
  assert.equal(quantity?.text, "1", "quoted inline text is unquoted");
  const checkout = rcw.nodes.find((node) => node.name === "ดำเนินการชำระเงิน");
  assert.equal(checkout?.url, "/checkout");
});

test("parseSnapshot handles escaped quotes in names", () => {
  const parsed = parseSnapshot([
    "### Snapshot",
    "```yaml",
    "- button \"Kid's \\\"Pro\\\" shoe\" [ref=e1]",
    "- textbox \"Search\" [ref=e2]:",
    "  - /placeholder: Search products",
    "```",
  ].join("\n"));
  assert.equal(parsed.nodes[0].name, "Kid's \"Pro\" shoe");
  assert.equal(parsed.nodes[1].placeholder, "Search products");
});

for (const { name, expected } of expectedFixtures()) {
  test(`fixture ${name}: repeated groups and must-keep content survive compaction`, () => {
    const snapshot = fixture(name);
    const inventory = buildInventory(snapshot);

    const sets = [...new Set(inventory.groups.map((group) => group.setId))].map((setId) => {
      const members = inventory.groups.filter((group) => group.setId === setId);
      return { count: members[0].count, containerHint: members[0].containerHint, firstLabel: members[0].label };
    });
    assert.deepEqual(sets, expected.compactor.repeatedGroups);

    const prompt = renderInventoryForPrompt(inventory, 5000);
    for (const text of expected.compactor.mustKeep) assert.ok(prompt.includes(text), `${name}: "${text}" missing from\n${prompt}`);
    assert.ok(prompt.length < snapshot.length, "compact text is shorter than the full snapshot");
    assert.doesNotMatch(prompt, /\[ref=/, "MCP refs never reach the prompt");
  });
}

test("prices and totals that are plain text are kept as elements", () => {
  const cart = buildInventory(fixture("react-cart-web/cart-two-items"));
  const total = cart.elements.find((element) => element.name === "ยอดรวม");
  assert.equal(total?.text, "฿53,890");
  assert.equal(total?.interactive, false);
  const unitPrice = cart.elements.find((element) => element.text === "฿7,990 ต่อชิ้น");
  assert.equal(unitPrice?.groupId, "G1", "a cart row's unit price stays a separate element inside its group");

  const overview = buildInventory(fixture("saucedemo/checkout-step-two"));
  assert.ok(overview.elements.some((element) => element.text === "Total: $43.18"));
});

test("cart badge in the header is kept even when the rest of the header is cut", () => {
  const inventoryPage = buildInventory(fixture("saucedemo/inventory"));
  const nextPage = buildInventory(fixture("saucedemo/inventory-one-in-cart"), {
    previouslySentNavigation: new Set(navigationKeysOf(inventoryPage)),
  });
  const badge = nextPage.elements.find((element) => element.name === "Cart, 1 items");
  assert.equal(badge?.region, "header");
  assert.equal(badge?.text, "1");
  assert.equal(badge?.hiddenFromPrompt, undefined);
  assert.equal(nextPage.elements.find((element) => element.name === "Open Menu")?.hiddenFromPrompt, "seen_on_previous_page");

  // Budget pressure removes header/nav before the badge.
  const synthetic = buildInventory(syntheticListing(3, false));
  const fullLength = renderInventoryForPrompt(synthetic, 100_000).length;
  const tight = renderInventoryForPrompt(synthetic, fullLength - 1);
  assert.match(tight, /link "Cart" text="3"/);
  assert.doesNotMatch(tight, /"Deals"|"Home"/);
});

test("navigation already sent on an earlier page is hidden on the next page, dynamic items stay", () => {
  const catalog = buildInventory(fixture("react-cart-web/catalog"));
  const sent = new Set(navigationKeysOf(catalog));
  const cart = buildInventory(fixture("react-cart-web/cart-one-item"), { previouslySentNavigation: sent });

  const home = cart.elements.find((element) => element.role === "link" && element.name === "หน้าแรก");
  assert.equal(home?.region, "nav");
  assert.equal(home?.hiddenFromPrompt, "seen_on_previous_page");
  assert.equal(cart.elements.find((element) => element.name === "ตะกร้าสินค้า" && element.role === "link")?.hiddenFromPrompt, undefined);

  const prompt = renderInventoryForPrompt(cart, 5000);
  assert.doesNotMatch(prompt, /link "หน้าแรก"/);
  assert.match(prompt, /link "ตะกร้าสินค้า"/);
  assert.match(prompt, /ซ่อนเมนู\/ส่วนท้ายที่ส่งไปแล้วในหน้าก่อน \d+ รายการ/);
  // Hidden elements stay in the inventory (for locators/templates); only the prompt omits them.
  assert.ok(findElement(cart, home!.id));
});

test("20 product cards keep 3 groups plus an 'อีก 17 ชิ้น' line", () => {
  const inventory = buildInventory(syntheticListing(20));
  assert.deepEqual(inventory.groups.map((group) => group.label), ["Product 1", "Product 2", "Product 3"]);
  assert.ok(inventory.groups.every((group) => group.count === 20 && group.containerHint === "article"));
  assert.deepEqual(inventory.omittedRepeatedGroups.map(({ label, omittedCount }) => ({ label, omittedCount })), [{ label: "article", omittedCount: 17 }]);
  assert.ok(!inventory.elements.some((element) => element.text === "Product 4"));

  const prompt = renderInventoryForPrompt(inventory, 10_000);
  assert.match(prompt, /อีก 17 ชิ้นรูปแบบเดียวกับ G1/);
  assert.match(prompt, /G1 item "Product 1" \(1\/20\):/);
});

test("sourceLine points back to the element's line in the full snapshot", () => {
  for (const name of ["react-cart-web/checkout-with-item", "saucedemo/inventory", "react-cart-web/cart-two-items"]) {
    const snapshot = fixture(name);
    const lines = snapshot.split(/\r?\n/);
    for (const element of buildInventory(snapshot).elements) {
      const line = lines[element.sourceLine - 1];
      assert.ok(line, `${name} ${element.id}`);
      if (element.role !== "text") assert.match(line, new RegExp(`- ${element.role}\\b`), `${name} ${element.id}: ${line}`);
      if (element.interactive && element.name) assert.ok(line.includes(`"${element.name}"`), `${name} ${element.id}: ${line}`);
      if (element.role === "text" && !element.name && !element.textTruncated) assert.ok(line.includes(element.text ?? "\u0000"), `${name} ${element.id}: ${line}`);
    }
  }
});

test("output stays within maxChars and drops footer, then nav, then long text, then extra groups", () => {
  const inventory = buildInventory(syntheticListing(3));
  const full = renderInventoryForPrompt(inventory, 100_000);
  assert.match(full, /Footer link 12/);
  assert.match(full, /A long marketing description/);

  // Each budget is one char below the previous result, forcing exactly the next reduction step.
  // Footer goes first; the checkout button at the end of main is not cut.
  const withoutFooter = renderInventoryForPrompt(inventory, full.length - 1);
  assert.doesNotMatch(withoutFooter, /Footer link/);
  assert.match(withoutFooter, /"Deals"/);
  assert.match(withoutFooter, /A long marketing description/);
  assert.match(withoutFooter, /button "Checkout"/);

  // Then nav (long descriptions still there).
  const withoutNav = renderInventoryForPrompt(inventory, withoutFooter.length - 1);
  assert.doesNotMatch(withoutNav, /"Deals"|"Home"/);
  assert.match(withoutNav, /link "Cart" text="3"/);
  assert.match(withoutNav, /A long marketing description/);

  // Then long text; prices and every group still present.
  const noLongText = renderInventoryForPrompt(inventory, withoutNav.length - 1);
  assert.doesNotMatch(noLongText, /A long marketing description/);
  assert.match(noLongText, /G3 item "Product 3"/);
  assert.match(noLongText, /\$12\.99/);
  assert.match(noLongText, /button "Checkout"/);

  // Then only one representative group per repeated set.
  const oneGroup = renderInventoryForPrompt(inventory, noLongText.length - 1);
  assert.ok(oneGroup.length < noLongText.length);
  assert.match(oneGroup, /G1 item "Product 1"/);
  assert.doesNotMatch(oneGroup, /G2 item/);
  assert.match(oneGroup, /อีก 2 ชิ้นรูปแบบเดียวกับ G1/);
  assert.match(oneGroup, /"Subtotal: \$0\.00"/);
  assert.match(oneGroup, /button "Checkout"/);

  // Any budget is respected, even when whole lines must go.
  for (const maxChars of [400, 200, 80, 10]) {
    assert.ok(renderInventoryForPrompt(inventory, maxChars).length <= maxChars, `maxChars=${maxChars}`);
  }
});

test("real fixtures fit the planner's snapshot budget without tail truncation", () => {
  // generateNextTestPlan gives the snapshot ~45% of the remaining 14000-char prompt budget.
  const budget = Math.floor((14_000 - 2_500) * 0.45);
  for (const name of ["react-cart-web/catalog", "react-cart-web/checkout-with-item", "saucedemo/inventory", "saucedemo/checkout-step-two"]) {
    const prompt = renderInventoryForPrompt(buildInventory(fixture(name)), budget);
    assert.ok(prompt.length <= budget, name);
    assert.doesNotMatch(prompt, /ตัดอีก \d+ บรรทัด/, `${name} needed hard truncation`);
  }
});

test("containers that only share controls are not a repeated group", () => {
  // saucedemo checkout overview: the item list and the totals box both hold two buttons.
  const inventory = buildInventory(fixture("saucedemo/checkout-step-two"));
  assert.ok(!inventory.groups.some((group) => group.label === "Payment Information:"));
  assert.ok(sequenceSimilarity(["a", "b", "c"], ["a", "b", "c"]) === 1);
  assert.ok(sequenceSimilarity(["a", "b", "c", "d"], ["x", "y"]) === 0);
});

test("elements without accessible names keep role, placeholder and value for later classification", () => {
  const detail = buildInventory(fixture("react-cart-web/product-detail-in-stock"));
  const quantity = detail.elements.find((element) => element.role === "spinbutton");
  assert.equal(quantity?.name, "");
  assert.equal(quantity?.value, "1");
  assert.equal(quantity?.sectionHeading, "AirPods Pro 2 USB-C");

  const catalog = buildInventory(fixture("react-cart-web/guest-catalog"));
  const category = catalog.elements.find((element) => element.role === "combobox");
  assert.equal(category?.name, "");
  assert.equal(category?.value, "ทุกหมวดหมู่");
  assert.ok((category?.options?.length ?? 0) >= 4);
  assert.ok(catalog.elements.some((element) => element.role === "textbox" && element.name === "ค้นหาสินค้าด้วยชื่อ..."));
});

test("inventory defaults: navigationPath starts at the page URL and urlIsStable can be overridden", () => {
  const inventory = buildInventory(fixture("react-cart-web/cart-one-item"), { pageType: "cart", stateLabel: "cart_with_1_item" });
  assert.deepEqual(inventory.navigationPath, [{ kind: "goto", url: "http://localhost:5173/cart" }]);
  assert.equal(inventory.urlIsStable, true);
  assert.match(renderInventoryForPrompt(inventory, 5000), /^PAGE \/cart \| title: "ร้านค้าออนไลน์" \| type: cart \| state: cart_with_1_item/);

  const spa = buildInventory(fixture("react-cart-web/cart-one-item"), {
    urlIsStable: false,
    navigationPath: [{ kind: "goto", url: "http://localhost:5173/" }, { kind: "click", elementId: "E6" }],
  });
  assert.equal(spa.urlIsStable, false);
  assert.equal(spa.navigationPath.length, 2);
});

test("fixtures contain no credentials or real account data", () => {
  // Credentials are never written in tests; when present in env, check they did not leak into fixtures.
  const secrets = [process.env.TEST_EMAIL, process.env.TEST_PASSWORD, process.env.SAUCE_PASSWORD].filter((value): value is string => Boolean(value));
  for (const site of ["react-cart-web", "saucedemo"]) {
    for (const file of readdirSync(path.join(FIXTURES, site))) {
      const content = readFileSync(path.join(FIXTURES, site, file), "utf8");
      assert.doesNotMatch(content, /@(gmail|hotmail|outlook|yahoo|icloud)\.|password\s*[:=]/i, `${site}/${file}`);
      for (const secret of secrets) assert.ok(!content.includes(secret), `${site}/${file} contains a credential from env`);
    }
  }
});

test("referencedLabels and findPromptReferenceMisses separate compaction cuts from invented labels", () => {
  const labels = referencedLabels({
    targetElement: "Checkout",
    testSteps: ["คลิก 'Add to cart'", "กดปุ่ม \"Footer link 7\"", "ไปที่ “Wishlist”"],
    expectedResult: "แสดง 'Subtotal: $0.00'",
  });
  assert.deepEqual(labels, ["Checkout", "Add to cart", "Footer link 7", "Wishlist", "Subtotal: $0.00"]);

  const snapshot = syntheticListing(3);
  const prompt = renderInventoryForPrompt(buildInventory(snapshot), 600);
  assert.deepEqual(findPromptReferenceMisses(labels, prompt, snapshot), [
    { text: "Footer link 7", inFullSnapshot: true },
    { text: "Wishlist", inFullSnapshot: false },
  ]);
});

test("compactSnapshotBudget leaves room for the planner instructions", () => {
  assert.equal(compactSnapshotBudget(14_000), 4950);
  assert.equal(compactSnapshotBudget(2_000), 1000);
});
