import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  availableStepKinds,
  buildExploratorySchema,
  buildPurposeSchema,
  buildSelectionSchema,
  MONEY_IN_EXPECTED_ISSUE,
  MONEY_IN_ORACLE_ISSUE,
  parseExploratoryResponse,
  parsePurposeResponse,
  parseSelectionResponse,
  promptElements,
  STATUS_NEW_CASE,
  STATUS_NO_MORE,
  type SchemaElement,
} from "./dynamicSchemas.js";
import { buildInventory } from "./snapshotCompactor.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const fixture = (name: string): string => readFileSync(path.join(FIXTURES, `${name}.txt`), "utf8");

type Schema = Record<string, unknown>;

/** Walks a schema: no empty enum anywhere, every object lists all properties as required and forbids extras. */
const assertWellFormed = (schema: Schema, where = "$"): void => {
  if (Array.isArray(schema.enum)) assert.ok(schema.enum.length > 0, `${where}: empty enum`);
  if (schema.type === "object") {
    const properties = schema.properties as Record<string, Schema>;
    assert.deepEqual(schema.required, Object.keys(properties), `${where}: required`);
    assert.equal(schema.additionalProperties, false, `${where}: additionalProperties`);
    for (const [key, child] of Object.entries(properties)) assertWellFormed(child, `${where}.${key}`);
  }
  if (schema.type === "array") assertWellFormed(schema.items as Schema, `${where}[]`);
};

const at = (schema: Schema, ...keys: string[]): Schema =>
  keys.reduce<Schema>((node, key) => (key === "[]" ? node.items : (node.properties as Record<string, Schema>)[key]) as Schema, schema);

// Cart fixture elements used across the exploratory tests (IDs are stable for a given snapshot).
const cart = buildInventory(fixture("react-cart-web/cart-two-items"));
const cartElements = promptElements(cart);
const byName = (role: string, name: string) => cart.elements.find((element) => element.role === role && element.name === name)!;
const plusButton = byName("button", "+");
const removeButton = byName("button", "ลบสินค้า");
const totalText = cart.elements.find((element) => element.name === "ยอดรวม")!;

const exploratory = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  titleTh: "เพิ่มจำนวนสินค้าแล้วปุ่มลบยังใช้งานได้",
  descriptionTh: "กด + ที่รายการแรก",
  category: "happy_path",
  requirementIds: ["AC-001"],
  targetElementId: plusButton.id,
  inputVariant: "quantity 1 -> 2",
  steps: [{ kind: "click", elementId: plusButton.id, value: "" }],
  oracle: { kind: "elementEnabled", elementId: removeButton.id, text: "" },
  expectedResultTh: "ปุ่มลบสินค้ายังกดได้",
  status: STATUS_NEW_CASE,
  ...overrides,
});

test("selection schema constrains candidate and AC IDs and asks for exactly one answer per candidate", () => {
  const schema = buildSelectionSchema(["C1", "C2", "C3", "C2"], ["AC-001", "AC-002"]);
  assertWellFormed(schema);
  assert.deepEqual(at(schema, "selections", "[]", "candidateId").enum, ["C1", "C2", "C3"]);
  assert.deepEqual(at(schema, "selections", "[]", "requirementIds", "[]").enum, ["AC-001", "AC-002"]);
  assert.equal(at(schema, "selections").minItems, 3);
  assert.equal(at(schema, "selections").maxItems, 3);
  assert.deepEqual(at(schema, "selections", "[]").required, ["candidateId", "keep", "requirementIds", "titleTh"]);
});

test("empty ID lists never produce enum: [] (no ACs -> requirementIds must be [])", () => {
  const noAcs = buildSelectionSchema(["C1"], []);
  assertWellFormed(noAcs);
  const requirementIds = at(noAcs, "selections", "[]", "requirementIds");
  assert.equal(requirementIds.maxItems, 0);
  assert.equal((requirementIds.items as Schema).enum, undefined);

  const noCandidates = buildSelectionSchema([], ["AC-001"]);
  assertWellFormed(noCandidates);
  assert.equal(at(noCandidates, "selections").maxItems, 0);

  const nothingToAct = buildExploratorySchema([{ id: "E1", role: "text", interactive: false }], []);
  assertWellFormed(nothingToAct);
  assert.deepEqual(at(nothingToAct, "status").enum, [STATUS_NO_MORE]);
  assert.equal(at(nothingToAct, "steps").maxItems, 0);
});

