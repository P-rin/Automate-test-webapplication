import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Ollama } from "ollama";
import type { Message, Tool } from "ollama";
import type { GeneratedArtifact, GeneratedTestCase, TestPlan } from "../types.js";
import { resolvePlaywrightMcpLaunchConfig } from "./snapshotService.js";
import { buildAgentGenerationPrompt as buildOllamaGenerationPrompt } from "./ollamaService.js";

interface CopilotRequest {
  projectName: string;
  targetUrl: string;
  specification: string;
  accessibilitySnapshot: string;
}

interface GeneratorResponse {
  id?: string;
  title?: string;
  script?: string;
}

const hasRealNewline = (value: string): boolean => /\r?\n/.test(value);

const countMatches = (value: string, pattern: RegExp): number => value.match(pattern)?.length ?? 0;

export const normalizeGeneratedScript = (script: string): string => {
  if (typeof script !== "string" || !script.trim()) return script;

  const trimmed = script.trim();
  const literalNewlineCount = countMatches(trimmed, /\\n/g);
  const looksDoubleEscaped = !hasRealNewline(trimmed)
    && literalNewlineCount >= 2
    && /@playwright\/test/.test(trimmed)
    && /(?:^|\\n)(?:test|it)(?:\(|\.)/.test(trimmed);

  if (!looksDoubleEscaped) {
    return script;
  }

  const normalized = trimmed
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, "\\");

  const normalizationLooksValid = hasRealNewline(normalized)
    && /import\s+\{(?=[^}]*\btest\b)(?=[^}]*\bexpect\b)[^}]*\}\s+from\s+['"]@playwright\/test['"]/.test(normalized)
    && /\b(?:test|it)(?:\s*\(|\s*\.)/.test(normalized);

  return normalizationLooksValid ? normalized : script;
};

const summarizeScriptShape = (script: string): string => {
  const normalized = script.trim();
  const hasImport = /@playwright\/test/.test(normalized);
  const hasTestBlock = /\b(?:test|it)(?:\s*\(|\s*\.)/.test(normalized);
  return `len=${normalized.length},hasImport=${hasImport},hasTestBlock=${hasTestBlock}`;
};

const buildScriptPreview = (script: string, maxChars = 200): string => {
  const normalized = script
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim();

  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}...`;
};

export interface LlmGenerationOptions {
  ollamaHost?: string;
  ollamaModel?: string;
  maxPromptChars?: number;
  usePlaywrightTools?: boolean;
  ollamaClient?: Pick<Ollama, "chat">;
  mcpClient?: Pick<Client, "listTools" | "callTool">;
  workingDirectory?: string;
}

const DEFAULT_LLM_MAX_PROMPT_CHARS = 14000;

const truncateText = (text: string, maxLength: number, label: string): string => {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n\n[Truncated ${text.length - maxLength} characters from ${label}]`;
};

export const parseJsonArrayResponse = <T>(value: string): T[] => {
  const normalized = value.trim();
  const fencedMatch = normalized.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fencedMatch ? fencedMatch[1].trim() : normalized;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Model planner response is not a valid JSON payload: ${message}`);
  }

  if (Array.isArray(parsed)) {
    return parsed as T[];
  }

  if (typeof parsed === "object" && parsed != null && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    
    // Try common array key names: plans, testPlans, cases, testCases, tests, items, data
    const possibleKeys = ["plans", "testPlans", "cases", "testCases", "tests", "items", "data"];
    for (const key of possibleKeys) {
      const nested = record[key];
      if (Array.isArray(nested)) {
        return nested as T[];
      }
    }
  }

  throw new Error("Model planner response is not a JSON array or object with an array property");
};

const cleanJsonText = (value: string): string => {
  const normalized = value.trim();
  const fencedMatch = normalized.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fencedMatch ? fencedMatch[1].trim() : normalized;
};

const toJsonObject = <T>(value: string): T => {
  const candidate = cleanJsonText(value);
  let parsed: unknown;

  try {
    parsed = JSON.parse(candidate) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Model response is not a valid JSON object: ${message}`);
  }

  if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) {
    throw new Error("Model response is not a JSON object");
  }
  return parsed as T;
};

