import { NavLink, Outlet } from 'react-router-dom';
import { signOut } from 'firebase/auth';
import { useAuth } from '../context/AuthContext';
import { useGithubSession } from '../context/GithubSessionContext';
import { auth } from '../lib/firebase';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:4000';

const navItems = [
  { to: '/', label: '🏠 แดชบอร์ด', exact: true },
  { to: '/setup', label: '⚙️ ตั้งค่าและสร้างเทสเคส', exact: false },
  { to: '/test-cases', label: '📋 คลังชุดทดสอบ', exact: false },
];

export default function Layout() {
  const { user } = useAuth();
  const { session, clearSession } = useGithubSession();

  const handleLogout = async () => {
    if (session) {
      try {
        await fetch(`${BACKEND_URL}/api/auth/logout`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${session.sessionToken}`,
          },
        });
      } catch (err) {
        console.error(err);
      } finally {
        clearSession();
      }
      return;
    }

    if (!auth) return;

    try {
      await signOut(auth);
    } catch (err) {
      console.error(err);
      alert('ออกจากระบบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง');
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Top Nav */}
      <nav className="bg-white border-b border-gray-200 sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-6 flex items-center gap-1 h-14">
          <span className="text-base font-bold text-gray-800 mr-4">🔬 AVL Platform</span>
          {navItems.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.exact}
              className={({ isActive }) =>
                `px-3 py-2 rounded-lg text-sm transition-colors ${isActive ? 'bg-blue-100 text-blue-700 font-medium' : 'text-gray-600 hover:bg-gray-100'}`
              }
            >
              {item.label}
            </NavLink>
          ))}

          <div className="ml-auto flex items-center gap-3">
            {session?.user.avatarUrl ? (
              <img
                src={session.user.avatarUrl}
                alt={session.user.login}
                className="w-7 h-7 rounded-full border border-gray-200"
              />
            ) : null}
            <span
              className="text-xs text-gray-500 max-w-52 truncate"
              title={session?.user.login || user?.email || ''}
            >
              {session ? `${session.user.name || session.user.login} (${session.user.login})` : (user?.displayName || user?.email)}
            </span>
            <button
              onClick={handleLogout}
              className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-100"
            >
              ออกจากระบบ
            </button>
          </div>
        </div>
      </nav>

      {/* Page Content */}
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
