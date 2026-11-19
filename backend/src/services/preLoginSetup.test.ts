import test from "node:test";
import assert from "node:assert/strict";
import { shouldPreLogin } from "./preLoginSetup.js";

const credentials = { username: "standard_user", password: "secret_sauce" };

test("shouldPreLogin is true for a script that opens a page without logging in", () => {
  const script = "await page.goto('https://www.saucedemo.com/inventory.html');\nawait page.locator('#add').click();";
  assert.equal(shouldPreLogin(script, credentials), true);
});

test("shouldPreLogin is false for a login test, which must start logged out", () => {
  const script = [
    "await page.goto('https://www.saucedemo.com/');",
    "await page.getByRole('textbox', { name: 'Username' }).fill(process.env.TEST_EMAIL ?? '');",
    "await page.getByRole('textbox', { name: 'Password' }).fill(process.env.TEST_PASSWORD ?? '');",
  ].join("\n");
  assert.equal(shouldPreLogin(script, credentials), false);
});

test("shouldPreLogin is false when the job has no credentials", () => {
  assert.equal(shouldPreLogin("await page.goto('https://example.com/');", undefined), false);
  assert.equal(shouldPreLogin("await page.goto('https://example.com/');", null), false);
});
