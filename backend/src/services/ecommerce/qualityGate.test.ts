import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyInventory } from "./elementClassifier.js";
import { classifyPageType } from "./pageClassifier.js";
import { checkCaseQuality } from "./qualityGate.js";
import { buildInventory } from "./snapshotCompactor.js";
import { generateCandidates } from "./templates/index.js";
import type { ElementInventory } from "./types.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const prepare = (name: string): ElementInventory => {
  const snapshot = readFileSync(path.join(FIXTURES, `${name}.txt`), "utf8");
  const first = classifyInventory(buildInventory(snapshot));
  const pageType = classifyPageType(first.inventory).pageType;
  return classifyInventory({ ...first.inventory, pageType }, pageType).inventory;
};

test("template candidates of every fixture pass the gate", () => {
  const dropped: string[] = [];
  for (const site of ["react-cart-web", "saucedemo"]) {
    for (const file of readdirSync(path.join(FIXTURES, site)).filter((name) => name.endsWith(".txt"))) {
      const inventory = prepare(`${site}/${file.replace(/\.txt$/, "")}`);
      const { candidates } = generateCandidates({
        inventory, pageType: inventory.pageType ?? "other", allowMutatingTests: false, availablePreconditions: ["seed_cart_one_item"],
        statePreconditionId: "seed_cart_one_item", credentials: { hasLogin: true },
      });
      for (const candidate of candidates) {
        const result = checkCaseQuality({ category: candidate.category, expectedResult: candidate.expectedResultTh, steps: candidate.steps, oracle: candidate.oracle, inventory, allowMutatingTests: false });
        if (!result.accepted) dropped.push(`${site}/${file} ${candidate.templateId}: ${result.issues.join(",")}`);
      }
    }
  }
  assert.deepEqual(dropped, []);
});

test("the gate drops weak, vague, unknown-element and order-placing cases", () => {
  const checkout = prepare("react-cart-web/checkout-with-item");
  const cart = prepare("react-cart-web/cart-two-items");
  const orderButton = checkout.elements.find((element) => element.name === "ยืนยันและชำระเงิน")!;
  const goToCheckout = cart.elements.find((element) => element.purpose === "checkout_button")!;
  const base = { category: "happy_path", expectedResult: "แสดงยอดสุทธิ", steps: [], inventory: checkout, allowMutatingTests: false };

  assert.deepEqual(checkCaseQuality({ ...base, oracle: undefined }).issues, ["no_oracle"]);
  assert.deepEqual(checkCaseQuality({ ...base, expectedResult: "ระบบทำงานได้ถูกต้อง", oracle: { kind: "urlUnchanged" } }).issues, ["vague_expected_url_only"]);
  // A vague sentence is fine when the oracle itself is specific.
  assert.equal(checkCaseQuality({ ...base, expectedResult: "ระบบทำงานได้ถูกต้อง", oracle: { kind: "elementVisible", elementId: orderButton.id } }).accepted, true);
  assert.deepEqual(checkCaseQuality({ ...base, category: "validation", oracle: { kind: "urlUnchanged" } }).issues, ["negative_checks_url_only"]);
  assert.deepEqual(checkCaseQuality({ ...base, oracle: { kind: "persistsAfterReload", inner: { kind: "urlContains", fragment: "/x" } }, category: "negative" }).issues, ["negative_checks_url_only"]);
  assert.deepEqual(checkCaseQuality({ ...base, oracle: { kind: "elementVisible", elementId: "E999" } }).issues, ["unknown_element"]);
  assert.deepEqual(checkCaseQuality({ ...base, steps: [{ kind: "click", elementId: orderButton.id }], oracle: { kind: "textVisible", text: "ขอบคุณ" } }).issues, ["would_place_order"]);
  assert.equal(checkCaseQuality({ ...base, allowMutatingTests: true, steps: [{ kind: "click", elementId: orderButton.id }], oracle: { kind: "textVisible", text: "ขอบคุณ" } }).accepted, true);
  // The cart's "go to checkout" link only opens the checkout page.
  assert.equal(checkCaseQuality({ ...base, inventory: cart, steps: [{ kind: "click", elementId: goToCheckout.id }], oracle: { kind: "urlContains", fragment: "/checkout" } }).accepted, true);
});