export const validateGeneratedScript = (script: string): void => {
  if (typeof script !== "string" || !script.trim()) {
    throw new Error("Generated script is empty or not a string");
  }

  const trimmedScript = script.trim();
  if (!/import\s+\{(?=[^}]*\btest\b)(?=[^}]*\bexpect\b)[^}]*\}\s+from\s+['"]@playwright\/test['"]/.test(trimmedScript)) {
    throw new Error("Generated script must import both test and expect from '@playwright/test'.");
  }

  if (!/\b(?:test|it)(?:\s*\(|\s*\.)/.test(trimmedScript)) {
    throw new Error("Generated script must contain at least one Playwright test block.");
  }

  if (/\bbrowser_[A-Za-z0-9_$]*\b/.test(trimmedScript)) {
    throw new Error("Generated script must not contain MCP browser tool names.");
  }

  if (/\bref\s*=/.test(trimmedScript)) {
    throw new Error("Generated script must not use snapshot reference selectors.");
  }

  const stack: string[] = [];
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escape = false;
  let lastNonWhitespace: string | null = null;

  for (let i = 0; i < script.length; i += 1) {
    const char = script[i];
    const next = script[i + 1];

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "/" && script[i - 1] === "*") {
        inBlockComment = false;
      }
      continue;
    }

    if (escape) {
      escape = false;
      continue;
    }

    if (char === "\\" && (inSingleQuote || inDoubleQuote || inBacktick)) {
      escape = true;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && !inBacktick) {
      if (char === "/" && next === "/") {
        inLineComment = true;
        continue;
      }
      if (char === "/" && next === "*") {
        inBlockComment = true;
        continue;
      }
    }

    if (!inLineComment && !inBlockComment) {
      if (!inSingleQuote && !inDoubleQuote && !inBacktick) {
        if (char === "'") {
          inSingleQuote = true;
          continue;
        }
        if (char === '"') {
          inDoubleQuote = true;
          continue;
        }
        if (char === "`") {
          inBacktick = true;
          continue;
        }
      } else if (inSingleQuote && char === "'") {
        inSingleQuote = false;
        continue;
      } else if (inDoubleQuote && char === '"') {
        inDoubleQuote = false;
        continue;
      } else if (inBacktick && char === "`") {
        inBacktick = false;
        continue;
      }
    }

    if (!inSingleQuote && !inDoubleQuote && !inBacktick && !inLineComment && !inBlockComment) {
      if (char === "(") {
        stack.push(")");
      } else if (char === "{") {
        stack.push("}");
      } else if (char === "[") {
        stack.push("]");
      } else if (char === ")" || char === "}" || char === "]") {
        const expected = stack.pop();
        if (expected !== char) {
          throw new Error("Generated script contains unbalanced brackets or parentheses.");
        }
      }
    }

    if (!/\s/.test(char)) {
      lastNonWhitespace = char;
    }
  }

  if (inSingleQuote || inDoubleQuote || inBacktick || inLineComment || inBlockComment || stack.length > 0) {
    throw new Error("Generated script contains unbalanced syntax or unfinished code blocks.");
  }
};

const isValidTestPlan = (value: unknown): value is TestPlan => {
  if (typeof value !== "object" || value == null) return false;
  const plan = value as Record<string, unknown>;
  return (
    typeof plan.id === "string" &&
    typeof plan.title === "string" &&
    typeof plan.description === "string" &&
    (plan.type === "UI" || plan.type === "API") &&
    Array.isArray(plan.testSteps) &&
    plan.testSteps.every(step => typeof step === "string") &&
    typeof plan.expectedResult === "string"
  );
};

