import test from "node:test";
import assert from "node:assert/strict";

import { matchesName, parsePlaywrightActions, resolveFillValue } from "./playwrightActionParser.js";

test("parses getByRole(...).fill() using the accessible name, not the role", () => {
  const actions = parsePlaywrightActions(
    "await page.getByRole('textbox', { name: 'Username' }).fill('standard_user');",
  );
  assert.deepEqual(actions, [
    { kind: "fill", label: "Username", labelIsRegex: false, role: "textbox", value: "standard_user" },
  ]);
});

test("parses getByRole(...).fill() with a regex name and exact option", () => {
  const actions = parsePlaywrightActions(
    `await page.getByRole("textbox", { name: /password/i, exact: false }).fill("secret");`,
  );
  assert.deepEqual(actions, [
    { kind: "fill", label: "password", labelIsRegex: true, role: "textbox", value: "secret" },
  ]);
});

test("parses getByRole(...).fill() without a name", () => {
  const actions = parsePlaywrightActions("await page.getByRole('searchbox').fill('shoes');");
  assert.deepEqual(actions, [
    { kind: "fill", label: "", labelIsRegex: false, role: "searchbox", value: "shoes" },
  ]);
});

test("resolves process.env fill values, including fallbacks and String() wrappers", () => {
  const env = { TEST_EMAIL: "user@example.com", EMPTY: "" };
  assert.deepEqual(resolveFillValue("process.env.TEST_EMAIL", env), { ok: true, value: "user@example.com" });
  assert.deepEqual(resolveFillValue("process.env.TEST_EMAIL!", env), { ok: true, value: "user@example.com" });
  assert.deepEqual(resolveFillValue("process.env.TEST_EMAIL as string", env), { ok: true, value: "user@example.com" });
  assert.deepEqual(resolveFillValue("String(process.env.TEST_EMAIL)", env), { ok: true, value: "user@example.com" });
  assert.deepEqual(resolveFillValue("process.env.MISSING ?? 'fallback'", env), { ok: true, value: "fallback" });
  assert.deepEqual(resolveFillValue("process.env.EMPTY || 'fallback'", env), { ok: true, value: "fallback" });
  assert.deepEqual(resolveFillValue("process.env.EMPTY ?? ''", env), { ok: true, value: "" });
  assert.deepEqual(resolveFillValue("process.env.MISSING", env), { ok: false, detail: "Environment variable MISSING is not set" });
  assert.equal(resolveFillValue("someVariable", env).ok, false);
});

test("parses a full login script with env credentials and regex assertions", () => {
  const previousEmail = process.env.TEST_EMAIL;
  const previousPassword = process.env.TEST_PASSWORD;
  process.env.TEST_EMAIL = "standard_user";
  process.env.TEST_PASSWORD = "secret_sauce";
  try {
    const actions = parsePlaywrightActions([
      "import { test, expect } from '@playwright/test';",
      "test('login', async ({ page }) => {",
      "  await page.goto('https://www.saucedemo.com/');",
      "  await page.getByRole('textbox', { name: 'Username' }).fill(process.env.TEST_EMAIL ?? '');",
      "  await page.getByPlaceholder('Password').fill(process.env.TEST_PASSWORD ?? '');",
      "  await page.getByRole('button', { name: 'Login' }).click();",
      "  await expect(page).toHaveURL(/inventory/);",
      "  await expect(page.getByText(/Swag Labs/i)).toBeVisible();",
      "  await expect(page.getByRole('heading', { name: /Products/ })).toContainText('Products');",
      "});",
    ].join("\n"));

    assert.deepEqual(actions, [
      { kind: "goto", url: "https://www.saucedemo.com/" },
      { kind: "fill", label: "Username", labelIsRegex: false, role: "textbox", value: "standard_user" },
      { kind: "fill", label: "Password", labelIsRegex: false, value: "secret_sauce" },
      { kind: "clickRole", role: "button", name: "Login", nameIsRegex: false },
      { kind: "assertUrl", expected: "inventory", isRegex: true },
      { kind: "assertVisibleText", text: "Swag Labs", textIsRegex: true },
      { kind: "assertTextRole", role: "heading", name: "Products", nameIsRegex: true, expected: "Products", isRegex: false },
    ]);
  } finally {
    if (previousEmail === undefined) delete process.env.TEST_EMAIL; else process.env.TEST_EMAIL = previousEmail;
    if (previousPassword === undefined) delete process.env.TEST_PASSWORD; else process.env.TEST_PASSWORD = previousPassword;
  }
});

test("parsePlaywrightActions resolves credentials from an explicit env instead of process.env", () => {
  const actions = parsePlaywrightActions(
    "await page.getByRole('textbox', { name: 'Password' }).fill(process.env.TEST_PASSWORD ?? '');",
    { TEST_PASSWORD: "from_job" },
  );
  assert.deepEqual(actions, [
    { kind: "fill", label: "Password", labelIsRegex: false, role: "textbox", value: "from_job" },
  ]);
});

test("parses regex names for role clicks and visibility checks", () => {
  const actions = parsePlaywrightActions([
    "await page.getByRole('link', { name: /sign in/i }).click();",
    "await expect(page.getByRole('heading', { name: /Swag Labs/i })).toBeVisible();",
    "await page.getByText(/Add to cart/).click();",
  ].join("\n"));

  assert.deepEqual(actions, [
    { kind: "clickRole", role: "link", name: "sign in", nameIsRegex: true },
    { kind: "assertVisibleRole", role: "heading", name: "Swag Labs", nameIsRegex: true },
    { kind: "clickText", text: "Add to cart", textIsRegex: true },
  ]);
});

test("keeps CSS locator and test-id actions working, now with env values", () => {
  const previous = process.env.TEST_EMAIL;
  process.env.TEST_EMAIL = "a@b.c";
  try {
    const actions = parsePlaywrightActions([
      "await page.locator('#user-name').fill(process.env.TEST_EMAIL ?? '');",
      "await page.locator('input').nth(1).fill('x');",
      "await page.getByTestId('login-button').click();",
      "await expect(page.locator('.title')).toHaveText('Products');",
    ].join("\n"));

    assert.deepEqual(actions, [
      { kind: "fillLocator", selector: "#user-name", value: "a@b.c" },
      { kind: "fillLocatorNth", selector: "input", index: 1, value: "x" },
      { kind: "clickTestId", testId: "login-button" },
      { kind: "assertTextLocator", selector: ".title", expected: "Products", isRegex: false },
    ]);
  } finally {
    if (previous === undefined) delete process.env.TEST_EMAIL; else process.env.TEST_EMAIL = previous;
  }
});

test("reports unresolved fill values and unknown actions as unsupported", () => {
  const actions = parsePlaywrightActions([
    "await page.getByRole('textbox', { name: 'Username' }).fill(process.env.DEFINITELY_NOT_SET_12345);",
    "await page.fill('Username', 'x');",
  ].join("\n"));

  assert.equal(actions.length, 2);
  assert.equal(actions[0]?.kind, "unsupported");
  assert.match(actions[0]?.kind === "unsupported" ? actions[0].detail : "", /DEFINITELY_NOT_SET_12345 is not set/);
  assert.equal(actions[1]?.kind, "unsupported");
});

test("matchesName supports substring and regex matching", () => {
  assert.equal(matchesName("Username", "user"), true);
  assert.equal(matchesName("Swag Labs", "swag labs", true), true);
  assert.equal(matchesName("Login", "^log", true), true);
  assert.equal(matchesName("Login", "(", true), false);
});
