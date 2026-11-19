import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyInventory,
  decidePurpose,
  resolveAmbiguousPurposes,
  scoreElement,
  type AskLlm,
} from "./elementClassifier.js";
import { buildInventory, matchElementAttributes, parseElementAttributes, parseSnapshot } from "./snapshotCompactor.js";
import type { ElementInventory, InventoryElement } from "./types.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const fixture = (name: string): string => readFileSync(path.join(FIXTURES, `${name}.txt`), "utf8");

interface ExpectedPurpose { role: string; purpose: string; name?: string; text?: string; groupId?: string }

const findExpected = (inventory: ElementInventory, expected: ExpectedPurpose): InventoryElement | undefined =>
  inventory.elements.find((element) =>
    element.role === expected.role
    && (expected.name === undefined || element.name === expected.name)
    && (expected.text === undefined || element.text === expected.text || `${element.name}: ${element.text}` === expected.text)
    && (expected.groupId === undefined || element.groupId === expected.groupId));

/** Builds a snapshot with an Element Attributes section from a YAML body and DOM entries. */
const snapshotOf = (yaml: string[], attributes: object[] = [], url = "https://shop.example/page"): string => [
  "### Page",
  `- Page URL: ${url}`,
  "### Snapshot",
  "```yaml",
  ...yaml,
  "```",
  ...(attributes.length ? ["### Element Attributes", "```json", JSON.stringify(attributes), "```"] : []),
].join("\n");

const classify = (snapshot: string) => classifyInventory(buildInventory(snapshot));
const purposeOf = (snapshot: string, predicate: (element: InventoryElement) => boolean) => {
  const { inventory, decisions } = classify(snapshot);
  const element = inventory.elements.find(predicate);
  assert.ok(element, "element not found");
  return decisions.find((decision) => decision.elementId === element.id)!;
};

// ---------------------------------------------------------------------------------------------
// 3a: DOM attributes are parsed and matched to snapshot elements

test("element attributes are parsed and matched by role + name occurrence, then by remaining order", () => {
  const snapshot = snapshotOf([
    "- main [ref=e1]:",
    "  - button [ref=e2]",
    "  - button [ref=e3]",
    "  - button \"Add to cart\" [ref=e4]",
    "  - button \"Add to cart\" [ref=e5]",
    "  - textbox \"Email\" [ref=e6]",
  ], [
    { role: "button", name: "Image 1", tag: "button" },
    { role: "button", name: "Image 2", tag: "button" },
    { role: "button", name: "Add to cart", tag: "button", testId: "add-1" },
    { role: "button", name: "Add to cart", tag: "button", testId: "add-2" },
    { role: "textbox", name: "Email", tag: "input", type: "email", required: true, autocomplete: "email" },
  ]);
  assert.equal(parseElementAttributes(snapshot).length, 5);
  const inventory = buildInventory(snapshot);
  const byRef = (name: string, index: number) => inventory.elements.filter((element) => element.name === name)[index];
  assert.equal(byRef("Add to cart", 0).attrs?.testId, "add-1");
  assert.equal(byRef("Add to cart", 1).attrs?.testId, "add-2");
  assert.deepEqual(byRef("Email", 0).attrs, { tag: "input", type: "email", required: true, autocomplete: "email" });
  // The two unnamed buttons are paired with the two remaining button entries in order.
  assert.equal(inventory.elements[0].attrs?.tag, "button");
  assert.equal(inventory.elements[1].attrs?.tag, "button");

  assert.deepEqual(parseElementAttributes("### Element Attributes\n```json\n{broken\n```"), []);
  assert.equal(matchElementAttributes(parseSnapshot(snapshot).nodes, []).size, 0);
});

test("every interactive element of the captured fixtures gets its DOM attributes", () => {
  for (const site of ["react-cart-web", "saucedemo"]) {
    for (const file of readdirSync(path.join(FIXTURES, site)).filter((name) => name.endsWith(".txt"))) {
      const inventory = buildInventory(readFileSync(path.join(FIXTURES, site, file), "utf8"));
      const unmatched = inventory.elements.filter((element) => element.interactive && !element.attrs?.tag);
      assert.deepEqual(unmatched.map((element) => `${element.role} ${element.name}`), [], `${site}/${file}`);
    }
  }
});

test("attributes reach the compact prompt where they matter (type, min/max, required, multiline)", () => {
  const detail = buildInventory(fixture("react-cart-web/product-detail-in-stock"));
  const quantity = detail.elements.find((element) => element.role === "spinbutton")!;
  assert.deepEqual([quantity.attrs?.type, quantity.attrs?.min, quantity.attrs?.max], ["number", "1", "43"]);
  const checkout = buildInventory(fixture("react-cart-web/checkout-with-item"));
  const note = checkout.elements.find((element) => element.name === "หมายเหตุเพิ่มเติม")!;
  assert.equal(note.attrs?.tag, "textarea");
  assert.ok(checkout.elements.find((element) => element.name === "ชื่อผู้รับ")?.attrs?.required);
});

