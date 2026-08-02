import { config } from "dotenv";
import path from "node:path";

// Load from root .env first (shared config), then backend/.env can override
config({ path: path.resolve(process.cwd(), "..", ".env") });
config({ override: false }); // backend/.env as optional local override

const asBool = (value: string | undefined, fallback: boolean): boolean => {
  if (value == null || value.trim() === "") return fallback;
  return value.toLowerCase() === "true";
};

const asList = (value: string | undefined): string[] => {
  if (value == null || value.trim() === "") return [];

  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed;
    }
  } catch {
    // Fallback to whitespace split for plain string input.
  }

  return value
    .split(" ")
    .map((item) => item.trim())
    .filter(Boolean);
};

export const env = {
  port: Number(process.env.PORT ?? 4000),
  screenshotHost: process.env.SCREENSHOT_HOST ?? "localhost",
  frontendOrigin: process.env.FRONTEND_ORIGIN ?? "http://localhost:5173",
  githubOauthClientId: process.env.GITHUB_OAUTH_CLIENT_ID,
  githubOauthClientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
  githubOauthRedirectUri: process.env.GITHUB_OAUTH_REDIRECT_URI,
  firebaseProjectId: process.env.FIREBASE_PROJECT_ID,
  firebaseClientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  firebasePrivateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  llmProvider: process.env.LLM_PROVIDER ?? "auto",
  copilotApiUrl: process.env.COPILOT_API_URL ?? "https://api.githubcopilot.com",
  githubModelsApiUrl: process.env.GITHUB_MODELS_API_URL ?? "https://models.github.ai/inference",
  copilotApiToken: process.env.COPILOT_API_TOKEN,
  copilotModel: process.env.COPILOT_MODEL ?? "gpt-4.1",
  githubModelsModel: process.env.GITHUB_MODELS_MODEL ?? "openai/gpt-4.1",
  llmMaxPromptChars: Number(process.env.LLM_MAX_PROMPT_CHARS ?? 14000),
  playwrightExploreMaxSnapshots: Number(process.env.PLAYWRIGHT_EXPLORE_MAX_SNAPSHOTS ?? 8),
  playwrightExploreMaxCandidates: Number(process.env.PLAYWRIGHT_EXPLORE_MAX_CANDIDATES ?? 5),
  playwrightExploreMaxDepth: Number(process.env.PLAYWRIGHT_EXPLORE_MAX_DEPTH ?? 2),
  playwrightHeadless: asBool(process.env.PLAYWRIGHT_HEADLESS, true),
  playwrightMcpBrowser: process.env.PLAYWRIGHT_MCP_BROWSER,
  playwrightMcpIsolated: asBool(process.env.PLAYWRIGHT_MCP_ISOLATED, false),
  playwrightMcpUserDataDir: process.env.PLAYWRIGHT_MCP_USER_DATA_DIR,
  playwrightMcpStorageState: process.env.PLAYWRIGHT_MCP_STORAGE_STATE,
  playwrightMcpUrl: process.env.PLAYWRIGHT_MCP_URL,
  playwrightMcpCommand: process.env.PLAYWRIGHT_MCP_COMMAND,
  playwrightMcpArgs: asList(process.env.PLAYWRIGHT_MCP_ARGS),
  executionEngine: (process.env.EXECUTION_ENGINE ?? "playwright").toLowerCase(),
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS ?? 120000),
};