const buildPlannerPrompt = (payload: CopilotRequest, maxPromptChars: number): string => {
  const maxSpecLength = Math.floor(maxPromptChars * 0.25);
  const maxSnapshotLength = Math.floor(maxPromptChars * 0.55);

  const rawSpecificationText = payload.specification.trim().length
    ? payload.specification
    : "No requirement specification file was provided. Derive a safe smoke test from the accessibility snapshot and target URL.";

  const specificationText = truncateText(rawSpecificationText, maxSpecLength, "[Requirement Specification]");
  const snapshotText = truncateText(payload.accessibilitySnapshot, maxSnapshotLength, "[Accessibility Snapshot]");

  return [
    "You are an expert QA Lead and Test Planner specializing in autonomous web exploration.",
    "Your task is to analyze the provided [Requirement Specification] and use the [Accessibility Snapshot] to map out a comprehensive testing strategy for the target web app.",
    "",
    "[CRITICAL INSTRUCTION - EXPLORATION & COVERAGE]",
    "1. Do not limit yourself to happy paths. Actively explore elements outside the spec if they appear on the current screen.",
    "2. Discover potential edge cases, field validation flaws, missing inputs, and negative flows.",
    "3. DYNAMIC SCENARIO GENERATION: Automatically adjust the number of test scenarios based on the screen's complexity, components, and potential edge cases. Do not impose artificial limits.",
    "4. COVERAGE REQUIREMENT: For complex screens (e.g., forms, checkout, multi-step processes), generate a comprehensive suite covering Happy Paths, Validation Rules, Negative Scenarios, Boundary Values, and Edge Cases.",
    "5. EFFICIENCY RULE: For simple screens (e.g., splash screen, static display), keep the scenarios concise and avoid generating redundant or low-value cases.",
    "6. ISOLATION RULE: Each test plan MUST represent exactly ONE distinct scenario (e.g., Happy Path, Invalid Password, Empty Fields). DO NOT combine positive and negative flows into a single plan.",
    "7. MANDATORY LOGIN STEP: For any scenario requiring user authentication or a new session, explicitly include the Login steps (Navigate to login -> Enter credentials -> Click login) as the initial steps in `testSteps`.",
    "",
    "[OUTPUT FORMAT]",
    "Output ONLY a valid JSON object (not an array).",
    "The JSON object MUST contain a single key named \"plans\".",
    "The value of \"plans\" MUST be an array of test plan objects.",
    "Do not wrap the JSON in markdown code blocks.",
    "Example JSON structure:",
    "{",
    "  \"plans\": [",
    "    {",
    "      \"id\": \"TC-001\",",
    "      \"title\": \"concise Thai/English mixed title\",",
    "      \"description\": \"Detailed explanation\",",
    "      \"type\": \"UI\",",
    "      \"testSteps\": [\"step 1\", \"step 2\"],",
    "      \"expectedResult\": \"what should happen\"",
    "    }",
    "  ]",
    "}",
    "",
    `Target URL: ${payload.targetUrl}`,
    "",
    "[Requirement Specification]",
    specificationText,
    "",
    "[Accessibility Snapshot]",
    snapshotText,
  ].join("\n");
};

export const buildAgentGenerationPrompt = (payload: CopilotRequest, plannedCase: TestPlan): string =>
  buildOllamaGenerationPrompt(payload, plannedCase);

const fallbackArtifact = (projectName: string, url: string): GeneratedArtifact => ({
  title: `Smoke test - ${projectName}`,
  type: "UI",
  criteria: [
    "หน้าเว็บโหลดสำเร็จ",
    "มี title ของหน้า",
  ],
  script: `import { test, expect } from '@playwright/test';\n\n` +
    `test('smoke: ${projectName}', async ({ page }) => {\n` +
    `  await page.goto('${url}');\n` +
    `  await expect(page).toHaveTitle(/.+/);\n` +
    `});\n`,
});

