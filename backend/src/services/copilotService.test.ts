import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAgentGenerationPrompt,
  generateSingleScript,
  generateTestPlans,
  normalizeGeneratedScript,
  parseJsonArrayResponse,
  validateGeneratedScript,
  type LlmGenerationOptions,
} from "./copilotService.js";

const generationPayload = {
  projectName: "Demo app",
  targetUrl: "https://example.com",
  specification: "Confirm the page loads",
  accessibilitySnapshot: "heading Example Domain",
};

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
  responses: Array<{ content: string; tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }> }>,
): NonNullable<LlmGenerationOptions["ollamaClient"]> => ({
  chat: async () => ({ message: responses.shift()! }),
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

test("generateSingleScript withholds browser tools", async () => {
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
  assert.match(prompt, /Never use MCP tools/i);
  assert.match(prompt, /process\.env\.TEST_EMAIL/);
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
