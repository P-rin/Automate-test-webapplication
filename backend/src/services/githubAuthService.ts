import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { env } from "../config/env.js";

interface GitHubOAuthTokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface GitHubUserResponse {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
  email: string | null;
}

export interface CopilotVerificationResult {
  active: boolean;
  reason: string;
  raw?: Record<string, unknown>;
}

export interface GitHubSession {
  sessionToken: string;
  githubAccessToken: string;
  user: {
    id: number;
    login: string;
    name: string | null;
    avatarUrl: string;
    email: string | null;
  };
  copilot: CopilotVerificationResult;
  createdAt: number;
  expiresAt: number;
}

const SESSION_TTL_MS = 1000 * 60 * 60 * 8; // 8 hours
const sessions = new Map<string, GitHubSession>();
const STORAGE_DIR = path.resolve(process.cwd(), "runtime");
const STORAGE_FILE = path.join(STORAGE_DIR, "sessions.json");

const githubApiBase = "https://api.github.com";

const ensureSessionStorage = (): void => {
  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
  }
};

const loadSessionsFromDisk = (): void => {
  ensureSessionStorage();
  if (!fs.existsSync(STORAGE_FILE)) {
    return;
  }

  try {
    const payload = fs.readFileSync(STORAGE_FILE, "utf8");
    if (!payload.trim()) {
      return;
    }

    const parsed = JSON.parse(payload) as Record<string, GitHubSession>;
    for (const [sessionToken, session] of Object.entries(parsed)) {
      if (!session?.sessionToken || session.expiresAt <= Date.now()) {
        continue;
      }
      sessions.set(sessionToken, session);
    }
  } catch {
    // Ignore invalid persisted session data and fall back to an empty store.
  }
};

const persistSessionsToDisk = (): void => {
  ensureSessionStorage();
  const payload = Object.fromEntries(sessions.entries());
  fs.writeFileSync(STORAGE_FILE, JSON.stringify(payload, null, 2));
};

loadSessionsFromDisk();

const cleanupExpiredSessions = (): void => {
  const now = Date.now();
  for (const [key, value] of sessions.entries()) {
    if (value.expiresAt <= now) {
      sessions.delete(key);
    }
  }
};

const createGitHubHeaders = (accessToken: string): Record<string, string> => ({
  Authorization: `Bearer ${accessToken}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "autonomous-verification-layer",
});

const hasOauthConfig = (): boolean => {
  return Boolean(env.githubOauthClientId && env.githubOauthClientSecret);
};

export const ensureGithubOauthConfigured = (): void => {
  if (!hasOauthConfig()) {
    throw new Error("GitHub OAuth is not configured. Please set GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET.");
  }
};

export const exchangeGithubCodeForToken = async (
  code: string,
  redirectUri?: string,
): Promise<{ accessToken: string; tokenType: string; scope: string }> => {
  ensureGithubOauthConfigured();

  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "autonomous-verification-layer",
    },
    body: JSON.stringify({
      client_id: env.githubOauthClientId,
      client_secret: env.githubOauthClientSecret,
      code,
      redirect_uri: redirectUri || env.githubOauthRedirectUri,
    }),
  });

  const payload = (await response.json().catch(() => ({}))) as GitHubOAuthTokenResponse;

  if (!response.ok || !payload.access_token) {
    const reason = payload.error_description || payload.error || "Unable to exchange OAuth code with GitHub";
    throw new Error(reason);
  }

  return {
    accessToken: payload.access_token,
    tokenType: payload.token_type ?? "bearer",
    scope: payload.scope ?? "",
  };
};

export const fetchGithubUser = async (accessToken: string): Promise<GitHubSession["user"]> => {
  const response = await fetch(`${githubApiBase}/user`, {
    headers: createGitHubHeaders(accessToken),
  });

  if (!response.ok) {
    throw new Error("Unable to fetch GitHub user profile");
  }

  const payload = (await response.json()) as GitHubUserResponse;
  return {
    id: payload.id,
    login: payload.login,
    name: payload.name,
    avatarUrl: payload.avatar_url,
    email: payload.email,
  };
};

export const verifyCopilotSubscription = async (accessToken: string): Promise<CopilotVerificationResult> => {
  const base = (env.copilotApiUrl ?? "https://api.githubcopilot.com").replace(/\/+$/, "");
  const verifyUrl = `${base}/chat/completions`;

  const response = await fetch(verifyUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "autonomous-verification-layer",
    },
    // Keep payload minimal to verify token access with low latency and low token usage.
    body: JSON.stringify({
      model: env.copilotModel ?? "gpt-4.1",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
      temperature: 0,
    }),
  });

  const rawBody = await response.text().catch(() => "");
  const lowerBody = rawBody.toLowerCase();

  if (response.status === 200) {
    return {
      active: true,
      reason: "Copilot Chat endpoint is reachable with this token",
    };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      active: false,
      reason: `Copilot Chat permission check failed with status ${response.status}`,
      raw: {
        status: response.status,
        body: rawBody,
      },
    };
  }

  if (
    response.status === 400
    && (lowerBody.includes("personal access tokens are not supported") || lowerBody.includes("third-party user token"))
  ) {
    return {
      active: false,
      reason: "Copilot Chat endpoint does not accept this token type",
      raw: {
        status: response.status,
        body: rawBody,
      },
    };
  }

  return {
    active: true,
    reason: `Copilot Chat verification returned status ${response.status}; proceeding to runtime generation check`,
    raw: {
      status: response.status,
      body: rawBody,
    },
  };
};

export const createGithubSession = (
  githubAccessToken: string,
  user: GitHubSession["user"],
  copilot: CopilotVerificationResult,
): GitHubSession => {
  cleanupExpiredSessions();

  const sessionToken = crypto.randomUUID();
  const createdAt = Date.now();
  const expiresAt = createdAt + SESSION_TTL_MS;

  const session: GitHubSession = {
    sessionToken,
    githubAccessToken,
    user,
    copilot,
    createdAt,
    expiresAt,
  };

  sessions.set(sessionToken, session);
  persistSessionsToDisk();
  return session;
};

export const getGithubSession = (sessionToken: string): GitHubSession | null => {
  cleanupExpiredSessions();
  const session = sessions.get(sessionToken);
  if (!session) return null;

  if (session.expiresAt <= Date.now()) {
    sessions.delete(sessionToken);
    persistSessionsToDisk();
    return null;
  }

  return session;
};

export const revokeGithubSession = (sessionToken: string): void => {
  sessions.delete(sessionToken);
  persistSessionsToDisk();
};