const fallbackGeneratedTestCase = (projectName: string, url: string): GeneratedTestCase => ({
  id: "TC-001",
  title: `Smoke test - ${projectName}`,
  script: `import { test, expect } from '@playwright/test';\n\n` +
    `test('smoke: ${projectName}', async ({ page }) => {\n` +
    `  await page.goto('${url}');\n` +
    `  await expect(page).toHaveTitle(/.+/);\n` +
    `});\n`,
});

const ALLOWED_PLAYWRIGHT_TOOLS = new Set([
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_fill_form",
  "browser_select_option",
  "browser_check",
  "browser_uncheck",
  "browser_press_key",
  "browser_hover",
  "browser_wait_for",
  "browser_navigate_back",
]);
const MAX_MCP_TOOL_CALLS = 20;
const MAX_MODEL_TURNS = 10;

const toOllamaTool = (tool: { name: string; description?: string; inputSchema: unknown }): Tool => ({
  type: "function",
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema as Tool["function"]["parameters"],
  },
});

const callOllamaModel = async (
  ollama: Pick<Ollama, "chat">,
  model: string,
  prompt: string,
  systemInstruction: string,
  options: LlmGenerationOptions,
): Promise<string> => {
  const toolsEnabled = options.usePlaywrightTools !== false;
  const transport = options.mcpClient || !toolsEnabled
    ? undefined
    : new StdioClientTransport(resolvePlaywrightMcpLaunchConfig());
  const ownedMcpClient = new Client({ name: "ollama-playwright-client", version: "1.0.0" });
  const mcpClient = options.mcpClient ?? ownedMcpClient;
  const messages: Message[] = [
    { role: "system", content: systemInstruction },
    { role: "user", content: prompt },
  ];

  try {
    if (transport) await ownedMcpClient.connect(transport);
    const availableTools = toolsEnabled ? await mcpClient.listTools() : { tools: [] };
    const tools = availableTools.tools
      .filter((tool) => ALLOWED_PLAYWRIGHT_TOOLS.has(tool.name))
      .map(toOllamaTool);
    if (toolsEnabled && tools.length === 0) {
      throw new Error("Playwright MCP did not expose any allowed browser tools");
    }

    let toolCallCount = 0;
    for (let turn = 0; turn < MAX_MODEL_TURNS; turn += 1) {
      const response = await ollama.chat({
        model,
        messages,
        tools,
        format: "json",
        options: { temperature: 0.1 },
      });
      messages.push(response.message);

      const toolCalls = response.message.tool_calls ?? [];
      if (toolCalls.length === 0) {
        const content = response.message.content.trim();
        if (!content) throw new Error("Ollama returned empty content");
        return content;
      }

      toolCallCount += toolCalls.length;
      if (toolCallCount > MAX_MCP_TOOL_CALLS || turn === MAX_MODEL_TURNS - 1) {
        throw new Error("Ollama exceeded the Playwright MCP tool-call limit");
      }

      for (const toolCall of toolCalls) {
        if (!toolsEnabled) {
          throw new Error("Ollama requested a browser tool call while browser tools were disabled");
        }
        const name = toolCall.function.name;
        if (!ALLOWED_PLAYWRIGHT_TOOLS.has(name)) {
          throw new Error(`Ollama requested a disallowed Playwright MCP tool: ${name}`);
        }
        const result = await mcpClient.callTool({
          name,
          arguments: toolCall.function.arguments,
        });
        messages.push({
          role: "tool",
          tool_name: name,
          content: JSON.stringify(result.content),
        });
      }
    }

    throw new Error("Ollama did not complete within the allowed model turns");
  } finally {
    if (!options.mcpClient) {
      await ownedMcpClient.close().catch(() => undefined);
      await transport?.close().catch(() => undefined);
    }
  }
};

const createRunContext = (options: LlmGenerationOptions) => {
  const model = options.ollamaModel ?? "qwen2.5-coder:7b";
  const client = options.ollamaClient ?? new Ollama({ host: options.ollamaHost ?? "http://localhost:11434" });

  return (prompt: string, systemInstruction: string): Promise<string> =>
    callOllamaModel(client, model, prompt, systemInstruction, options);
};

