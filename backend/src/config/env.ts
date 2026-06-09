import { config } from "dotenv";

config();

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
  frontendOrigin: process.env.FRONTEND_ORIGIN ?? "http://localhost:5173",
  firebaseProjectId: process.env.FIREBASE_PROJECT_ID,
  firebaseClientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  firebasePrivateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  copilotApiUrl: process.env.COPILOT_API_URL ?? "https://api.githubcopilot.com",
  copilotApiToken: process.env.COPILOT_API_TOKEN,
  copilotModel: process.env.COPILOT_MODEL ?? "gpt-4.1",
  playwrightHeadless: asBool(process.env.PLAYWRIGHT_HEADLESS, true),
  playwrightMcpCommand: process.env.PLAYWRIGHT_MCP_COMMAND,
  playwrightMcpArgs: asList(process.env.PLAYWRIGHT_MCP_ARGS),
};
