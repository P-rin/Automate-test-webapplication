import OpenAI from "openai";
import { CopilotClient, approveAll } from "@github/copilot-sdk";
import type { GeneratedArtifact, GeneratedTestCase, TestPlan } from "../types.js";

type LlmProvider = "auto" | "copilot" | "github-models";

interface CopilotRequest {
  projectName: string;
  targetUrl: string;
  specification: string;
  accessibilitySnapshot: string;
}

interface CopilotResponse {
  title?: string;
  type?: "UI" | "API";
  criteria?: string[];
  script?: string;
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
  provider?: string;
  apiToken?: string;
  copilotApiUrl?: string;
  githubModelsApiUrl?: string;
  copilotModel?: string;
  githubModelsModel?: string;
  maxPromptChars?: number;
  preferCopilotSdk?: boolean;
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
    throw new Error(`Copilot planner response is not a valid JSON payload: ${message}`);
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

  throw new Error("Copilot planner response is not a JSON array or object with an array property");
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
    throw new Error(`Copilot response is not a valid JSON object: ${message}`);
  }

  if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) {
    throw new Error("Copilot response is not a JSON object");
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

const buildGeneratorPrompt = (payload: CopilotRequest, plannedCase: TestPlan, maxPromptChars: number): string => {
  // Allocate carefully: 50% for snapshot, 30% for plan, 20% for instructions
  const maxSnapshotLength = Math.floor(maxPromptChars * 0.5);
  const snapshotText = truncateText(payload.accessibilitySnapshot, maxSnapshotLength, "[Accessibility Snapshot]");

  return [
    "You are an expert Automation Engineer generating strict Playwright test scripts (.spec.ts) in TypeScript.",
    "Your ONLY source of truth is the [Assigned Test Plan Object] and the [Accessibility Snapshot].",
    "",
    "[SCRIPT WRITING RULES]",
    "1. ATOMIC TEST PRINCIPLE: Create ONLY ONE concise `test(...)` block per file/plan focusing STRICTLY on the assigned scenario.",
    "2. STATE RESET: Always navigate to the starting page (`await page.goto(...)`) at the beginning of the test.",
    "3. NO FLOW CHAINING: Do NOT combine multiple scenarios (e.g., success login followed by failed login) inside the same `test(...)` function.",
    "4. INDEPENDENT EXECUTION: The test must assume a fresh browser context without relying on previous steps or session states.",
    "5. SESSION & AUTHENTICATION RULE: If the test scenario requires an authenticated session or starts a new session context, the script MUST explicitly perform the login steps at the beginning of the test. Never assume the browser is already logged in.",
    "",
    "[OUTPUT FORMAT]",
    "Output ONLY raw JSON with exact keys: id, title, script.",
    "Do not wrap output in markdown, code fences, or additional text.",
    "The script value must be a valid JSON string with escaped newlines (\\n) and valid TypeScript Playwright code.",
    "The generated script should begin with: import { test, expect } from '@playwright/test';",
    "Example output:",
    "{",
    "  \"id\": \"TC-001\",",
    "  \"title\": \"Verify home page loads\",",
    "  \"script\": \"import { test, expect } from '@playwright/test';\\n\\n",
    "               test('verify home page loads', async ({ page }) => {\\n",
    "                 await page.goto('https://example.com');\\n",
    "                 await expect(page).toHaveTitle(/.+/);\\n",
    "               });\\n\"",
    "}",
    "",
    "Generate ONLY the essential test logic. Keep the script concise and focused on the test steps.",
    "",
    `Target URL: ${payload.targetUrl}`,
    "",
    "[Assigned Test Plan Object]",
    JSON.stringify(plannedCase, null, 2),
    "",
    "[Accessibility Snapshot]",
    snapshotText,
  ].join("\n");
};

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

const isUnsupportedTokenError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  return (
    lower.includes("checking third-party user token") ||
    lower.includes("personal access tokens are not supported") ||
    lower.includes("third-party user token")
  );
};

const isPatToken = (token: string): boolean => {
  return token.startsWith("ghp_") || token.startsWith("github_pat_");
};

const asProvider = (provider: string | undefined): LlmProvider => {
  const raw = (provider ?? "auto").trim().toLowerCase();
  if (raw === "copilot" || raw === "github-models") return raw;
  return "auto";
};

const createClient = (apiKey: string, baseURL?: string): OpenAI => {
  return new OpenAI({
    apiKey,
    baseURL,
  });
};