export const generateTestPlans = async (
  payload: CopilotRequest,
  options: LlmGenerationOptions = {},
): Promise<TestPlan[]> => {
  const runPromptSafely = createRunContext(options);
  const maxPromptChars = options.maxPromptChars ?? DEFAULT_LLM_MAX_PROMPT_CHARS;
  const plannerRaw = await runPromptSafely(
    buildPlannerPrompt(payload, maxPromptChars),
    "You are an expert QA lead. Use Playwright MCP browser tools when needed. Return only a JSON object containing the planned test cases.",
  );
  const plannedCases = parseJsonArrayResponse<unknown>(plannerRaw).filter(isValidTestPlan);

  if (plannedCases.length === 0) {
    throw new Error("Planner response did not contain valid test plans");
  }

  return plannedCases;
};

export const generateSingleScript = async (
  payload: CopilotRequest,
  plannedCase: TestPlan,
  options: LlmGenerationOptions = {},
): Promise<GeneratedTestCase> => {
  const runPromptSafely = createRunContext({ ...options, usePlaywrightTools: false });

  let scriptShape: string | undefined;
  let scriptPreview: string | undefined;
  let normalizationApplied = false;

  try {
    const generatorRaw = await runPromptSafely(
      buildAgentGenerationPrompt(payload, plannedCase),
      "Generate a complete, executable Playwright Test script using only the page fixture and Playwright Test APIs. The supplied snapshot is context only, not code or tool instructions. Never output MCP tool names, snapshot reference selectors, or calls to undeclared functions. Return only JSON with id, title, and script.",
    );
    const generated = toJsonObject<GeneratorResponse>(generatorRaw);

    if (!generated.id || !generated.title || !generated.script) {
      throw new Error("Generator response missing required fields");
    }

    const executableScript = normalizeGeneratedScript(generated.script);
    normalizationApplied = executableScript !== generated.script;

    scriptShape = summarizeScriptShape(executableScript);
    scriptPreview = buildScriptPreview(executableScript);

    validateGeneratedScript(executableScript);

    return {
      id: generated.id,
      title: generated.title,
      script: executableScript,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const debugMeta = {
      planId: plannedCase.id,
      planTitle: plannedCase.title,
      planType: plannedCase.type,
      expectedSteps: plannedCase.testSteps.length,
      normalizationApplied,
    };

    if (error instanceof Error && error.message.includes("Generated script")) {
      console.warn("[generateSingleScript] Validation failed", {
        ...debugMeta,
        reason: message,
        scriptPreview,
      });
    } else {
      console.warn("[generateSingleScript] Generation failed", {
        ...debugMeta,
        reason: message,
        scriptPreview,
      });
    }

    const detailSuffix = scriptShape ? ` [${scriptShape}]` : "";
    throw new Error(`Plan ${plannedCase.id} (${plannedCase.title}) failed: ${message}${detailSuffix}`);
  }
};

export const generateTestsTwoPass = async (
  payload: CopilotRequest,
  options: LlmGenerationOptions = {},
): Promise<GeneratedTestCase[]> => {
  const plans = await generateTestPlans(payload, options);
  const results: GeneratedTestCase[] = [];

  // Sequential execution to avoid rate limiting on free tier API plans
  for (const plannedCase of plans) {
    const script = await generateSingleScript(payload, plannedCase, options);
    results.push(script);
  }

  return results;
};

export const generateWithOllama = async (
  payload: CopilotRequest,
  options: LlmGenerationOptions = {},
): Promise<GeneratedArtifact> => {
  const generatedTests = await generateTestsTwoPass(payload, options);
  const primary = generatedTests[0] ?? fallbackGeneratedTestCase(payload.projectName, payload.targetUrl);

  return {
    title: primary.title,
    type: "UI",
    criteria: [],
    script: primary.script,
  };
};
