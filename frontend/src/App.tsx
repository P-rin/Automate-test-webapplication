import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import DashboardPage from './pages/DashboardPage';
import SetupPage from './pages/SetupPage';
import TestCasesPage from './pages/TestCasesPage';
import ReportPage from './pages/ReportPage';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<DashboardPage />} />
          <Route path="setup" element={<SetupPage />} />
          <Route path="test-cases" element={<TestCasesPage />} />
          <Route path="report/:runId" element={<ReportPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
