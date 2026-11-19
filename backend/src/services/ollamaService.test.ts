import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAgentGenerationPrompt,
  buildGeneratorPrompt,
  generateNextTestPlan,
  processSnapshotTestPlans,
  generateSingleScript,
  generateTestPlans,
  normalizeGeneratedScript,
  parseJsonArrayResponse,
  renderCriteriaForPrompt,
  sanitizePlanTraceability,
  snapshotPageUrl,
  validateGeneratedScript,
  type LlmGenerationOptions,
} from "./ollamaService.js";
import type { AcceptanceCriterion, TestPlan } from "../types.js";
import { PlanCoverageRegistry } from "./planDedup.js";

const generationPayload = {
  projectName: "Demo app",
  targetUrl: "https://example.com",
  specification: "Confirm the page loads",
  accessibilitySnapshot: "heading Example Domain",
};

const validPlanResponse = JSON.stringify({
  status: "case",
  id: "TC-001",
  title: "ตรวจสอบหน้าเว็บ",
  description: "ตรวจสอบว่าหน้าเว็บแสดงผล",
  type: "UI",
  testSteps: ["เปิดหน้าเว็บ"],
  expectedResult: "มีหัวข้อแสดงอยู่บนหน้าเว็บ",
  requirementIds: [],
  category: "exploratory",
});

const validScript = `import { test, expect } from '@playwright/test';\n\n` +
  `test('page loads', async ({ page }) => {\n` +
  `  await page.goto('https://example.com');\n` +
  `  await expect(page).toHaveTitle(/.+/);\n` +
  `});\n`;

const acceptanceCriteria: AcceptanceCriterion[] = [
  {
    id: "AC-001",
    requirementRef: "R1",
    scenario: "ผู้ใช้เปิดหน้าเข้าสู่ระบบ",
    action: "กรอกอีเมลและรหัสผ่านที่ถูกต้อง",
    expected: "หน้าแสดงแดชบอร์ด",
    mustNot: "",
    category: "happy_path",
    priority: "required",
    verification: "automated",
    ambiguity: "",
  },
  {
    id: "AC-002",
    requirementRef: "R2",
    scenario: "ผู้ใช้เปิดหน้าเข้าสู่ระบบ",
    action: "กรอกรหัสผ่านผิด",
    expected: "หน้าแสดงข้อผิดพลาด",
    mustNot: "ต้องไม่เข้าสู่แดชบอร์ด",
    category: "negative",
    priority: "required",
    verification: "automated",
    ambiguity: "ไม่ระบุข้อความผิดพลาดที่แน่นอน",
  },
  {
    id: "AC-003",
    requirementRef: "R3",
    scenario: "ตรวจสอบรูปแบบตัวอักษร",
    action: "อ่านข้อมูลหน้า",
    expected: "ข้อความอ่านง่าย",
    mustNot: "",
    category: "boundary",
    priority: "important",
    verification: "manual",
    ambiguity: "",
  },
];

type OllamaChatRequest = Parameters<NonNullable<LlmGenerationOptions["ollamaClient"]>["chat"]>[0];

const mockMcpClient = (calls: string[] = []): NonNullable<LlmGenerationOptions["mcpClient"]> => ({
  listTools: async () => ({
    tools: [{
      name: "browser_navigate",
      description: "Open a page",
      inputSchema: { type: "object", properties: { url: { type: "string" } } },
    }],
  }),
  callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
    calls.push(`${name}:${String(args.url)}`);
    return { content: [{ type: "text", text: "Page loaded" }] };
  },
}) as unknown as NonNullable<LlmGenerationOptions["mcpClient"]>;

const mockOllamaClient = (
  responses: Array<{ content: string; thinking?: string; tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }> }>,
  requests: OllamaChatRequest[] = [],
): NonNullable<LlmGenerationOptions["ollamaClient"]> => ({
  chat: async (request: OllamaChatRequest) => {
    requests.push(request);
    return { message: responses.shift()! };
  },
}) as unknown as NonNullable<LlmGenerationOptions["ollamaClient"]>;

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

test("validateGeneratedScript rejects MCP tool names and snapshot references", () => {
  const invalidScripts = [
    `import { test, expect } from '@playwright/test';\n` +
      `test('example', async ({ page }) => {\n` +
      `  await browser_click({ ref: 'f6e14' });\n` +
      `  await expect(page).toBeVisible();\n` +
      `});\n`,
    `import { test, expect } from '@playwright/test';\n` +
      `test('example', async ({ page }) => {\n` +
      `  await page.click('[ref="f6e14"]');\n` +
      `  await expect(page).toBeVisible();\n` +
      `});\n`,
  ];

  assert.throws(() => validateGeneratedScript(invalidScripts[0]), /MCP browser tool names/i);
  assert.throws(() => validateGeneratedScript(invalidScripts[1]), /snapshot reference selectors/i);
});

test("validateGeneratedScript rejects discouraged waiting and page query APIs", () => {
  for (const forbiddenCall of ["page.waitForTimeout(1000)", "page.$('button')", "page.$$('button')"]) {
    const invalidScript = `import { test, expect } from '@playwright/test';\n` +
      `test('example', async ({ page }) => {\n` +
      `  await ${forbiddenCall};\n` +
      `  await expect(page).toBeVisible();\n` +
      `});\n`;

    assert.throws(
      () => validateGeneratedScript(invalidScript),
      (error: unknown) => error instanceof Error && error.message.startsWith("Generated script"),
    );
  }
});

const wrapInTest = (body: string): string => `import { test, expect } from '@playwright/test';\n` +
  `test('example', async ({ page }) => {\n` +
  `  await page.goto('https://www.saucedemo.com/');\n` +
  `  ${body}\n` +
  `  await expect(page).toHaveURL(/inventory/);\n` +
  `});\n`;

