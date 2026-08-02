import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useGithubSession } from '../context/GithubSessionContext';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:4000';
const CALLBACK_PATH = '/auth/callback';

interface AuthExchangeResponse {
  sessionToken: string;
  expiresAt: number;
  user: {
    id: number;
    login: string;
    name: string | null;
    avatarUrl: string;
    email: string | null;
  };
  copilot: {
    active: boolean;
    reason: string;
  };
}

export default function AuthCallbackPage() {
  const navigate = useNavigate();
  const { setSession } = useGithubSession();
  const [error, setError] = useState('');

  const params = useMemo(() => new URLSearchParams(window.location.search), []);

  useEffect(() => {
    const run = async () => {
      const code = params.get('code');
      const state = params.get('state');
      const providerError = params.get('error');
      const providerErrorDescription = params.get('error_description');
      const expectedState = sessionStorage.getItem('github_oauth_state');

      if (providerError) {
        setError(providerErrorDescription || providerError);
        return;
      }

      if (!code) {
        setError('Missing authorization code from GitHub callback');
        return;
      }

      if (!state || !expectedState || state !== expectedState) {
        setError('OAuth state mismatch. Please sign in again.');
        return;
      }

      try {
        const redirectUri = `${window.location.origin}${CALLBACK_PATH}`;
        const response = await fetch(`${BACKEND_URL}/api/auth/github`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ code, redirectUri }),
        });

        if (!response.ok) {
          throw new Error(await response.text());
        }

        const payload = await response.json() as AuthExchangeResponse;

        if (!payload.copilot.active) {
          setError(payload.copilot.reason || 'Copilot license is not active for this account');
          return;
        }

        setSession({
          sessionToken: payload.sessionToken,
          expiresAt: payload.expiresAt,
          user: payload.user,
          copilot: payload.copilot,
        });

        sessionStorage.removeItem('github_oauth_state');
        navigate('/', { replace: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
      }
    };

    void run();
  }, [navigate, params, setSession]);

  if (error) {
    return (
      <div className="min-h-screen grid place-items-center p-6 bg-slate-50">
        <div className="max-w-lg w-full bg-white border border-red-200 rounded-2xl p-6 shadow-sm space-y-4">
          <h1 className="text-lg font-semibold text-red-700">GitHub OAuth Failed</h1>
          <p className="text-sm text-gray-700 whitespace-pre-wrap">{error}</p>
          <Link
            to="/auth"
            className="inline-block px-4 py-2 rounded-lg bg-slate-800 text-white text-sm hover:bg-slate-900"
          >
            กลับไปหน้าเข้าสู่ระบบ
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen grid place-items-center p-6 bg-slate-50">
      <div className="max-w-md w-full bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
        <h1 className="text-lg font-semibold text-slate-800">กำลังยืนยันตัวตนกับ GitHub...</h1>
        <p className="text-sm text-slate-600 mt-2">ระบบกำลังแลกโค้ด OAuth และตรวจสอบสิทธิ์ Copilot</p>
      </div>
    </div>
  );
}
