import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAgentGenerationPrompt,
  generateNextTestPlan,
  processSnapshotTestPlans,
  generateSingleScript,
  generateTestPlans,
  normalizeGeneratedScript,
  parseJsonArrayResponse,
  validateGeneratedScript,
  type LlmGenerationOptions,
} from "./ollamaService.js";

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
    { ollamaClient, maxPromptChars: 1200 },
  );

  assert.ok(userPrompt.length <= 1200);
  assert.match(userPrompt, /Covered case 100/);
  assert.doesNotMatch(userPrompt, /Covered case 1:/);
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