const extractAssistantText = (content: unknown): string => {
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    const combined = content
      .map((item) => {
        if (typeof item === "string") return item;
        if (typeof item === "object" && item != null) {
          const value = (item as { text?: unknown }).text;
          return typeof value === "string" ? value : "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");

    return combined;
  }

  return "";
};

const callCopilotSdkModel = async (
  apiToken: string,
  model: string,
  prompt: string,
  systemInstruction: string,
): Promise<string> => {
  const client = new CopilotClient({
    gitHubToken: apiToken,
    useLoggedInUser: false,
  });

  await client.start();

  try {
    const session = await client.createSession({
      model,
      onPermissionRequest: approveAll,
      systemMessage: {
        mode: "append",
        content: systemInstruction,
      },
    });

    try {
      const response = await session.sendAndWait({ prompt }, 120_000);
      const rawText = extractAssistantText(response?.data?.content);
      if (!rawText.trim()) {
        throw new Error("Copilot SDK returned empty content");
      }

      return rawText;
    } finally {
      await session.disconnect();
    }
  } finally {
    await client.stop();
  }
};

const callChatModel = async (
  client: OpenAI,
  model: string,
  prompt: string,
  systemInstruction: string,
): Promise<string> => {
  try {
    const completion = await client.chat.completions.create({
      model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: systemInstruction,
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    const rawText = completion.choices[0]?.message?.content;
    if (!rawText) {
      throw new Error("Model SDK returned empty content");
    }

    return rawText;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/request body too large/i.test(message) || /413/.test(message)) {
      throw new Error(
        "LLM request too large for the model context window. Reduce the specification or snapshot size, or set a lower LLM_MAX_PROMPT_CHARS."
      );
    }
    throw error;
  }
};

const getResolvedProvider = (
  provider: string | undefined,
  apiToken: string,
): Exclude<LlmProvider, "auto"> => {
  const normalized = asProvider(provider);
  return normalized === "auto" ? (isPatToken(apiToken) ? "github-models" : "copilot") : normalized;
};

const createRunContext = (
  apiToken: string,
  options: LlmGenerationOptions,
) => {
  const provider = asProvider(options.provider);
  const resolvedProvider = getResolvedProvider(options.provider, apiToken);
  const copilotModel = options.copilotModel ?? "gpt-4.1";
  const githubModelsModel = options.githubModelsModel ?? "openai/gpt-4.1";
  const preferCopilotSdk = options.preferCopilotSdk ?? true;

  const runWithCopilot = async (prompt: string): Promise<string> => {
    if (preferCopilotSdk) {
      try {
        return await callCopilotSdkModel(
          apiToken,
          copilotModel,
          prompt,
          "You are GitHub Copilot for software test planning and generation.",
        );
      } catch (error) {
        if (provider === "copilot") {
          throw error;
        }
      }
    }

    const client = createClient(apiToken, options.copilotApiUrl);
    return callChatModel(client, copilotModel, prompt, "You are GitHub Copilot for software test planning and generation.");
  };

  const runWithGitHubModels = async (prompt: string): Promise<string> => {
    const client = createClient(apiToken, options.githubModelsApiUrl);
    return callChatModel(client, githubModelsModel, prompt, "You are an expert QA engineer for Playwright test generation.");
  };

  const runForPrompt = async (prompt: string): Promise<string> => {
    if (resolvedProvider === "github-models") {
      return runWithGitHubModels(prompt);
    }
    return runWithCopilot(prompt);
  };

  return async (prompt: string): Promise<string> => {
    try {
      return await runForPrompt(prompt);
    } catch (error) {
      if (isUnsupportedTokenError(error) && provider === "auto") {
        return runWithGitHubModels(prompt);
      }
      throw error;
    }
  };
};

export const generateTestPlans = async (
  payload: CopilotRequest,
  options: LlmGenerationOptions = {},
): Promise<TestPlan[]> => {
  const apiToken = options.apiToken;
  if (!apiToken) {
    throw new Error("Missing API token for model generation");
  }

  const runPromptSafely = createRunContext(apiToken, options);
  const maxPromptChars = options.maxPromptChars ?? DEFAULT_LLM_MAX_PROMPT_CHARS;
  const plannerRaw = await runPromptSafely(buildPlannerPrompt(payload, maxPromptChars));
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
  const apiToken = options.apiToken;
  if (!apiToken) {
    throw new Error("Missing API token for model generation");
  }

  const runPromptSafely = createRunContext(apiToken, options);
  const maxPromptChars = options.maxPromptChars ?? DEFAULT_LLM_MAX_PROMPT_CHARS;

  let scriptShape: string | undefined;
  let scriptPreview: string | undefined;
  let normalizationApplied = false;

  try {
    const generatorRaw = await runPromptSafely(buildGeneratorPrompt(payload, plannedCase, maxPromptChars));
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

export const generateWithCopilot = async (
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
