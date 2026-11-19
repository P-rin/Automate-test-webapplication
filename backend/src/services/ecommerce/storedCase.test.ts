import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildInventory } from "./snapshotCompactor.js";
import { compileStoredCase, parseStoredStructuredCase, STRUCTURED_CASE_VERSION } from "./storedCase.js";

const snapshot = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__/saucedemo/inventory.txt"),
  "utf8",
);

test("parseStoredStructuredCase accepts only the versioned structure", () => {
  const valid = { version: STRUCTURED_CASE_VERSION, steps: [{ kind: "click", elementId: "E1" }], oracle: { kind: "urlUnchanged" }, preconditionId: "logged_in" };
  assert.deepEqual(parseStoredStructuredCase(valid), valid);
  assert.equal(parseStoredStructuredCase(undefined), undefined);
  assert.equal(parseStoredStructuredCase({ ...valid, version: 2 }), undefined);
  assert.equal(parseStoredStructuredCase({ ...valid, steps: [{ elementId: "E1" }] }), undefined);
  assert.equal(parseStoredStructuredCase({ ...valid, oracle: "visible" }), undefined);
});

test("stored element IDs resolve again against the same snapshot (inventory IDs are deterministic)", () => {
  const first = buildInventory(snapshot);
  const second = buildInventory(snapshot);
  assert.deepEqual(first.elements.map((element) => [element.id, element.role, element.name]), second.elements.map((element) => [element.id, element.role, element.name]));

  const addSecond = first.elements.find((element) => element.groupId === "G2" && element.name === "Add to cart")!;
  const compiled = compileStoredCase(
    "เพิ่มสินค้าชิ้นที่สอง",
    { version: STRUCTURED_CASE_VERSION, steps: [{ kind: "click", elementId: addSecond.id }], oracle: { kind: "elementHidden", elementId: addSecond.id } },
    snapshot,
    undefined,
  );
  assert.match(compiled.script, /filter\(\{ hasText: "Sauce Labs Bike Light" \}\)\.getByRole\("button", \{ name: "Add to cart", exact: true \}\)\.click\(\)/);
  assert.equal(compiled.requiresPlaywrightEngine, true);
});
