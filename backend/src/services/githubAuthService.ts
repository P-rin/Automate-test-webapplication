import crypto from "node:crypto";
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

const githubApiBase = "https://api.github.com";

const cleanupExpiredSessions = (): void => {
  const now = Date.now();
  for (const [key, value] of sessions.entries()) {
    if (value.expiresAt <= now) {
      sessions.delete(key);
    }
  }
};

const asRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value === "object" && value != null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
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
  const response = await fetch(`${githubApiBase}/user/copilot/billing`, {
    headers: createGitHubHeaders(accessToken),
  });

  if (response.status === 404) {
    return {
      active: false,
      reason: "Copilot billing endpoint is not available for this account/token",
    };
  }

  if (!response.ok) {
    return {
      active: false,
      reason: `Copilot billing check failed with status ${response.status}`,
    };
  }

  const payload = asRecord(await response.json().catch(() => ({})));
  const planType = typeof payload.plan_type === "string" ? payload.plan_type.toLowerCase() : "";
  const hasSeat = typeof payload.seat_management_setting === "string" || typeof payload.seat_breakdown === "object";
  const pendingCancel = payload.pending_cancellation_date;

  const active = Boolean(planType && planType !== "none") || hasSeat;

  if (!active) {
    return {
      active: false,
      reason: "No active Copilot subscription detected",
      raw: payload,
    };
  }

  if (pendingCancel) {
    return {
      active: true,
      reason: "Active Copilot subscription detected (pending cancellation)",
      raw: payload,
    };
  }

  return {
    active: true,
    reason: "Active Copilot subscription detected",
    raw: payload,
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
  return session;
};

export const getGithubSession = (sessionToken: string): GitHubSession | null => {
  cleanupExpiredSessions();
  const session = sessions.get(sessionToken);
  if (!session) return null;

  if (session.expiresAt <= Date.now()) {
    sessions.delete(sessionToken);
    return null;
  }

  return session;
};

export const revokeGithubSession = (sessionToken: string): void => {
  sessions.delete(sessionToken);
};
