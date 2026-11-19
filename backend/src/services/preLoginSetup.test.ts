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

test("pre-login saves IndexedDB so Firebase-style sessions survive", async () => {
  const { PRE_LOGIN_SETUP_SOURCE } = await import("./preLoginSetup.js");
  assert.match(PRE_LOGIN_SETUP_SOURCE, /storageState\(\{ path: statePath, indexedDB: true \}\)/);
});

test("pre-login looks for a login page beyond the target URL and site root", async () => {
  const { PRE_LOGIN_SETUP_SOURCE } = await import("./preLoginSetup.js");
  assert.match(PRE_LOGIN_SETUP_SOURCE, /'\/login'/);
  assert.match(PRE_LOGIN_SETUP_SOURCE, /LOGIN_LINK_PATTERN/);
  assert.doesNotMatch(PRE_LOGIN_SETUP_SOURCE, /actprin|secret_sauce|standard_user/);
});

test("pre-login also looks beyond the site root when the target URL is the root itself", async () => {
  const { PRE_LOGIN_SETUP_SOURCE } = await import("./preLoginSetup.js");
  // Duplicate candidates are removed up front, so the login-link/path expansion runs after the last base page.
  assert.match(PRE_LOGIN_SETUP_SOURCE, /const candidates = \[\.\.\.new Set\(\[targetUrl, origin \+ '\/'\]\)\];/);
  assert.match(PRE_LOGIN_SETUP_SOURCE, /if \(index === baseCount - 1\)/);
});
