import OpenAI from "openai";
import type { GeneratedArtifact } from "../types.js";

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

interface LlmGenerationOptions {
  provider?: string;
  apiToken?: string;
  copilotApiUrl?: string;
  githubModelsApiUrl?: string;
  copilotModel?: string;
  githubModelsModel?: string;
}

const toJsonObject = (value: string): CopilotResponse => {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed == null) {
    throw new Error("Copilot response is not a JSON object");
  }
  return parsed as CopilotResponse;
};

const buildPrompt = (payload: CopilotRequest): string => {
  const specificationText = payload.specification.trim().length
    ? payload.specification
    : "No requirement specification file was provided. Derive a safe smoke test from the accessibility snapshot and target URL.";

  return [
    "You are generating Playwright test scripts for a localhost web app.",
    "Follow the requirement files as the highest priority source of truth.",
    "Do not invent requirements outside specification.",
    "Output strict JSON with keys: title, type, criteria, script.",
    "- title: concise Thai/English mixed test title",
    "- type: UI or API",
    "- criteria: array of clear assertions",
    "- script: full Playwright test file content (.spec.ts)",
    "",
    `Project Name: ${payload.projectName}`,
    `Target URL: ${payload.targetUrl}`,
    "",
    "[Requirement Specification]",
    specificationText,
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

export const generateWithCopilot = async (
  payload: CopilotRequest,
  options: LlmGenerationOptions = {},
): Promise<GeneratedArtifact> => {
  const apiToken = options.apiToken;
  if (!apiToken) {
    return fallbackArtifact(payload.projectName, payload.targetUrl);
  }

  const prompt = buildPrompt(payload);
  const provider = asProvider(options.provider);
  const resolvedProvider: Exclude<LlmProvider, "auto"> =
    provider === "auto"
      ? (isPatToken(apiToken) ? "github-models" : "copilot")
      : provider;

  const copilotModel = options.copilotModel ?? "gpt-4.1";
  const githubModelsModel = options.githubModelsModel ?? "openai/gpt-4.1";

  const runWithCopilot = async (): Promise<string> => {
    const client = createClient(apiToken, options.copilotApiUrl);
    return callChatModel(client, copilotModel, prompt, "You are GitHub Copilot for software test generation.");
  };

  const runWithGitHubModels = async (): Promise<string> => {
    const client = createClient(apiToken, options.githubModelsApiUrl);
    return callChatModel(client, githubModelsModel, prompt, "You are an expert QA engineer for Playwright test generation.");
  };

  let rawText = "";
  try {
    rawText = resolvedProvider === "github-models" ? await runWithGitHubModels() : await runWithCopilot();
  } catch (error) {
    if (isUnsupportedTokenError(error) && provider === "auto") {
      try {
        rawText = await runWithGitHubModels();
      } catch {
        // If both providers fail, keep backward-compatible behavior to avoid breaking generation flow.
        return fallbackArtifact(payload.projectName, payload.targetUrl);
      }
    } else {
      throw error;
    }
  }

  const data = toJsonObject(rawText);
  if (!data.script || !data.title) {
    throw new Error("Copilot response missing required fields");
  }

  return {
    title: data.title,
    type: data.type ?? "UI",
    criteria: data.criteria ?? [],
    script: data.script,
  };
};