test("purpose schema always allows unknown and lists only the asked elements", () => {
  const schema = buildPurposeSchema(["search", "filter", "unknown", "quantity"], ["E11", "E12"]);
  assertWellFormed(schema);
  assert.deepEqual(at(schema, "answers", "[]", "purpose").enum, ["search", "filter", "quantity", "unknown"]);
  assert.deepEqual(at(schema, "answers", "[]", "elementId").enum, ["E11", "E12"]);
  assert.equal(at(schema, "answers").minItems, 2);
});

test("exploratory schema: steps act only on interactive elements, oracle may observe any element", () => {
  const schema = buildExploratorySchema(cartElements, ["AC-001"]);
  assertWellFormed(schema);
  const stepIds = at(schema, "steps", "[]", "elementId").enum as string[];
  const oracleIds = at(schema, "oracle", "elementId").enum as string[];
  assert.ok(stepIds.includes(plusButton.id));
  assert.ok(!stepIds.includes(totalText.id), "a total text is not something a step can act on");
  assert.ok(oracleIds.includes(totalText.id));
  assert.ok(oracleIds.includes(""), "text-only oracles leave elementId empty");
  assert.deepEqual(Object.keys(schema.properties as object).at(-1), "status", "status is decided last");
  // The cart has buttons and links only: no fill/select/tick kinds are offered.
  assert.deepEqual(at(schema, "steps", "[]", "kind").enum, ["click"]);
  assert.ok((at(schema, "oracle", "kind").enum as string[]).includes("urlContains"));

  const spa = buildExploratorySchema(cartElements, [], { allowUrlOracles: false, maxSteps: 3 });
  assert.ok(!(at(spa, "oracle", "kind").enum as string[]).some((kind) => kind.startsWith("url")));
  assert.equal(at(spa, "steps").maxItems, 3);
});

test("availableStepKinds follows the roles on the page", () => {
  const checkout = promptElements(buildInventory(fixture("react-cart-web/checkout-with-item")));
  assert.deepEqual(availableStepKinds(checkout), ["fill", "click", "tickCheckbox", "pressKey"]);
  const listing = promptElements(buildInventory(fixture("saucedemo/inventory")));
  assert.deepEqual(availableStepKinds(listing), ["click", "selectOption", "pressKey"]);
});

test("selection validator drops unknown IDs, keeps the first answer and fills defaults", () => {
  const candidates = [{ id: "C1", mandatory: false }, { id: "C2", mandatory: true }, { id: "C3", mandatory: false }, { id: "C4", mandatory: true }];
  const raw = JSON.stringify({
    selections: [
      { candidateId: "C9", keep: true, requirementIds: ["AC-001"], titleTh: "invented" },
      { candidateId: "C1", keep: true, requirementIds: ["AC-001", "AC-999", "AC-001"], titleTh: "  เปลี่ยนจำนวน   เป็น 2  " },
      { candidateId: "C1", keep: false, requirementIds: [], titleTh: "duplicate" },
      { candidateId: "C2", keep: false, requirementIds: ["AC-002"], titleTh: "" },
    ],
  });
  const result = parseSelectionResponse(raw, candidates, ["AC-001", "AC-002"]);
  assert.deepEqual(result.selections, [
    { candidateId: "C1", keep: true, requirementIds: ["AC-001"], titleTh: "เปลี่ยนจำนวน เป็น 2", source: "llm" },
    { candidateId: "C2", keep: true, requirementIds: ["AC-002"], titleTh: "", source: "llm", forcedByMandatory: true },
    { candidateId: "C3", keep: false, requirementIds: [], titleTh: "", source: "default" },
    { candidateId: "C4", keep: true, requirementIds: [], titleTh: "", source: "default" },
  ]);
  assert.ok(result.issues.some((issue) => issue.includes("C9")));
  assert.ok(result.issues.some((issue) => issue.includes("AC-999")));
  assert.ok(result.issues.some((issue) => issue.includes("duplicate answer for C1")));
  assert.ok(result.issues.some((issue) => issue.includes("no answer for C3, C4")));
});

