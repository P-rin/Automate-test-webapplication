import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, onSnapshot, query, orderBy, limit } from 'firebase/firestore';
import { db } from '../lib/firebase';
import type { TestRun, TestCase } from '../types';

export default function DashboardPage() {
  const [testRuns, setTestRuns] = useState<TestRun[]>([]);
  const [testCases, setTestCases] = useState<TestCase[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubRuns = onSnapshot(
      query(collection(db, 'testRuns'), orderBy('startedAt', 'desc'), limit(10)),
      (snapshot) => {
        setTestRuns(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as TestRun)));
        setLoading(false);
      }
    );

    const unsubCases = onSnapshot(collection(db, 'testCases'), (snapshot) => {
      setTestCases(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as TestCase)));
    });

    return () => {
      unsubRuns();
      unsubCases();
    };
  }, []);

  const totalProjects = [...new Set(testCases.map(tc => tc.projectId))].length;
  const totalTestCases = testCases.length;
  const totalRuns = testRuns.length;
  const successRate = totalRuns > 0
    ? Math.round((testRuns.reduce((acc, r) => acc + r.passCount, 0) /
        testRuns.reduce((acc, r) => acc + r.passCount + r.failCount, 1)) * 100)
    : 0;

  const statusColor = (status: string) => {
    if (status === 'completed') return 'text-green-600 bg-green-100';
    if (status === 'failed') return 'text-red-600 bg-red-100';
    return 'text-yellow-600 bg-yellow-100';
  };

  const statusLabel = (status: string) => {
    if (status === 'completed') return 'ผ่าน';
    if (status === 'failed') return 'ไม่ผ่าน';
    if (status === 'running') return 'กำลังรัน';
    return 'รอดำเนินการ';
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-800">แดชบอร์ดภาพรวมระบบ</h1>
        <Link
          to="/setup"
          className="bg-blue-600 text-white px-5 py-2.5 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
        >
          + สร้างชุดทดสอบใหม่
        </Link>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <p className="text-sm text-gray-500 mb-1">โปรเจคทั้งหมด</p>
          <p className="text-3xl font-bold text-blue-600">{totalProjects}</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <p className="text-sm text-gray-500 mb-1">ชุดทดสอบทั้งหมด</p>
          <p className="text-3xl font-bold text-purple-600">{totalTestCases}</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <p className="text-sm text-gray-500 mb-1">อัตราผ่านสะสม</p>
          <p className="text-3xl font-bold text-green-600">{successRate}%</p>
        </div>
      </div>

      {/* Recent Activity Table */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100">
        <div className="p-5 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-700">ประวัติการรันล่าสุด</h2>
        </div>
        {loading ? (
          <div className="p-8 text-center text-gray-400">กำลังโหลด...</div>
        ) : testRuns.length === 0 ? (
          <div className="p-8 text-center text-gray-400">ยังไม่มีประวัติการรัน</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-gray-500 text-left">
                  <th className="px-5 py-3 font-medium">โปรเจค</th>
                  <th className="px-5 py-3 font-medium">สถานะ</th>
                  <th className="px-5 py-3 font-medium">Pass/Fail</th>
                  <th className="px-5 py-3 font-medium">วันเวลา</th>
                  <th className="px-5 py-3 font-medium">รายละเอียด</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {testRuns.map(run => (
                  <tr key={run.id} className="hover:bg-gray-50">
                    <td className="px-5 py-3 text-gray-800">{run.projectName}</td>
                    <td className="px-5 py-3">
                      <span className={`text-xs px-2 py-1 rounded-full font-medium ${statusColor(run.status)}`}>
                        {statusLabel(run.status)}
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      <span className="text-green-600 font-medium">{run.passCount} ผ่าน</span>
                      {' / '}
                      <span className="text-red-500 font-medium">{run.failCount} ไม่ผ่าน</span>
                    </td>
                    <td className="px-5 py-3 text-gray-500">
                      {run.startedAt ? new Date((run.startedAt as any).seconds * 1000).toLocaleString('th-TH') : '-'}
                    </td>
                    <td className="px-5 py-3">
                      <Link to={`/report/${run.id}`} className="text-blue-500 hover:underline text-xs">
                        ดูรายงาน →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