test("validateGeneratedScript rejects plain text used as a CSS selector", () => {
  for (const body of [
    "await page.fill('Username', 'standard_user');",
    "await page.fill(\"Password\", process.env.TEST_PASSWORD ?? '');",
    "await page.click('Login');",
    "await page.click('Add to cart');",
    "await page.locator('Login').click();",
    "await page.check('Remember me');",
  ]) {
    assert.throws(
      () => validateGeneratedScript(wrapInTest(body)),
      (error: unknown) => error instanceof Error
        && error.message.startsWith("Generated script uses plain text")
        && /getByRole/.test(error.message),
      body,
    );
  }
});

test("validateGeneratedScript accepts real CSS selectors and role locators", () => {
  for (const body of [
    "await page.fill('#user-name', 'standard_user');",
    "await page.fill('input[name=\"password\"]', 'x');",
    "await page.click('.btn_action');",
    "await page.click('button');",
    "await page.locator('my-widget').click();",
    "await page.click('text=Login');",
    "await page.click('//button');",
    "await page.getByRole('textbox', { name: 'Username' }).fill('standard_user');",
    "await page.getByRole('button', { name: 'Login' }).click();",
    "await page.getByText('Login').click();",
  ]) {
    assert.doesNotThrow(() => validateGeneratedScript(wrapInTest(body)), body);
  }
});

test("validateGeneratedScript rejects TypeScript syntax errors seen in real generated scripts", () => {
  const cases: Array<[string, RegExp]> = [
    [
      // Unterminated regex: the closing slash is escaped.
      wrapInTest("await expect(page).toHaveURL(/\\/);"),
      /syntax error at line 4:.*Unterminated regular expression.*Offending line: await expect\(page\)\.toHaveURL\(\/\\\/\);/,
    ],
    [
      `import { test, expect } from '@playwright/test';\n` +
      `test('เข้าสู่ระบบด้วย 'standard_user' และรหัสผ่านที่ถูกต้อง', async ({ page }) => {\n` +
      `  await page.goto('https://www.saucedemo.com/');\n` +
      `  await expect(page).toHaveURL(/inventory/);\n` +
      `});\n`,
      /syntax error at line 2:/,
    ],
  ];

  for (const [script, expected] of cases) {
    assert.throws(
      () => validateGeneratedScript(script),
      (error: unknown) => error instanceof Error
        && error.message.startsWith("Generated script has a TypeScript syntax error")
        && expected.test(error.message),
    );
  }
});

