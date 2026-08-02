import { createContext, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

const STORAGE_KEY = 'github_oauth_session';

interface GithubSessionUser {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string;
  email: string | null;
}

interface GithubCopilotInfo {
  active: boolean;
  reason: string;
}

export interface GithubSession {
  sessionToken: string;
  user: GithubSessionUser;
  copilot: GithubCopilotInfo;
  expiresAt: number;
}

interface GithubSessionContextValue {
  session: GithubSession | null;
  setSession: (value: GithubSession) => void;
  clearSession: () => void;
}

const GithubSessionContext = createContext<GithubSessionContextValue | undefined>(undefined);

const readInitialSession = (): GithubSession | null => {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as GithubSession;
    if (!parsed?.sessionToken || !parsed?.expiresAt) return null;
    if (parsed.expiresAt <= Date.now()) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    return null;
  }
};

export function GithubSessionProvider({ children }: { children: ReactNode }) {
  const [session, setSessionState] = useState<GithubSession | null>(readInitialSession);

  const setSession = (value: GithubSession) => {
    setSessionState(value);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  };

  const clearSession = () => {
    setSessionState(null);
    localStorage.removeItem(STORAGE_KEY);
  };

  const contextValue = useMemo(() => ({ session, setSession, clearSession }), [session]);

  return <GithubSessionContext.Provider value={contextValue}>{children}</GithubSessionContext.Provider>;
}

export function useGithubSession() {
  const context = useContext(GithubSessionContext);
  if (!context) {
    throw new Error('useGithubSession must be used inside GithubSessionProvider');
  }
  return context;
}
