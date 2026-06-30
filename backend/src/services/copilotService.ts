import OpenAI from "openai";
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

interface LlmGenerationOptions {
  provider?: string;
  apiToken?: string;
  copilotApiUrl?: string;
  githubModelsApiUrl?: string;
  copilotModel?: string;
  githubModelsModel?: string;
}

const toJsonArray = <T>(value: string): T[] => {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Copilot planner response is not a JSON array");
  }
  return parsed as T[];
};

const toJsonObject = <T>(value: string): T => {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) {
    throw new Error("Copilot response is not a JSON object");
  }
  return parsed as T;
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

const buildPlannerPrompt = (payload: CopilotRequest): string => {
  const specificationText = payload.specification.trim().length
    ? payload.specification
    : "No requirement specification file was provided. Derive a safe smoke test from the accessibility snapshot and target URL.";

  return [
    "You are an expert QA Lead and Test Planner specializing in autonomous web exploration.",
    "Your task is to analyze the provided [Requirement Specification] and use the [Accessibility Snapshot] to map out a comprehensive testing strategy for a localhost web app.",
    "",
    "[CRITICAL INSTRUCTION - EXPLORATION & COVERAGE]",
    "1. Do not limit yourself to happy paths. Actively explore elements outside the spec if they appear on the current screen.",
    "2. Discover potential edge cases, field validation flaws, missing inputs, and negative flows.",
    "3. Formulate between 3 to 6 distinct test scenarios.",
    "",
    "[OUTPUT FORMAT]",
    "Output ONLY a raw JSON array containing planned test cases. Do not wrap it in markdown block. Follow this structure strictly:",
    "[",
    "  {",
    "    \"id\": \"TC-001\",",
    "    \"title\": \"concise Thai/English mixed title\",",
    "    \"description\": \"Detailed explanation\",",
    "    \"type\": \"UI\",",
    "    \"testSteps\": [\"step 1\", \"step 2\"],",
    "    \"expectedResult\": \"what should happen\"",
    "  }",
    "]",
    "",
    `Target URL: ${payload.targetUrl}`,
    "",
    "[Requirement Specification]",
    specificationText,
    "",
    "[Accessibility Snapshot]",
    payload.accessibilitySnapshot,
  ].join("\n");
};

const buildGeneratorPrompt = (payload: CopilotRequest, plannedCase: TestPlan): string => {
  return [
    "You are an expert Automation Engineer generating strict Playwright test scripts (.spec.ts) in TypeScript.",
    "Your ONLY source of truth is the [Assigned Test Plan Object] and the [Accessibility Snapshot].",
    "",
    "[OUTPUT FORMAT]",
    "Output ONLY raw JSON with keys: id, title, script. Do not wrap in markdown.",
    "- id: keep the original test case ID",
    "- title: keep the original test case title",
    "- script: full executable Playwright test file content as an escaped JSON string (use \\n for newlines).",
    "",
    `Target URL: ${payload.targetUrl}`,
    "",
    "[Assigned Test Plan Object]",
    JSON.stringify(plannedCase, null, 2),
    "",
    "[Accessibility Snapshot]",
    payload.accessibilitySnapshot,
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

const callChatModel = async (
  client: OpenAI,
  model: string,
  prompt: string,
  systemInstruction: string,
): Promise<string> => {
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
};

const getResolvedProvider = (
  provider: string | undefined,
  apiToken: string,
): Exclude<LlmProvider, "auto"> => {
  const normalized = asProvider(provider);
  return normalized === "auto" ? (isPatToken(apiToken) ? "github-models" : "copilot") : normalized;
};

export const generateTestsTwoPass = async (
  payload: CopilotRequest,
  options: LlmGenerationOptions = {},
): Promise<GeneratedTestCase[]> => {
  const apiToken = options.apiToken;
  if (!apiToken) {
    return [fallbackGeneratedTestCase(payload.projectName, payload.targetUrl)];
  }

  const provider = asProvider(options.provider);
  const resolvedProvider = getResolvedProvider(options.provider, apiToken);
  const copilotModel = options.copilotModel ?? "gpt-4.1";
  const githubModelsModel = options.githubModelsModel ?? "openai/gpt-4.1";

  const runWithCopilot = async (prompt: string): Promise<string> => {
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

  const runPromptSafely = async (prompt: string): Promise<string> => {
    try {
      return await runForPrompt(prompt);
    } catch (error) {
      if (isUnsupportedTokenError(error) && provider === "auto") {
        return runWithGitHubModels(prompt);
      }
      throw error;
    }
  };

  const plannerRaw = await runPromptSafely(buildPlannerPrompt(payload));
  const plannedCases = toJsonArray<unknown>(plannerRaw).filter(isValidTestPlan);
  if (plannedCases.length === 0) {
    throw new Error("Planner response did not contain valid test plans");
  }

  const generatedTests = await Promise.all(
    plannedCases.map(async (plannedCase) => {
      const generatorRaw = await runPromptSafely(buildGeneratorPrompt(payload, plannedCase));
      const generated = toJsonObject<GeneratorResponse>(generatorRaw);
      if (!generated.id || !generated.title || !generated.script) {
        throw new Error(`Generator response missing required fields for plan ${plannedCase.id}`);
      }
      return {
        id: generated.id,
        title: generated.title,
        script: generated.script,
      };
    }),
  );

  return generatedTests;
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