test("selection validator survives broken output: mandatory kept, the rest dropped", () => {
  const candidates = [{ id: "C1", mandatory: true }, { id: "C2", mandatory: false }];
  for (const raw of ["not json", "{\"other\":1}", null, 42]) {
    const result = parseSelectionResponse(raw, candidates, ["AC-001"]);
    assert.deepEqual(result.selections.map((selection) => [selection.candidateId, selection.keep, selection.source]), [
      ["C1", true, "default"],
      ["C2", false, "default"],
    ]);
    assert.ok(result.issues.length > 0);
  }
});

test("purpose validator maps disallowed or missing answers to unknown", () => {
  const raw = { answers: [
    { elementId: "E11", purpose: "search" },
    { elementId: "E12", purpose: "coupon" },
    { elementId: "E99", purpose: "search" },
  ] };
  const result = parsePurposeResponse(raw, ["E11", "E12", "E13"], ["search", "filter"]);
  assert.deepEqual([...result.purposes], [["E11", "search"], ["E12", "unknown"], ["E13", "unknown"]]);
  assert.ok(result.issues.some((issue) => issue.includes("E99")));
});

test("exploratory validator converts a valid answer into structured steps and an oracle", () => {
  const result = parseExploratoryResponse(exploratory(), { elements: cartElements, acIds: ["AC-001"] });
  assert.equal(result.status, "case");
  if (result.status !== "case") return;
  assert.deepEqual(result.case.steps, [{ kind: "click", elementId: plusButton.id }]);
  assert.deepEqual(result.case.oracle, { kind: "elementEnabled", elementId: removeButton.id });
  assert.equal(result.case.category, "happy_path");
  assert.deepEqual(result.issues, []);

  const noMore = parseExploratoryResponse(exploratory({ status: STATUS_NO_MORE }), { elements: cartElements, acIds: [] });
  assert.equal(noMore.status, "done");
});

test("exploratory validator rejects invented elements and steps that cannot act on the element", () => {
  const context = { elements: cartElements, acIds: ["AC-001"] };
  const invented = parseExploratoryResponse(exploratory({ steps: [{ kind: "click", elementId: "E999", value: "" }] }), context);
  assert.equal(invented.status, "invalid");
  assert.ok(invented.issues.some((issue) => issue.includes("E999")));

  // Seen with qwen3.5:4b: a step used to "check" a total text.
  const checkText = parseExploratoryResponse(exploratory({ steps: [{ kind: "tickCheckbox", elementId: totalText.id, value: "฿15,980" }] }), context);
  assert.equal(checkText.status, "invalid");
  const fillButton = parseExploratoryResponse(exploratory({ steps: [{ kind: "fill", elementId: plusButton.id, value: "2" }] }), context);
  assert.equal(fillButton.status, "invalid");

  const badTarget = parseExploratoryResponse(exploratory({ targetElementId: "E0" }), context);
  assert.equal(badTarget.status, "invalid");
  const noSteps = parseExploratoryResponse(exploratory({ steps: [] }), context);
  assert.equal(noSteps.status, "invalid");
  const noTitle = parseExploratoryResponse(exploratory({ titleTh: " " }), context);
  assert.equal(noTitle.status, "invalid");
  const tooMany = parseExploratoryResponse(exploratory({ steps: Array.from({ length: 4 }, () => ({ kind: "click", elementId: plusButton.id, value: "" })) }), { ...context, maxSteps: 3 });
  assert.equal(tooMany.status, "invalid");
  assert.equal(parseExploratoryResponse("{broken", context).status, "invalid");
  assert.equal(parseExploratoryResponse(exploratory({ status: "maybe" }), context).status, "invalid");
});

