import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyInventory } from "./elementClassifier.js";
import { classifyPageType } from "./pageClassifier.js";
import { appendPreconditionSection, buildRecipe } from "./preconditions.js";
import { buildInventory } from "./snapshotCompactor.js";
import { readSpecResult } from "./specRunner.js";
import type { StoredStructuredCase } from "./storedCase.js";
import { generateCandidates } from "./templates/index.js";
import type { CandidateCase, ElementInventory } from "./types.js";
import { classifyFailure, validateCase, type SpecRunResult } from "./validationRun.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const load = (name: string) => {
  const snapshot = readFileSync(path.join(FIXTURES, `${name}.txt`), "utf8");
  const first = classifyInventory(buildInventory(snapshot));
  const pageType = classifyPageType(first.inventory).pageType;
  const inventory: ElementInventory = classifyInventory({ ...first.inventory, pageType }, pageType).inventory;
  return { snapshot, inventory, pageType };
};
const candidatesOf = (page: ReturnType<typeof load>, preconditionId?: string): CandidateCase[] => generateCandidates({
  inventory: page.inventory, pageType: page.pageType, allowMutatingTests: false, availablePreconditions: preconditionId ? [preconditionId] : [],
  ...(preconditionId ? { statePreconditionId: preconditionId } : {}), credentials: { hasLogin: true },
}).candidates;
const stored = (candidate: CandidateCase): StoredStructuredCase => ({
  version: 1, steps: candidate.steps, oracle: candidate.oracle,
  ...(candidate.preconditionId ? { preconditionId: candidate.preconditionId } : {}),
  ...(candidate.loggedOut ? { loggedOut: true } : {}),
});

/** A fake runner: fails at the first line matching `pattern` with `message`, a fixed number of times. */
const failingRunner = (failures: Array<{ pattern: RegExp; message: string }>) => {
  const scripts: string[] = [];
  const runner = async (script: string): Promise<SpecRunResult> => {
    scripts.push(script);
    const failure = failures[scripts.length - 1];
    if (!failure) return { status: "passed", evidence: [] };
    const line = script.split("\n").findIndex((text) => failure.pattern.test(text)) + 1;
    return { status: "failed", message: failure.message, line, evidence: ["test-results/x/test-failed-1.png", "test-results/x/trace.zip"] };
  };
  return { runner, scripts };
};

const login = load("react-cart-web/login");
const loginInvalid = candidatesOf(login).find((candidate) => candidate.templateId === "auth.login_invalid")!;
const emailEmpty = candidatesOf(login).find((candidate) => candidate.templateId === "req.empty")!;
const input = (candidate: CandidateCase, page = login, snapshot = page.snapshot) => ({
  title: candidate.titleTh, category: candidate.category, stored: stored(candidate), snapshot, allowMutatingTests: false,
});

test("a passing run is verified", async () => {
  const { runner, scripts } = failingRunner([]);
  const outcome = await validateCase(input(loginInvalid), runner);
  assert.equal(outcome.status, "verified");
  assert.equal(outcome.runs, 1);
  assert.deepEqual(outcome.repairedLocators, {});
  assert.equal(outcome.script, scripts[0]);
});

