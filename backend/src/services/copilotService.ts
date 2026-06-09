import OpenAI from "openai";
import type { GeneratedArtifact } from "../types.js";

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

const toJsonObject = (value: string): CopilotResponse => {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed == null) {
    throw new Error("Copilot response is not a JSON object");
  }
  return parsed as CopilotResponse;
};

const buildPrompt = (payload: CopilotRequest): string => {
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
    payload.specification,
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

export const generateWithCopilot = async (
  payload: CopilotRequest,
  apiUrl?: string,
  apiToken?: string,
  model = "gpt-4.1",
): Promise<GeneratedArtifact> => {
  if (!apiToken) {
    return fallbackArtifact(payload.projectName, payload.targetUrl);
  }

  const prompt = buildPrompt(payload);
  const client = new OpenAI({
    apiKey: apiToken,
    baseURL: apiUrl,
  });

  const completion = await client.chat.completions.create({
    model,
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: "You are GitHub Copilot for software test generation.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  const rawText = completion.choices[0]?.message?.content;
  if (!rawText) {
    throw new Error("Copilot SDK returned empty content");
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