test("exploratory validator checks oracle targets and URL oracles", () => {
  const context = { elements: cartElements, acIds: [] };
  const disabledText = parseExploratoryResponse(exploratory({ oracle: { kind: "elementDisabled", elementId: totalText.id, text: "" } }), context);
  assert.equal(disabledText.status, "invalid");
  const inputValueOnButton = parseExploratoryResponse(exploratory({ oracle: { kind: "inputValueEquals", elementId: plusButton.id, text: "2" } }), context);
  assert.equal(inputValueOnButton.status, "invalid");
  const emptyText = parseExploratoryResponse(exploratory({ oracle: { kind: "textVisible", elementId: "", text: "" } }), context);
  assert.equal(emptyText.status, "invalid");

  const url = exploratory({ oracle: { kind: "urlContains", elementId: "", text: "/cart" } });
  const urlResult = parseExploratoryResponse(url, context);
  assert.equal(urlResult.status, "case");
  if (urlResult.status === "case") assert.deepEqual(urlResult.case.oracle, { kind: "urlContains", fragment: "/cart" });
  assert.equal(parseExploratoryResponse(url, { ...context, allowUrlOracles: false }).status, "invalid");
});

test("exploratory validator flags amounts the model computed, drops unknown ACs and fixes category", () => {
  const result = parseExploratoryResponse(exploratory({
    requirementIds: ["AC-999"],
    category: "boundary",
    oracle: { kind: "textVisible", elementId: totalText.id, text: "฿61,870" },
    expectedResultTh: "ยอดรวมเป็น ฿61,870",
  }), { elements: cartElements, acIds: ["AC-001"] });
  assert.equal(result.status, "case");
  if (result.status !== "case") return;
  assert.deepEqual(result.case.requirementIds, []);
  assert.equal(result.case.category, "exploratory", "no AC means exploratory, like the legacy planner");
  assert.ok(result.issues.some((issue) => issue.startsWith(MONEY_IN_ORACLE_ISSUE)));
  assert.ok(result.issues.some((issue) => issue.startsWith(MONEY_IN_EXPECTED_ISSUE)));
  assert.ok(result.issues.some((issue) => issue.includes("AC-999")));
});

test("selectOption must name an existing option and tick/fill map to structured steps", () => {
  const listing = promptElements(buildInventory(fixture("saucedemo/inventory")));
  const sort = listing.find((element) => element.role === "combobox")!;
  const button = listing.find((element) => element.role === "button" && element.name === "Add to cart")!;
  const answer = (value: string) => JSON.stringify({
    titleTh: "เรียงราคา", descriptionTh: "", category: "happy_path", requirementIds: [], targetElementId: sort.id, inputVariant: value,
    steps: [{ kind: "selectOption", elementId: sort.id, value }],
    oracle: { kind: "elementVisible", elementId: button.id, text: "" }, expectedResultTh: "", status: STATUS_NEW_CASE,
  });
  const ok = parseExploratoryResponse(answer("Price (low to high)"), { elements: listing, acIds: [] });
  assert.equal(ok.status, "case");
  if (ok.status === "case") assert.deepEqual(ok.case.steps, [{ kind: "selectOption", elementId: sort.id, optionLabel: "Price (low to high)" }]);
  assert.equal(parseExploratoryResponse(answer("Cheapest first"), { elements: listing, acIds: [] }).status, "invalid");

  const form: SchemaElement[] = [
    { id: "E1", role: "textbox", interactive: true },
    { id: "E2", role: "checkbox", interactive: true },
    { id: "E3", role: "button", interactive: true },
  ];
  const formResult = parseExploratoryResponse(JSON.stringify({
    titleTh: "สมัครโดยไม่ยอมรับเงื่อนไข", descriptionTh: "", category: "negative", requirementIds: [], targetElementId: "E3", inputVariant: "",
    steps: [
      { kind: "fill", elementId: "E1", value: "" },
      { kind: "tickCheckbox", elementId: "E2", value: "" },
      { kind: "untickCheckbox", elementId: "E2", value: "" },
      { kind: "pressKey", elementId: "E1", value: "Enter" },
    ],
    oracle: { kind: "validationMessageShown", elementId: "E1", text: "" }, expectedResultTh: "", status: STATUS_NEW_CASE,
  }), { elements: form, acIds: [] });
  assert.equal(formResult.status, "case");
  if (formResult.status === "case") {
    assert.deepEqual(formResult.case.steps, [
      { kind: "fill", elementId: "E1", value: "" },
      { kind: "check", elementId: "E2" },
      { kind: "uncheck", elementId: "E2" },
      { kind: "press", elementId: "E1", key: "Enter" },
    ]);
  }
});