// ---------------------------------------------------------------------------------------------
// 3b: scoring on the document's example elements

test("a searchbox in the header is a search field", () => {
  const snapshot = snapshotOf([
    "- banner [ref=e1]:",
    "  - searchbox \"Search\" [ref=e2]",
    "  - button \"Go\" [ref=e3]",
  ], [
    { role: "searchbox", name: "Search", tag: "input", type: "search", formRole: "search", formButtons: ["Go"] },
    { role: "button", name: "Go", tag: "button" },
  ]);
  const decision = purposeOf(snapshot, (element) => element.role === "searchbox");
  assert.equal(decision.purpose, "search");
  assert.equal(decision.status, "rule");
});

test("a textarea under a Reviews heading with a Post button is a review field", () => {
  const snapshot = snapshotOf([
    "- main [ref=e1]:",
    "  - heading \"Customer Reviews\" [level=2] [ref=e2]",
    "  - textbox \"Your comment\" [ref=e3]",
    "  - button \"Post\" [ref=e4]",
  ], [
    { role: "textbox", name: "Your comment", tag: "textarea", formButtons: ["Post"] },
    { role: "button", name: "Post", tag: "button", type: "submit" },
  ]);
  assert.equal(purposeOf(snapshot, (element) => element.role === "textbox").purpose, "review_comment");
});

test("a spinbutton in a priced cart row is a quantity field", () => {
  const row = (index: number) => [
    `    - listitem [ref=e${index}0]:`,
    `      - paragraph [ref=e${index}1]: Product ${index}`,
    `      - paragraph [ref=e${index}2]: $1${index}.00`,
    `      - spinbutton "Qty" [ref=e${index}3]: \"1\"`,
    `      - button "Remove" [ref=e${index}4]`,
  ];
  const snapshot = snapshotOf([
    "- main [ref=e1]:",
    "  - list [ref=e2]:",
    ...row(1),
    ...row(2),
  ], [
    { role: "spinbutton", name: "Qty", tag: "input", type: "number", min: "1" },
    { role: "button", name: "Remove", tag: "button" },
    { role: "spinbutton", name: "Qty", tag: "input", type: "number", min: "1" },
    { role: "button", name: "Remove", tag: "button" },
  ]);
  const { inventory, decisions } = classify(snapshot);
  for (const element of inventory.elements.filter((candidate) => candidate.role === "spinbutton")) {
    assert.equal(decisions.find((decision) => decision.elementId === element.id)?.purpose, "quantity");
  }
  const remove = inventory.elements.find((element) => element.name === "Remove")!;
  assert.equal(decisions.find((decision) => decision.elementId === remove.id)?.purpose, "remove_from_cart");
});

test("an ambiguous 'Message' textarea goes to the LLM; no evidence at all stays generic without asking", () => {
  const snapshot = snapshotOf([
    "- main [ref=e1]:",
    "  - textbox \"Message\" [ref=e2]",
    "  - textbox \"Field 7\" [ref=e3]",
  ], [
    { role: "textbox", name: "Message", tag: "textarea" },
    { role: "textbox", name: "Field 7", tag: "input", type: "text" },
  ]);
  const message = purposeOf(snapshot, (element) => element.name === "Message");
  assert.equal(message.status, "ambiguous");
  assert.equal(message.purpose, "generic_text", "until resolved, the safe generic purpose is used");
  assert.deepEqual(message.candidates, ["review_comment"]);
  const plain = purposeOf(snapshot, (element) => element.name === "Field 7");
  assert.equal(plain.status, "no_evidence");
  assert.equal(plain.purpose, "generic_text");
});

test("a delivery-note textarea on checkout is not a review field", () => {
  const decision = purposeOf(fixture("react-cart-web/checkout-with-item"), (element) => element.name === "หมายเหตุเพิ่มเติม");
  assert.notEqual(decision.purpose, "review_comment");
  assert.ok((decision.scores.review_comment ?? 0) < 0);
});

