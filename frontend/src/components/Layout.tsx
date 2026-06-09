import { NavLink, Outlet } from 'react-router-dom';

const navItems = [
  { to: '/', label: '🏠 แดชบอร์ด', exact: true },
  { to: '/setup', label: '⚙️ ตั้งค่าและสร้างเทสเคส', exact: false },
  { to: '/test-cases', label: '📋 คลังชุดทดสอบ', exact: false },
];

export default function Layout() {
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
        </div>
      </nav>

      {/* Page Content */}
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
