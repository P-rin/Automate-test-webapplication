import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import ProtectedRoute from './components/ProtectedRoute';
import { useAuth } from './context/AuthContext';
import { useGithubSession } from './context/GithubSessionContext';
import { firebaseInitError } from './lib/firebase';
import AuthPage from './pages/AuthPage';
import AuthCallbackPage from './pages/AuthCallbackPage';
import DashboardPage from './pages/DashboardPage';
import SetupPage from './pages/SetupPage';
import TestCasesPage from './pages/TestCasesPage';
import ReportPage from './pages/ReportPage';

function ConfigErrorPage({ message }: { message: string }) {
  return (
    <div className="min-h-screen bg-slate-100 grid place-items-center p-4">
      <div className="max-w-xl w-full rounded-2xl border border-red-200 bg-white p-6 shadow-sm">
        <h1 className="text-lg font-semibold text-red-700">ตั้งค่า Firebase ไม่ถูกต้อง</h1>
        <p className="mt-2 text-sm text-slate-700">
          ตรวจสอบไฟล์ .env ของ frontend และรีสตาร์ต dev server อีกครั้ง
        </p>
        <pre className="mt-4 rounded-lg bg-slate-900 text-slate-100 p-3 text-xs overflow-x-auto">
{`VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_STORAGE_BUCKET=
VITE_FIREBASE_MESSAGING_SENDER_ID=
VITE_FIREBASE_APP_ID=`}
        </pre>
        <p className="mt-3 text-xs text-red-600 break-words">{message}</p>
      </div>
    </div>
  );
}

function AppRoutes() {
  const { user, loading } = useAuth();
  const { session } = useGithubSession();
  const isAuthenticated = Boolean(user || session);

  if (firebaseInitError) {
    return <ConfigErrorPage message={firebaseInitError} />;
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 grid place-items-center">
        <p className="text-sm text-gray-500">กำลังตรวจสอบสถานะผู้ใช้งาน...</p>
      </div>
    );
  }

  return (
    <Routes>
      <Route
        path="/auth"
        element={isAuthenticated ? <Navigate to="/" replace /> : <AuthPage />}
      />

      <Route path="/auth/callback" element={<AuthCallbackPage />} />

      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="setup" element={<SetupPage />} />
        <Route path="test-cases" element={<TestCasesPage />} />
        <Route path="report/:runId" element={<ReportPage />} />
      </Route>

      <Route
        path="*"
        element={<Navigate to={isAuthenticated ? '/' : '/auth'} replace />}
      />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