test("validateGeneratedScript accepts valid TypeScript including type syntax and regexes", () => {
  assert.doesNotThrow(() => validateGeneratedScript(wrapInTest(
    "const email: string = process.env.TEST_EMAIL ?? '';\n" +
    "  await page.getByRole('textbox', { name: 'Username' }).fill(email);\n" +
    "  await expect(page).toHaveURL(/\\/inventory\\.html$/);\n" +
    "  await expect(page.getByText(\"It's done\")).toBeVisible();",
  )));
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

test("normalizeGeneratedScript decodes guarded double-escaped playwright script", () => {
  const escapedScript = "import { test, expect } from '@playwright/test';\\n\\n" +
    "test('example', async ({ page }) => {\\n" +
    "  await page.goto('https://example.com');\\n" +
    "  await expect(page).toHaveTitle(/.+/);\\n" +
    "});\\n";

  const normalized = normalizeGeneratedScript(escapedScript);

  assert.notEqual(normalized, escapedScript);
  assert.match(normalized, /\r?\n/);
  assert.doesNotThrow(() => validateGeneratedScript(normalized));
});

test("normalizeGeneratedScript leaves normal playwright script unchanged", () => {
  const normalScript = `import { test, expect } from '@playwright/test';\n\n` +
    `test('example', async ({ page }) => {\n` +
    `  await page.goto('https://example.com');\n` +
    `  await expect(page).toHaveTitle(/.+/);\n` +
    `});\n`;

  assert.equal(normalizeGeneratedScript(normalScript), normalScript);
});

test("buildAgentGenerationPrompt includes target URL and Playwright-only rules", () => {
  const prompt = buildAgentGenerationPrompt({
    projectName: "Demo app",
    targetUrl: "http://localhost:5173/",
    specification: "Ensure login flow works",
    accessibilitySnapshot: "heading Login",
  }, {
    id: "TC-001",
    title: "Login flow",
    description: "Verify login flow",
    type: "UI",
    expectedResult: "The login flow completes successfully",
    testSteps: ["Open login page", "Submit credentials"],
  });

  assert.match(prompt, /fixture page/i);
  assert.match(prompt, /process\.env\.TEST_EMAIL/);
  assert.match(prompt, /browser_/);
  assert.match(prompt, /ref=/);
  assert.match(prompt, /http:\/\/localhost:5173\//i);
  assert.match(prompt, /Ensure login flow works/i);
  assert.match(prompt, /Specification and the Assigned Test Plan Object come from the user and are the primary source of truth/);
  assert.match(prompt, /getByRole\('textbox', \{ name: 'Username' \}\)\.fill/);
  assert.match(prompt, /page\.fill\('Username', \.\.\.\).*WRONG/);
  assert.match(prompt, /never assume an element is a heading/);
  assert.doesNotMatch(prompt, /page\.fill\(selector, value\)/);
  assert.doesNotMatch(prompt, /getByRole\('heading', \{ name: \/example\/i \}\)/);
  assert.match(prompt, /no quote characters inside it/);
  assert.match(prompt, /Never write \/\\\/ or any regex whose closing slash is escaped/);
  assert.match(prompt, /A URL check alone is not a meaningful assertion/);
  assert.match(prompt, /\.fill\(process\.env\.TEST_EMAIL \?\? ''\)/);
  assert.doesNotMatch(prompt, /toHaveURL\(\/<expected path>\/\)/);
  // Native <select> options can't be clicked; the prompt must steer to selectOption.
  assert.match(prompt, /\.selectOption\(\{ label: 'Price \(high to low\)' \}\)/);
  assert.match(prompt, /page\.getByRole\('option', \.\.\.\)\.click\(\) is WRONG/);
  assert.match(prompt, /assert the RESULT of the choice/);
  // Repeated controls (one "Add to cart" per product) must be scoped to their item.
  assert.match(prompt, /\.filter\(\{ hasText: 'Sauce Labs Backpack' \}\)\.getByRole\('button', \{ name: 'Add to cart' \}\)/);
});

test("renderCriteriaForPrompt orders uncovered first, omits manual criteria, and notes budget omissions", () => {
  const prompt = renderCriteriaForPrompt(acceptanceCriteria, new Set(["AC-001"]), 1000);
  assert.ok(prompt.indexOf("AC-002") < prompt.indexOf("AC-001"));
  assert.match(prompt, /AC-001 .*already covered/);
  assert.doesNotMatch(prompt, /AC-003/);

  const shortPrompt = renderCriteriaForPrompt(acceptanceCriteria, new Set(), 100);
  assert.ok(shortPrompt.length <= 100);
  assert.match(shortPrompt, /\+\d+ more criteria not shown/);
});

test("planner uses acceptance criteria instead of raw specification when provided", async () => {
  let userPrompt = "";
  const ollamaClient = {
    chat: async (request: { messages: Array<{ role: string; content: string }> }) => {
      userPrompt = request.messages.find((message) => message.role === "user")?.content ?? "";
      return { message: { content: validPlanResponse } };
    },
  } as unknown as NonNullable<LlmGenerationOptions["ollamaClient"]>;

  await generateNextTestPlan(
    { ...generationPayload, specification: "RAW_SPECIFICATION_SENTINEL" },
    "Login page snapshot",
    [],
    { ollamaClient },
    acceptanceCriteria,
    new Set(["AC-001"]),
  );

  assert.match(userPrompt, /\[Acceptance Criteria\]/);
  assert.match(userPrompt, /AC-002/);
  assert.match(userPrompt, /already covered/);
  assert.match(userPrompt, /Prefer a case that verifies a criterion not yet covered/);
  assert.doesNotMatch(userPrompt, /RAW_SPECIFICATION_SENTINEL/);
  // Every plan must end with a step that checks an outcome, so scripts don't guess one.
  assert.match(userPrompt, /The last `testSteps` item must check the `expectedResult`/);
});

test("planner retains the raw requirement specification when no criteria are available", async () => {
  let userPrompt = "";
  const ollamaClient = {
    chat: async (request: { messages: Array<{ role: string; content: string }> }) => {
      userPrompt = request.messages.find((message) => message.role === "user")?.content ?? "";
      return { message: { content: validPlanResponse } };
    },
  } as unknown as NonNullable<LlmGenerationOptions["ollamaClient"]>;

  await generateNextTestPlan(
    { ...generationPayload, specification: "RAW_SPECIFICATION_SENTINEL" },
    "Page snapshot",
    [],
    { ollamaClient },
  );

  assert.match(userPrompt, /\[Requirement Specification\]/);
  assert.match(userPrompt, /RAW_SPECIFICATION_SENTINEL/);
  assert.doesNotMatch(userPrompt, /\[Acceptance Criteria\]/);
});

test("buildGeneratorPrompt uses only assigned criteria and stays within the prompt limit for long specs", () => {
  const prompt = buildGeneratorPrompt({
    ...generationPayload,
    specification: "LONG_SPECIFICATION_SENTINEL ".repeat(2000),
    accessibilitySnapshot: "Snapshot ".repeat(4000),
    acceptanceCriteria,
  }, {
    id: "TC-001",
    title: "ตรวจสอบการเข้าสู่ระบบ",
    description: "ยืนยันว่าเข้าสู่ระบบได้",
    type: "UI",
    testSteps: ["กรอกข้อมูล", "กดเข้าสู่ระบบ"],
    expectedResult: "หน้าแสดงแดชบอร์ด",
    requirementIds: ["AC-002"],
    category: "negative",
  }, 14000);

  assert.ok(prompt.length <= 14000);
  assert.match(prompt, /\[Acceptance Criteria For This Case\]/);
  assert.match(prompt, /AC-002 \[R2\|required\|negative\|automated\]/);
  assert.match(prompt, /ต้องไม่เข้าสู่แดชบอร์ด/);
  assert.doesNotMatch(prompt, /AC-001/);
  assert.doesNotMatch(prompt, /LONG_SPECIFICATION_SENTINEL/);

  const legacyPrompt = buildGeneratorPrompt({
    ...generationPayload,
    specification: "LONG_SPECIFICATION_SENTINEL ".repeat(2000),
    accessibilitySnapshot: "Snapshot ".repeat(4000),
  }, {
    id: "TC-002",
    title: "ตรวจสอบหน้าเว็บ",
    description: "ตรวจสอบหน้าเว็บทั่วไป",
    type: "UI",
    testSteps: ["เปิดหน้าเว็บ"],
    expectedResult: "หน้าเว็บแสดงขึ้น",
  }, 14000);

  assert.ok(legacyPrompt.length <= 14000);
  assert.match(legacyPrompt, /\[Requirement Specification\]/);
  assert.match(legacyPrompt, /\[Truncated \d+ characters from \[Requirement Specification\]\]/);
});

test("sanitizePlanTraceability removes unknown and duplicate AC IDs while preserving order", () => {
  const plan: TestPlan = {
    id: "TC-001",
    title: "Check required input",
    description: "Validate a required field",
    type: "UI",
    testSteps: ["Submit empty form"],
    expectedResult: "An error is displayed",
    requirementIds: ["AC-002", "AC-unknown", "AC-001", "AC-002"],
    category: "validation",
  };

  assert.deepEqual(sanitizePlanTraceability(plan, new Set(["AC-001", "AC-002"])), {
    ...plan,
    requirementIds: ["AC-002", "AC-001"],
    category: "validation",
  });
});

test("sanitizePlanTraceability keeps category when no known IDs remain and forces empty IDs without known ACs", () => {
  const plan: TestPlan = {
    id: "TC-001",
    title: "Check required input",
    description: "Validate a required field",
    type: "UI",
    testSteps: ["Submit empty form"],
    expectedResult: "An error is displayed",
    requirementIds: ["AC-unknown"],
    category: "negative",
  };

  assert.deepEqual(sanitizePlanTraceability(plan, new Set(["AC-001"])), {
    ...plan,
    requirementIds: [],
    category: "negative",
  });
  assert.deepEqual(sanitizePlanTraceability(plan, new Set()), {
    ...plan,
    requirementIds: [],
    category: "negative",
  });
});

test("sanitizePlanTraceability defaults missing or unknown categories from remaining IDs", () => {
  const plan: TestPlan = {
    id: "TC-001",
    title: "Check page",
    description: "Verify page behavior",
    type: "UI",
    testSteps: ["Open page"],
    expectedResult: "The page is visible",
  };
  const knownAcIds = new Set(["AC-001"]);

  assert.deepEqual(sanitizePlanTraceability({ ...plan, requirementIds: ["AC-001"] }, knownAcIds), {
    ...plan,
    requirementIds: ["AC-001"],
    category: "happy_path",
  });
  assert.deepEqual(sanitizePlanTraceability(plan, knownAcIds), {
    ...plan,
    requirementIds: [],
    category: "exploratory",
  });
  const unknownCategoryPlan = { ...plan, requirementIds: ["AC-001"] };
  Reflect.set(unknownCategoryPlan, "category", "unknown");
  assert.deepEqual(sanitizePlanTraceability(unknownCategoryPlan, knownAcIds), {
    ...plan,
    requirementIds: ["AC-001"],
    category: "happy_path",
  });
});

test("generateTestPlans dispatches MCP calls and parses Ollama JSON", async () => {
  const calls: string[] = [];
  const ollamaClient = mockOllamaClient([
    {
      content: "",
      tool_calls: [{
        function: {
          name: "browser_navigate",
          arguments: { url: "https://example.com" },
        },
      }],
    },
    {
      content: JSON.stringify({
        plans: [{
          id: "TC-001",
          title: "Page loads",
          description: "Verify the landing page",
          type: "UI",
          testSteps: ["Open the page"],
          expectedResult: "The page is visible",
          requirementIds: [],
          category: "exploratory",
        }],
      }),
    },
  ]);

  const plans = await generateTestPlans(generationPayload, {
    ollamaClient,
    mcpClient: mockMcpClient(calls),
  });

  assert.equal(plans.length, 1);
  assert.equal(plans[0].id, "TC-001");
  assert.deepEqual(calls, ["browser_navigate:https://example.com"]);
});

test("planner and script stages select their configured models", async () => {
  const requests: OllamaChatRequest[] = [];
  const ollamaClient = mockOllamaClient([
    { content: validPlanResponse, thinking: "This private reasoning is not part of the JSON output." },
    { content: JSON.stringify({ id: "TC-001", title: "ตรวจสอบหน้าเว็บ", script: validScript }) },
  ], requests);

  await generateNextTestPlan(generationPayload, "heading Example Domain", [], {
    ollamaClient,
    plannerModel: "planner-test-model",
  });
  await generateSingleScript(generationPayload, {
    id: "TC-001",
    title: "ตรวจสอบหน้าเว็บ",
    description: "ตรวจสอบว่าหน้าเว็บแสดงผล",
    type: "UI",
    testSteps: ["เปิดหน้าเว็บ"],
    expectedResult: "มีหัวข้อแสดงอยู่บนหน้าเว็บ",
  }, {
    ollamaClient,
    scriptModel: "script-test-model",
  });

  assert.equal(requests[0].model, "planner-test-model");
  assert.equal(requests[1].model, "script-test-model");
});

test("both stages use ollamaModel when only the legacy model option is configured", async () => {
  const requests: OllamaChatRequest[] = [];
  const ollamaClient = mockOllamaClient([
    { content: validPlanResponse },
    { content: JSON.stringify({ id: "TC-001", title: "ตรวจสอบหน้าเว็บ", script: validScript }) },
  ], requests);
  const options = { ollamaClient, ollamaModel: "legacy-model" };

  await generateNextTestPlan(generationPayload, "heading Example Domain", [], options);
  await generateSingleScript(generationPayload, {
    id: "TC-001",
    title: "ตรวจสอบหน้าเว็บ",
    description: "ตรวจสอบว่าหน้าเว็บแสดงผล",
    type: "UI",
    testSteps: ["เปิดหน้าเว็บ"],
    expectedResult: "มีหัวข้อแสดงอยู่บนหน้าเว็บ",
  }, options);

  assert.deepEqual(requests.map((request) => request.model), ["legacy-model", "legacy-model"]);
});

test("planner and script stages use their stage defaults when no model is configured", async () => {
  const requests: OllamaChatRequest[] = [];
  const ollamaClient = mockOllamaClient([
    { content: validPlanResponse },
    { content: JSON.stringify({ id: "TC-001", title: "ตรวจสอบหน้าเว็บ", script: validScript }) },
  ], requests);
  const options = { ollamaClient };

  await generateNextTestPlan(generationPayload, "heading Example Domain", [], options);
  await generateSingleScript(generationPayload, {
    id: "TC-001",
    title: "ตรวจสอบหน้าเว็บ",
    description: "ตรวจสอบว่าหน้าเว็บแสดงผล",
    type: "UI",
    testSteps: ["เปิดหน้าเว็บ"],
    expectedResult: "มีหัวข้อแสดงอยู่บนหน้าเว็บ",
  }, options);

  assert.deepEqual(requests.map((request) => request.model), ["qwen3.5:9b", "qwen2.5-coder:7b"]);
});

test("think is sent only to planner when enabled, alongside shared Ollama settings", async () => {
  const requests: OllamaChatRequest[] = [];
  const ollamaClient = mockOllamaClient([
    { content: validPlanResponse },
    { content: JSON.stringify({ id: "TC-001", title: "ตรวจสอบหน้าเว็บ", script: validScript }) },
  ], requests);
  const options = {
    ollamaClient,
    plannerThink: true,
    numCtx: 4096,
    keepAlive: "10m",
  };

  await generateNextTestPlan(generationPayload, "heading Example Domain", [], options);
  await generateSingleScript(generationPayload, {
    id: "TC-001",
    title: "ตรวจสอบหน้าเว็บ",
    description: "ตรวจสอบว่าหน้าเว็บแสดงผล",
    type: "UI",
    testSteps: ["เปิดหน้าเว็บ"],
    expectedResult: "มีหัวข้อแสดงอยู่บนหน้าเว็บ",
  }, options);

  assert.equal(requests[0].think, true);
  assert.equal(requests[1].think, false);
  assert.equal(requests[0].options?.num_ctx, 4096);
  assert.equal(requests[1].options?.num_ctx, 4096);
  assert.equal(requests[0].keep_alive, "10m");
  assert.equal(requests[1].keep_alive, "10m");
});

test("generateSingleScript validates an Ollama-generated Playwright script", async () => {
  const script = `import { test, expect } from '@playwright/test';\n\n` +
    `test('example', async ({ page }) => {\n` +
    `  await page.goto('https://example.com');\n` +
    `  await expect(page).toHaveTitle(/.+/);\n` +
    `});\n`;

  const generated = await generateSingleScript(generationPayload, {
    id: "TC-001",
    title: "Page loads",
    description: "Verify the landing page",
    type: "UI",
    testSteps: ["Open the page"],
    expectedResult: "The page is visible",
  }, {
    ollamaClient: mockOllamaClient([{ content: JSON.stringify({ id: "TC-001", title: "Page loads", script }) }]),
    mcpClient: mockMcpClient(),
  });

  assert.equal(generated.script, script);
  assert.doesNotThrow(() => validateGeneratedScript(generated.script));
});

test("generateSingleScript withholds browser tools and provides the script-generation rules", async () => {
  const script = `import { test, expect } from '@playwright/test';\n\n` +
    `test('page loads', async ({ page }) => {\n` +
    `  await page.goto('https://example.com');\n` +
    `  await expect(page.getByRole('heading', { name: /example/i })).toBeVisible();\n` +
    `});\n`;
  const calls: string[] = [];
  let request: {
    messages: Array<{ role: string; content: string }>;
    tools?: unknown[];
  } | undefined;
  const ollamaClient = {
    chat: async (chatRequest: NonNullable<typeof request>) => {
      request = chatRequest;
      return { message: { content: JSON.stringify({ id: "TC-001", title: "Page loads", script }) } };
    },
  } as unknown as NonNullable<LlmGenerationOptions["ollamaClient"]>;

  await generateSingleScript(generationPayload, {
    id: "TC-001",
    title: "Page loads",
    description: "Verify the page loads",
    type: "UI",
    testSteps: ["Open the page"],
    expectedResult: "The page heading is visible",
  }, {
    ollamaClient,
    mcpClient: mockMcpClient(calls),
  });

  assert.deepEqual(request?.tools, []);
  assert.deepEqual(calls, []);
  const prompt = request?.messages.find((message) => message.role === "user")?.content ?? "";
  const systemPrompt = request?.messages.find((message) => message.role === "system")?.content ?? "";
  assert.match(prompt, /Never use MCP tools/i);
  assert.match(prompt, /page\.goto/);
  assert.match(prompt, /process\.env\.TEST_EMAIL/);
  assert.match(prompt, /snapshot reference IDs/i);
  assert.match(systemPrompt, /Never output MCP tool names/i);
});

test("generateSingleScript preserves the assigned plan when the snapshot is long", async () => {
  const script = `import { test, expect } from '@playwright/test';\n\n` +
    `test('assigned plan', async ({ page }) => {\n` +
    `  await page.goto('https://example.com');\n` +
    `  await expect(page).toHaveTitle(/.+/);\n` +
    `});\n`;
  const plan = {
    id: "TC-KEEP-001",
    title: "UNIQUE_ASSIGNED_PLAN_TITLE",
    description: "UNIQUE_ASSIGNED_PLAN_DESCRIPTION",
    type: "UI" as const,
    testSteps: ["UNIQUE_ASSIGNED_PLAN_STEP"],
    expectedResult: "UNIQUE_ASSIGNED_EXPECTED_RESULT",
  };
  let userPrompt = "";
  const ollamaClient = {
    chat: async (request: { messages: Array<{ role: string; content: string }> }) => {
      userPrompt = request.messages.find((message) => message.role === "user")?.content ?? "";
      return {
        message: {
          content: JSON.stringify({ id: plan.id, title: plan.title, script }),
        },
      };
    },
  } as unknown as NonNullable<LlmGenerationOptions["ollamaClient"]>;

  await generateSingleScript({
    ...generationPayload,
    accessibilitySnapshot: "UNIQUE_SNAPSHOT_ELEMENT\n".repeat(2000),
  }, plan, {
    ollamaClient,
    mcpClient: mockMcpClient(),
  });

  assert.ok(userPrompt.length < 14000);
  assert.match(userPrompt, /UNIQUE_ASSIGNED_PLAN_TITLE/);
  assert.match(userPrompt, /UNIQUE_ASSIGNED_PLAN_DESCRIPTION/);
  assert.match(userPrompt, /UNIQUE_ASSIGNED_PLAN_STEP/);
  assert.match(userPrompt, /UNIQUE_ASSIGNED_EXPECTED_RESULT/);
});

test("generateSingleScript retries once when Ollama returns only imports", async () => {
  const validScript = `import { test, expect } from '@playwright/test';\n\n` +
    `test('example', async ({ page }) => {\n` +
    `  await page.goto('https://example.com');\n` +
    `  await expect(page).toHaveTitle(/.+/);\n` +
    `});\n`;
  const responses = [
    { id: "TC-001", title: "Page loads", script: "import { test, expect } from '@playwright/test';\n\n" },
    { id: "TC-001", title: "Page loads", script: validScript },
  ];
  const prompts: string[] = [];
  const ollamaClient = {
    chat: async (request: { messages: Array<{ role: string; content: string }> }) => {
      prompts.push(request.messages.find((message) => message.role === "user")?.content ?? "");
      return { message: { content: JSON.stringify(responses.shift()) } };
    },
  } as unknown as NonNullable<LlmGenerationOptions["ollamaClient"]>;

  const generated = await generateSingleScript(generationPayload, {
    id: "TC-001",
    title: "Page loads",
    description: "Verify the page loads",
    type: "UI",
    testSteps: ["Open the page"],
    expectedResult: "The page is visible",
  }, {
    ollamaClient,
    mcpClient: mockMcpClient(),
  });

  assert.equal(generated.script, validScript);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /RETRY REQUIRED/);
  assert.match(prompts[1], /failed validation/i);
});

test("generateSingleScript retries token repetition with concise feedback", async () => {
  const validScript = `import { test, expect } from '@playwright/test';\n\n` +
    `test('example', async ({ page }) => {\n` +
    `  await page.goto('https://example.com');\n` +
    `  await expect(page).toHaveTitle(/.+/);\n` +
    `});\n`;
  const prompts: string[] = [];
  let callCount = 0;
  const ollamaClient = {
    chat: async (request: { messages: Array<{ role: string; content: string }> }) => {
      callCount += 1;
      prompts.push(request.messages.find((message) => message.role === "user")?.content ?? "");
      if (callCount === 1) throw new Error("prediction aborted, token repeat limit reached");
      return { message: { content: JSON.stringify({ id: "TC-001", title: "Page loads", script: validScript }) } };
    },
  } as unknown as NonNullable<LlmGenerationOptions["ollamaClient"]>;

  const generated = await generateSingleScript(generationPayload, {
    id: "TC-001",
    title: "Page loads",
    description: "Verify the page loads",
    type: "UI",
    testSteps: ["Open the page"],
    expectedResult: "The page is visible",
  }, {
    ollamaClient,
    mcpClient: mockMcpClient(),
  });

  assert.equal(generated.script, validScript);
  assert.equal(callCount, 2);
  assert.match(prompts[1], /model repeated tokens/i);
});

test("generateTestPlans rejects malformed Ollama JSON", async () => {
  await assert.rejects(
    generateTestPlans(generationPayload, {
      ollamaClient: mockOllamaClient([{ content: "not json" }]),
      mcpClient: mockMcpClient(),
    }),
    /not a valid JSON payload/i,
  );
});

test("generateNextTestPlan returns one bounded case without opening MCP tools", async () => {
  let request: {
    messages: Array<{ role: string; content: string }>;
    options?: Record<string, number>;
  } | undefined;
  const plan = {
    status: "case",
    id: "model-id",
    title: "Required field validation",
    description: "Verify the required field blocks submission when empty",
    type: "UI",
    testSteps: ["Leave the required field empty", "Submit the form"],
    expectedResult: "Validation feedback is shown",
    requirementIds: ["AC-001"],
    category: "validation",
  };
  const ollamaClient = {
    chat: async (chatRequest: { messages: Array<{ role: string; content: string }> }) => {
      request = chatRequest;
      return { message: { content: JSON.stringify(plan) } };
    },
  } as unknown as NonNullable<LlmGenerationOptions["ollamaClient"]>;

  const result = await generateNextTestPlan(
    generationPayload,
    "Discovered snapshot for the checkout form",
    [],
    { ollamaClient, maxPromptChars: 14000 },
  );

  assert.equal(result.status, "case");
  if (result.status !== "case") return;
  assert.equal(result.plan.title, plan.title);
  assert.equal(request?.options?.num_ctx, 8192);
  assert.equal(request?.options?.num_predict, 4096);
  assert.equal(request?.options?.repeat_penalty, 1.15);
  const userPrompt = request?.messages.find((message) => message.role === "user")?.content ?? "";
  assert.ok(userPrompt.length <= 14000);
  assert.match(userPrompt, /Discovered snapshot for the checkout form/);
  assert.match(userPrompt, /one distinct scenario/i);
});

test("generateNextTestPlan prevents completing data-changing flows unless explicitly allowed", async () => {
  let prompt = "";
  const ollamaClient = {
    chat: async (request: { messages: Array<{ role: string; content: string }> }) => {
      prompt = request.messages.find((message) => message.role === "user")?.content ?? "";
      return { message: { content: JSON.stringify({
        status: "case",
        id: "TC-001",
        title: "ตรวจสอบหน้าชำระเงิน",
        description: "หยุดก่อนยืนยันการชำระเงิน",
        type: "UI",
        testSteps: ["กรอกข้อมูลชำระเงิน"],
        expectedResult: "แสดงหน้าสรุปก่อนยืนยัน",
        requirementIds: [],
        category: "exploratory",
      }) } };
    },
  } as unknown as NonNullable<LlmGenerationOptions["ollamaClient"]>;

  await generateNextTestPlan(
    generationPayload,
    "Checkout confirmation button",
    [],
    { ollamaClient },
    undefined,
    new Set(),
    undefined,
    false,
  );
  assert.match(prompt, /Do not plan cases that complete a purchase, payment, deletion, or account change/i);
  assert.match(prompt, /stop at the final confirmation screen and assert it/i);

  await generateNextTestPlan(
    generationPayload,
    "Checkout confirmation button",
    [],
    { ollamaClient },
    undefined,
    new Set(),
    undefined,
    true,
  );
  assert.doesNotMatch(prompt, /Do not plan cases that complete a purchase, payment, deletion, or account change/i);
});

test("generateNextTestPlan returns done when a page has no uncovered cases", async () => {
  const ollamaClient = mockOllamaClient([{
    content: JSON.stringify({
      status: "done",
      id: "",
      title: "",
      description: "",
      type: "UI",
      testSteps: [],
      expectedResult: "",
      requirementIds: [],
      category: "exploratory",
    }),
  }]);

  const result = await generateNextTestPlan(
    generationPayload,
    "Static informational page",
    [{ title: "Page loads", description: "Verify the heading is visible" }],
    { ollamaClient },
  );

  assert.deepEqual(result, { status: "done" });
});

test("generateNextTestPlan enforces a small configured prompt budget", async () => {
  let userPrompt = "";
  const ollamaClient = {
    chat: async (request: { messages: Array<{ role: string; content: string }> }) => {
      userPrompt = request.messages.find((message) => message.role === "user")?.content ?? "";
      return {
        message: {
          content: JSON.stringify({
            status: "done",
            id: "",
            title: "",
            description: "",
            type: "UI",
            testSteps: [],
            expectedResult: "",
            requirementIds: [],
            category: "exploratory",
          }),
        },
      };
    },
  } as unknown as NonNullable<LlmGenerationOptions["ollamaClient"]>;

  await generateNextTestPlan(
    { ...generationPayload, specification: "Requirement ".repeat(1000) },
    "Snapshot ".repeat(1000),
    [],
    { ollamaClient, maxPromptChars: 1200 },
  );

  assert.ok(userPrompt.length <= 1200);
  assert.ok(userPrompt.length < "Snapshot ".repeat(1000).length);
});

test("generateNextTestPlan keeps the most recently covered cases within its prompt budget", async () => {
  let userPrompt = "";
  const ollamaClient = {
    chat: async (request: { messages: Array<{ role: string; content: string }> }) => {
      userPrompt = request.messages.find((message) => message.role === "user")?.content ?? "";
      return {
        message: {
          content: JSON.stringify({
            status: "done",
            id: "",
            title: "",
            description: "",
            type: "UI",
            testSteps: [],
            expectedResult: "",
            requirementIds: [],
            category: "exploratory",
          }),
        },
      };
    },
  } as unknown as NonNullable<LlmGenerationOptions["ollamaClient"]>;

  await generateNextTestPlan(
    generationPayload,
    "Page snapshot",
    Array.from({ length: 100 }, (_, index) => ({
      title: `Covered case ${index + 1}`,
      description: `Description ${index + 1}`,
    })),
    { ollamaClient, maxPromptChars: 3000 },
  );

  assert.ok(userPrompt.length <= 3000);
  assert.match(userPrompt, /Covered case 100/);
  assert.doesNotMatch(userPrompt, /^- Covered case 1$/m);
  assert.doesNotMatch(userPrompt, /Description 100/, "covered cases are listed by title only, not description");
});

test("processSnapshotTestPlans shares coverage across snapshots and rejects semantic duplicates", async () => {
  const done = {
    status: "done", id: "", title: "", description: "", type: "UI", testSteps: [], expectedResult: "",
    requirementIds: [], category: "exploratory", targetElement: "", inputVariant: "",
  };
  const themeCase = (title: string, targetElement: string, inputVariant: string) => ({
    status: "case",
    id: "planner-id",
    title,
    description: "คลิกปุ่มสลับธีมจากโหมดสว่างแล้วตรวจสอบว่าหน้าเว็บเป็นโหมดมืด",
    type: "UI",
    testSteps: ["เปิดหน้าแรก", "คลิกปุ่ม 'Switch between dark and light mode'"],
    expectedResult: "พื้นหลังเป็นสีเข้ม และปุ่มแสดงว่าเป็นโหมดมืด",
    requirementIds: [],
    category: "exploratory",
    targetElement,
    inputVariant,
  });
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const ollamaClient = mockOllamaClient([
    // Page 1
    { content: JSON.stringify(themeCase("ตรวจสอบการสลับธีมสีจากโหมดสว่างเป็นมืด (Dark Mode)", "Switch between dark and light mode", "light -> dark")) },
    { content: JSON.stringify(done) },
    // Page 2: same toggle, reworded title and slightly different label/variant wording
    { content: JSON.stringify(themeCase("ตรวจสอบการเปลี่ยนโหมดสี (Dark/Light Mode)", "Switch between dark and light mode (currently light mode)", "light mode -> dark mode")) },
    { content: JSON.stringify(done) },
  ], requests as never);
  const coverage = new PlanCoverageRegistry();
  const persisted: string[] = [];
  const persist = async (plan: TestPlan) => {
    persisted.push(plan.title);
    return true;
  };

  await processSnapshotTestPlans(generationPayload, "Home page", { ollamaClient }, persist, [], new Set(), true, coverage);
  await processSnapshotTestPlans(generationPayload, "Docs page", { ollamaClient }, persist, [], new Set(), true, coverage);

  assert.deepEqual(persisted, ["ตรวจสอบการสลับธีมสีจากโหมดสว่างเป็นมืด (Dark Mode)"]);
  const page2Prompt = requests[2].messages.find((message) => message.role === "user")?.content ?? "";
  assert.match(page2Prompt, /- ตรวจสอบการสลับธีมสีจากโหมดสว่างเป็นมืด \(Dark Mode\) \[Switch between dark and light mode \| light -> dark\]/);
  const page2RetryPrompt = requests[3].messages.find((message) => message.role === "user")?.content ?? "";
  assert.doesNotMatch(page2RetryPrompt, /เปลี่ยนโหมดสี/, "rejected duplicates are not added to the covered list");
});

test("processSnapshotTestPlans persists each case before requesting the next and has no small fixed cap", async () => {
  const events: string[] = [];
  const cases = Array.from({ length: 12 }, (_, index) => ({
    status: "case",
    id: `model-${index + 1}`,
    title: `Distinct behavior ${index + 1}`,
    description: `Verify behavior ${index + 1}`,
    type: "UI",
    testSteps: [`Exercise behavior ${index + 1}`],
    expectedResult: `Behavior ${index + 1} is correct`,
    requirementIds: [],
    category: "exploratory",
  }));
  const ollamaClient = {
    chat: async () => {
      const next = cases.shift();
      events.push(next ? `model:${next.title}` : "model:done");
      return {
        message: {
          content: JSON.stringify(next ?? {
            status: "done",
            id: "",
            title: "",
            description: "",
            type: "UI",
            testSteps: [],
            expectedResult: "",
            requirementIds: [],
            category: "exploratory",
          }),
        },
      };
    },
  } as unknown as NonNullable<LlmGenerationOptions["ollamaClient"]>;

  const result = await processSnapshotTestPlans(
    generationPayload,
    "Large page snapshot",
    { ollamaClient },
    async (plan) => {
      events.push(`persist:${plan.title}`);
      return true;
    },
  );

  assert.deepEqual(result, { status: "complete", planCount: 12 });
  assert.equal(events.filter((event) => event.startsWith("persist:")).length, 12);
  for (let index = 0; index < 12; index += 1) {
    assert.match(events[index * 2], /^model:Distinct behavior/);
    assert.match(events[index * 2 + 1], /^persist:Distinct behavior/);
  }
  assert.equal(events.at(-1), "model:done");
});

test("processSnapshotTestPlans sanitizes traceability before persisting a plan", async () => {
  const responses = [
    {
      status: "case",
      id: "model-id",
      title: "Check required input",
      description: "Validate a required field",
      type: "UI",
      testSteps: ["Submit empty form"],
      expectedResult: "An error is displayed",
      requirementIds: ["AC-001", "AC-unknown", "AC-001"],
      category: "validation",
    },
    {
      status: "done",
      id: "",
      title: "",
      description: "",
      type: "UI",
      testSteps: [],
      expectedResult: "",
      requirementIds: [],
      category: "exploratory",
    },
  ];
  const ollamaClient = mockOllamaClient(responses.map((response) => ({ content: JSON.stringify(response) })));
  const persisted: TestPlan[] = [];

  await processSnapshotTestPlans(
    generationPayload,
    "Form snapshot",
    { ollamaClient },
    async (plan) => {
      persisted.push(plan);
      return true;
    },
    new Set(["AC-001"]),
  );

  assert.equal(persisted.length, 1);
  assert.deepEqual(persisted[0].requirementIds, ["AC-001"]);
  assert.equal(persisted[0].category, "validation");
});

test("processSnapshotTestPlans updates the shared covered AC set after persistence", async () => {
  const coveredAcIds = new Set<string>();
  const ollamaClient = mockOllamaClient([
    {
      content: JSON.stringify({
        status: "case",
        id: "planner-id",
        title: "เข้าสู่ระบบสำเร็จ",
        description: "ตรวจสอบการเข้าสู่ระบบ",
        type: "UI",
        testSteps: ["กรอกข้อมูลและเข้าสู่ระบบ"],
        expectedResult: "แสดงแดชบอร์ด",
        requirementIds: ["AC-001"],
        category: "happy_path",
      }),
    },
    {
      content: JSON.stringify({
        status: "done",
        id: "",
        title: "",
        description: "",
        type: "UI",
        testSteps: [],
        expectedResult: "",
        requirementIds: [],
        category: "exploratory",
      }),
    },
  ]);

  await processSnapshotTestPlans(
    generationPayload,
    "Login snapshot",
    { ollamaClient },
    async () => true,
    acceptanceCriteria,
    coveredAcIds,
  );

  assert.deepEqual([...coveredAcIds], ["AC-001"]);
});

test("processSnapshotTestPlans reports incomplete when planning stalls on duplicates", async () => {
  const duplicate = {
    status: "case",
    id: "duplicate-id",
    title: "Same scenario",
    description: "Repeat the same behavior",
    type: "UI",
    testSteps: ["Repeat the same behavior"],
    expectedResult: "The same result",
  };
  const ollamaClient = mockOllamaClient(
    Array.from({ length: 6 }, () => ({ content: JSON.stringify(duplicate) })),
  );
  let persistedCount = 0;

  const result = await processSnapshotTestPlans(
    generationPayload,
    "Page snapshot",
    { ollamaClient },
    async () => {
      persistedCount += 1;
      return true;
    },
  );

  assert.equal(result.status, "incomplete");
  assert.equal(result.planCount, 1);
  assert.equal(persistedCount, 1);
});

test("generator starts at the page the snapshot was captured on and uses only listed test IDs", () => {
  const snapshot = [
    "### Page",
    "- Page URL: https://www.saucedemo.com/inventory.html",
    "### Test IDs",
    "- [data-test=\"inventory-item\"] <div> x6 \"Sauce Labs Backpack\"",
    "### Snapshot",
    "```yaml",
    "- button \"Add to cart\" [ref=e1]",
    "```",
  ].join("\n");
  assert.equal(snapshotPageUrl(snapshot), "https://www.saucedemo.com/inventory.html");
  assert.equal(snapshotPageUrl("heading Example Domain"), "");
  assert.equal(snapshotPageUrl("- Page URL: chrome-error://chromewebdata/"), "");

  const plan: TestPlan = {
    id: "TC-001", title: "Add to cart", description: "Add a product", type: "UI",
    testSteps: ["Click Add to cart"], expectedResult: "Cart shows 1",
  };
  const prompt = buildGeneratorPrompt({ ...generationPayload, accessibilitySnapshot: snapshot }, plan, 14000);
  assert.match(prompt, /Start URL: https:\/\/www\.saucedemo\.com\/inventory\.html/);
  assert.match(prompt, /already logged in/);
  assert.match(prompt, /Do not use loops or arrays to create several test\(\) calls/);
  assert.match(prompt, /only attribute selectors listed in its `### Test IDs` section/);
  assert.match(prompt, /\[data-test="inventory-item"\] <div> x6/);

  // Without a captured page URL, fall back to the target URL.
  assert.match(buildGeneratorPrompt(generationPayload, plan, 14000), /Start URL: https:\/\/example\.com/);
});