test("a locator that finds nothing is replaced by an alternative and the case reruns", async () => {
  const { runner, scripts } = failingRunner([{ pattern: /\.fill\(/, message: "Error: locator.fill: Timeout 10000ms exceeded.\nCall log:\n  - waiting for getByRole('textbox', { name: 'อีเมล', exact: true })" }]);
  const outcome = await validateCase(input(loginInvalid), runner);
  assert.equal(outcome.status, "verified");
  assert.equal(outcome.runs, 2);
  const [repairedId] = Object.keys(outcome.repairedLocators);
  assert.ok(repairedId, "one element was repaired");
  assert.match(outcome.reason, /auto-repair/);
  assert.notEqual(scripts[0], scripts[1]);
  assert.ok(scripts[1].includes(outcome.repairedLocators[repairedId]));
});

test("repairs stop after maxRepairs and the case needs review", async () => {
  const timeout = { pattern: /\.fill\(/, message: "Error: locator.fill: Timeout 10000ms exceeded." };
  const { runner, scripts } = failingRunner([timeout, timeout, timeout, timeout]);
  const outcome = await validateCase({ ...input(loginInvalid), maxRepairs: 2 }, runner);
  assert.equal(outcome.status, "needs_review");
  assert.equal(scripts.length, 3);
  assert.match(outcome.reason, /^locator not found \(E\d+\) after 2 repair\(s\)/);
});

test("a failed check: possible bug for negative/validation cases, unreliable oracle for happy paths", async () => {
  const check = { pattern: /expect\.poll|toHave|toBe/, message: "Error: expect(received).toBe(expected)\n\nExpected: true\nReceived: false" };
  const negative = await validateCase(input(emailEmpty), failingRunner([check]).runner);
  assert.equal(negative.status, "possible_bug");
  assert.deepEqual(negative.evidence, ["test-results/x/test-failed-1.png", "test-results/x/trace.zip"]);
  const happy = await validateCase(input(candidatesOf(login).find((candidate) => candidate.templateId === "auth.login_valid")!), failingRunner([check]).runner);
  assert.equal(happy.status, "oracle_unreliable");
});

test("a failing precondition makes the case need review, not a bug", async () => {
  const cart = load("react-cart-web/cart-two-items");
  const recipe = buildRecipe("seed_cart_two_items", load("react-cart-web/catalog"), cart, "cart_with_2_items")!;
  const snapshot = appendPreconditionSection(cart.snapshot, recipe);
  const subtotal = candidatesOf(cart, recipe.id).find((candidate) => candidate.templateId === "cart.subtotal")!;
  const { runner } = failingRunner([{ pattern: /toHaveCount\(2, \{ timeout: 15_000 \}\);$/, message: "Error: expect(locator).toHaveCount(expected) failed\nExpected: 2\nReceived: 1" }]);
  const outcome = await validateCase(input(subtotal, cart, snapshot), runner);
  assert.equal(outcome.status, "needs_review");
  assert.match(outcome.reason, /^precondition or navigation failed/);
});

test("a case that would place an order is not run when mutating tests are not allowed", async () => {
  const checkout = load("react-cart-web/checkout-with-item");
  const order = checkout.inventory.elements.find((element) => element.name === "ยืนยันและชำระเงิน")!;
  let ran = false;
  const outcome = await validateCase({
    title: "สั่งซื้อ", category: "happy_path", snapshot: checkout.snapshot, allowMutatingTests: false,
    stored: { version: 1, steps: [{ kind: "click", elementId: order.id }], oracle: { kind: "textVisible", text: "ขอบคุณ" } },
  }, async () => {
    ran = true;
    return { status: "passed", evidence: [] };
  });
  assert.equal(ran, false);
  assert.equal(outcome.status, "needs_review");
});

test("an expect() on a missing element is the check's verdict, a read that times out is a locator problem", () => {
  const script = ["import { test, expect } from '@playwright/test';", "test(\"t\", async ({ page }) => {", "  await page.goto(\"x\");", "  // --- steps", "  await page.getByRole(\"button\").click();", "  // --- check", "  await expect(page.getByText(\"a\")).toBeVisible();", "});"].join("\n");
  assert.deepEqual(classifyFailure(script, { status: "failed", line: 7, message: "Error: expect(locator).toBeVisible() failed\nwaiting for getByText('a')", evidence: [] }), { part: "check", locatorProblem: false, failingLine: "await expect(page.getByText(\"a\")).toBeVisible();" });
  assert.equal(classifyFailure(script, { status: "failed", line: 7, message: "Error: locator.innerText: Timeout 5000ms exceeded.", evidence: [] }).locatorProblem, true);
  assert.equal(classifyFailure(script, { status: "failed", line: 3, message: "Error: page.goto: net::ERR_CONNECTION_REFUSED", evidence: [] }).part, "setup");
  assert.equal(classifyFailure(script, { status: "failed", line: 5, message: "Error: locator.click: Timeout 10000ms exceeded.", evidence: [] }).part, "steps");
});

test("readSpecResult reads the status, the failing line in the spec and the evidence", () => {
  assert.deepEqual(readSpecResult({ suites: [{ suites: [{ specs: [{ tests: [{ results: [{ status: "passed" }] }] }] }] }] }), { status: "passed", evidence: [] });
  assert.deepEqual(readSpecResult({ suites: [{ specs: [{ tests: [{ results: [{
    status: "failed",
    error: { message: "Error: expect(locator).toBeVisible() failed", location: { file: "C:/run/tests/case.spec.ts", line: 12 } },
    attachments: [{ path: "C:/run/test-results/a/test-failed-1.png" }, {}],
  }] }] }] }] }), { status: "failed", message: "Error: expect(locator).toBeVisible() failed", line: 12, evidence: ["C:/run/test-results/a/test-failed-1.png"] });
  assert.equal(readSpecResult({ suites: [], errors: [{ message: "Error: Pre-login: no login form" }] }).status, "error");
  // A test timeout: the detailed error with the waiting locator is in `errors` (found in the Phase 8 live run).
  const timedOut = readSpecResult({ suites: [{ specs: [{ tests: [{ results: [{
    status: "timedOut",
    error: { message: "Test timeout of 60000ms exceeded." },
    errors: [
      { message: "Test timeout of 60000ms exceeded." },
      { message: "Error: locator.click: Test timeout of 60000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'View details' })", location: { file: "C:/run/tests/case.spec.ts", line: 7 } },
    ],
  }] }] }] }] });
  assert.equal(timedOut.line, 7);
  assert.match(timedOut.message ?? "", /^Error: locator\.click: Test timeout/);
  const script = ["import { test, expect } from '@playwright/test';", "test(\"t\", async ({ page }) => {", "  await page.goto(\"x\");", "  // --- steps", "  await page.getByRole(\"button\").click();", "  await page.getByRole(\"link\").click();", "  await page.getByRole(\"button\", { name: \"View details\" }).click();", "  // --- check", "});"].join("\n");
  assert.equal(classifyFailure(script, timedOut).locatorProblem, true);
});
