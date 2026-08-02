import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  updateProfile,
} from 'firebase/auth';
import { useLocation, useNavigate } from 'react-router-dom';
import { auth, firebaseInitError } from '../lib/firebase';

type AuthMode = 'login' | 'register';

const githubClientId = import.meta.env.VITE_GITHUB_CLIENT_ID || '';
const githubScope = import.meta.env.VITE_GITHUB_SCOPE || 'read:user user:email copilot';
const callbackUri = `${window.location.origin}/auth/callback`;

export default function AuthPage() {
  const [mode, setMode] = useState<AuthMode>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const navigate = useNavigate();
  const location = useLocation();
  const redirectTo = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname || '/';

  const isRegister = mode === 'register';

  const handleGithubSignIn = () => {
    if (!githubClientId) {
      setError('ยังไม่ได้ตั้งค่า VITE_GITHUB_CLIENT_ID สำหรับ GitHub OAuth');
      return;
    }

    const state = crypto.randomUUID();
    sessionStorage.setItem('github_oauth_state', state);

    const authUrl = new URL('https://github.com/login/oauth/authorize');
    authUrl.searchParams.set('client_id', githubClientId);
    authUrl.searchParams.set('redirect_uri', callbackUri);
    authUrl.searchParams.set('scope', githubScope);
    authUrl.searchParams.set('state', state);

    window.location.href = authUrl.toString();
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');

    if (!auth) {
      setError('Firebase Auth ยังไม่พร้อมใช้งาน กรุณาตรวจสอบค่า VITE_FIREBASE_* ในไฟล์ .env');
      return;
    }

    if (isRegister && password !== confirmPassword) {
      setError('รหัสผ่านและยืนยันรหัสผ่านไม่ตรงกัน');
      return;
    }

    setSubmitting(true);
    try {
      if (isRegister) {
        const credential = await createUserWithEmailAndPassword(auth, email.trim(), password);
        if (name.trim()) {
          await updateProfile(credential.user, { displayName: name.trim() });
        }
      } else {
        await signInWithEmailAndPassword(auth, email.trim(), password);
      }

      navigate(redirectTo, { replace: true });
    } catch (err) {
      console.error(err);
      setError('เข้าสู่ระบบไม่สำเร็จ กรุณาตรวจสอบอีเมล/รหัสผ่าน หรือการตั้งค่า Firebase Auth');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-100 via-white to-slate-100 grid place-items-center p-4">
      <div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-xl p-6 sm:p-8">
        <div className="mb-6 text-center">
          <p className="text-xs font-semibold tracking-[0.2em] text-slate-500 uppercase">AVL Platform</p>
          <h1 className="mt-2 text-2xl font-bold text-slate-800">
            {isRegister ? 'สร้างบัญชีผู้ใช้' : 'เข้าสู่ระบบ'}
          </h1>
          <p className="mt-1 text-sm text-slate-500">ใช้ Firebase Authentication เพื่อเข้าใช้งานระบบ</p>
        </div>

        <button
          type="button"
          onClick={handleGithubSignIn}
          className="w-full mb-4 border border-slate-300 rounded-lg px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Sign in with GitHub (OAuth)
        </button>

        <p className="text-[11px] text-slate-500 mb-5">
          GitHub OAuth ใช้สำหรับ flow ที่ต้องตรวจสอบสิทธิ์ Copilot ก่อนสร้าง test case
        </p>

        <div className="grid grid-cols-2 bg-slate-100 rounded-xl p-1 mb-6">
          <button
            type="button"
            onClick={() => { setMode('login'); setError(''); }}
            className={`text-sm rounded-lg px-3 py-2 transition-colors ${!isRegister ? 'bg-white text-slate-800 shadow-sm font-medium' : 'text-slate-500'}`}
          >
            Login
          </button>
          <button
            type="button"
            onClick={() => { setMode('register'); setError(''); }}
            className={`text-sm rounded-lg px-3 py-2 transition-colors ${isRegister ? 'bg-white text-slate-800 shadow-sm font-medium' : 'text-slate-500'}`}
          >
            Register
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {firebaseInitError && (
            <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2">
              Firebase config ไม่ถูกต้อง กรุณาแก้ไฟล์ .env และรีสตาร์ต frontend dev server
            </p>
          )}

          {isRegister && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">ชื่อผู้ใช้</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="เช่น Tester Team"
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-500"
              />
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">อีเมล</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="you@example.com"
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">รหัสผ่าน</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={6}
              required
              placeholder="อย่างน้อย 6 ตัวอักษร"
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-500"
            />
          </div>

          {isRegister && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">ยืนยันรหัสผ่าน</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                minLength={6}
                required
                placeholder="พิมพ์รหัสผ่านอีกครั้ง"
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-500"
              />
            </div>
          )}

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button
            type="submit"
            disabled={submitting || !auth}
            className="w-full bg-slate-800 text-white py-2.5 rounded-lg text-sm font-medium hover:bg-slate-900 disabled:opacity-50"
          >
            {submitting ? 'กำลังดำเนินการ...' : isRegister ? 'สมัครสมาชิก' : 'เข้าสู่ระบบ'}
          </button>
        </form>
      </div>
    </div>
  );
}
