import test from "node:test";
import assert from "node:assert/strict";

import { parseJsonArrayResponse, validateGeneratedScript } from "./copilotService.js";

test("parseJsonArrayResponse accepts a raw JSON array", () => {
  const result = parseJsonArrayResponse(`[{"id":"TC-001","title":"Test"}]`);
  assert.deepEqual(result, [{ id: "TC-001", title: "Test" }]);
});

test("parseJsonArrayResponse accepts an object wrapper with a plans array", () => {
  const result = parseJsonArrayResponse(`{"plans":[{"id":"TC-001","title":"Test"}]}`);
  assert.deepEqual(result, [{ id: "TC-001", title: "Test" }]);
});

test("parseJsonArrayResponse accepts markdown fenced JSON", () => {
  const result = parseJsonArrayResponse("```json\n[{\"id\":\"TC-001\",\"title\":\"Test\"}]\n```");
  assert.deepEqual(result, [{ id: "TC-001", title: "Test" }]);
});

test("parseJsonArrayResponse throws for non-array payloads", () => {
  assert.throws(() => parseJsonArrayResponse(`{"message":"bad"}`), /not a JSON array/i);
});

test("validateGeneratedScript accepts valid Playwright script", () => {
  const validScript = `import { test, expect } from '@playwright/test';\n\n` +
    `test('example', async ({ page }) => {\n` +
    `  await page.goto('https://example.com');\n` +
    `  await expect(page).toHaveTitle(/.+/);\n` +
    `});\n`;

  assert.doesNotThrow(() => validateGeneratedScript(validScript));
});

test("validateGeneratedScript rejects script with missing import", () => {
  const invalidScript = `test('example', async ({ page }) => {\n` +
    `  await page.goto('https://example.com');\n` +
    `  await expect(page).toHaveTitle(/.+/);\n` +
    `});\n`;

  assert.throws(() => validateGeneratedScript(invalidScript), /must import both test and expect/i);
});

test("validateGeneratedScript accepts test.only blocks", () => {
  const validScript = `import { test, expect } from '@playwright/test';\n\n` +
    `test.only('example', async ({ page }) => {\n` +
    `  await page.goto('https://example.com');\n` +
    `  await expect(page).toHaveTitle(/.+/);\n` +
    `});\n`;

  assert.doesNotThrow(() => validateGeneratedScript(validScript));
});

test("validateGeneratedScript accepts it blocks", () => {
  const validScript = `import { test, expect } from '@playwright/test';\n\n` +
    `it('example', async ({ page }) => {\n` +
    `  await page.goto('https://example.com');\n` +
    `  await expect(page).toHaveTitle(/.+/);\n` +
    `});\n`;

  assert.doesNotThrow(() => validateGeneratedScript(validScript));
});

test("validateGeneratedScript accepts reversed import order", () => {
  const validScript = `import { expect, test } from '@playwright/test';\n\n` +
    `test('example', async ({ page }) => {\n` +
    `  await page.goto('https://example.com');\n` +
    `  await expect(page).toHaveTitle(/.+/);\n` +
    `});\n`;

  assert.doesNotThrow(() => validateGeneratedScript(validScript));
});

test("validateGeneratedScript rejects script with unbalanced parentheses", () => {
  const invalidScript = `import { test, expect } from '@playwright/test';\n\n` +
    `test('example', async ({ page }) => {\n` +
    `  await page.goto('https://example.com';\n` +
    `  await expect(page).toHaveTitle(/.+/);\n` +
    `});\n`;

  assert.throws(() => validateGeneratedScript(invalidScript), /unbalanced brackets or parentheses/i);
});