test("Thai substrings do not leak: orders, 'all', 'mode' and product names with Plus", () => {
  const catalog = classify(fixture("react-cart-web/catalog"));
  const purpose = (predicate: (element: InventoryElement) => boolean) =>
    catalog.decisions.find((decision) => decision.elementId === catalog.inventory.elements.find(predicate)!.id)!.purpose;
  assert.equal(purpose((element) => element.name === "คำสั่งซื้อ"), "generic_button", "คำสั่งซื้อ contains ซื้อ but is order history");
  assert.equal(purpose((element) => element.name === "Dell XPS 13 Plus -8%"), "generic_button", "'Plus' in a product name is not a stepper");
  const detail = classify(fixture("react-cart-web/product-detail-in-stock"));
  const description = detail.inventory.elements.find((element) => element.text?.includes("โหมด"))!;
  assert.equal(detail.decisions.find((decision) => decision.elementId === description.id)?.purpose, "generic_text", "โหมด contains หมด");
});

test("page type is an extra clue, not a requirement", () => {
  const snapshot = fixture("saucedemo/cart-one-item");
  const remove = (pageType?: "cart") => {
    const inventory = buildInventory(snapshot);
    const element = inventory.elements.find((candidate) => candidate.name === "Remove")!;
    return decidePurpose(element, scoreElement(element, { inventory, pageType }));
  };
  assert.equal(remove().status, "ambiguous", "a lone cart row has no card evidence");
  assert.equal(remove("cart").purpose, "remove_from_cart");
});

for (const site of ["react-cart-web", "saucedemo"]) {
  for (const file of readdirSync(path.join(FIXTURES, site)).filter((name) => name.endsWith(".expected.json"))) {
    const expected = JSON.parse(readFileSync(path.join(FIXTURES, site, file), "utf8")) as { purposes?: ExpectedPurpose[] };
    if (!expected.purposes) continue;
    const name = `${site}/${file.replace(/\.expected\.json$/, "")}`;
    test(`fixture ${name}: element purposes`, () => {
      const { inventory, decisions } = classify(fixture(name));
      for (const item of expected.purposes!) {
        const element = findExpected(inventory, item);
        assert.ok(element, `${name}: ${JSON.stringify(item)} not found`);
        const decision = decisions.find((candidate) => candidate.elementId === element.id)!;
        assert.equal(decision.purpose, item.purpose, `${name}: ${JSON.stringify(item)} scored ${JSON.stringify(decision.scores)}`);
      }
    });
  }
}

// ---------------------------------------------------------------------------------------------
// 3c: LLM fallback

const ambiguousPage = snapshotOf(Array.from({ length: 7 }, (_, index) => `- textbox "Message ${index + 1}" [ref=e${index + 1}]`),
  Array.from({ length: 7 }, (_, index) => ({ role: "textbox", name: `Message ${index + 1}`, tag: "textarea" })));

test("ambiguous elements are asked in batches of at most 5 with an enum schema of their candidates", async () => {
  const calls: Array<{ prompt: string; schema: Record<string, any> }> = [];
  const ask: AskLlm = async (prompt, schema) => {
    calls.push({ prompt, schema: schema as Record<string, any> });
    const ids: string[] = (schema as any).properties.answers.items.properties.elementId.enum;
    return JSON.stringify({ answers: ids.map((elementId, index) => ({ elementId, purpose: index === 0 ? "review_comment" : "unknown" })) });
  };
  const result = await resolveAmbiguousPurposes(classify(ambiguousPage), ask);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].schema.properties.answers.items.properties.elementId.enum.length, 5);
  assert.deepEqual(calls[0].schema.properties.answers.items.properties.purpose.enum, ["review_comment", "unknown"]);
  assert.match(calls[0].prompt, /E1 textbox "Message 1" multiline/);
  assert.deepEqual(result.stats, { asked: 7, answered: 2, fallback: 5, failedCalls: 0 });
  const first = result.inventory.elements[0];
  assert.equal(first.purpose, "review_comment");
  assert.equal(result.inventory.elements[1].purpose, "generic_text", "unknown keeps the generic fallback");
});

test("a failed or invented LLM answer never assigns a purpose outside the element's candidates", async () => {
  const failing = await resolveAmbiguousPurposes(classify(ambiguousPage), async () => {
    throw new Error("Ollama timeout");
  });
  assert.equal(failing.stats.failedCalls, 2);
  assert.ok(failing.inventory.elements.every((element) => element.purpose === "generic_text"));

  const invented = await resolveAmbiguousPurposes(classify(ambiguousPage), async () =>
    JSON.stringify({ answers: [{ elementId: "E1", purpose: "coupon" }, { elementId: "E99", purpose: "review_comment" }] }));
  assert.equal(invented.inventory.elements[0].purpose, "generic_text");
  assert.equal(invented.stats.answered, 0);
});

test("pages without ambiguous elements make no LLM call", async () => {
  let calls = 0;
  const result = await resolveAmbiguousPurposes(classify(fixture("react-cart-web/checkout-with-item")), async () => {
    calls += 1;
    return "{}";
  });
  assert.equal(calls, 0);
  assert.equal(result.stats.asked, 0);
});
