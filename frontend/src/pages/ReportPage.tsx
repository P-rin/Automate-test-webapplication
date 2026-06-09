import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { doc, onSnapshot } from 'firebase/firestore';
import { PieChart, Pie, Cell, Tooltip, Legend } from 'recharts';
import { db } from '../lib/firebase';
import type { TestRun } from '../types';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:4000';

export default function ReportPage() {
  const { runId } = useParams<{ runId: string }>();
  const navigate = useNavigate();
  const [run, setRun] = useState<TestRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [isReRunning, setIsReRunning] = useState(false);

  useEffect(() => {
    if (!runId) return;
    const unsubscribe = onSnapshot(doc(db, 'testRuns', runId), (snapshot) => {
      if (snapshot.exists()) {
        setRun({ id: snapshot.id, ...snapshot.data() } as TestRun);
      }
      setLoading(false);
    });
    return () => unsubscribe();
  }, [runId]);

  const handleReRun = async () => {
    if (!run) return;
    setIsReRunning(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testCaseIds: run.testCaseIds }),
      });
      if (!res.ok) throw new Error(await res.text());
      alert('สั่งรันซ้ำเรียบร้อยแล้ว');
    } catch (err) {
      console.error(err);
      alert('เกิดข้อผิดพลาด');
    } finally {
      setIsReRunning(false);
    }
  };

  if (loading) return <div className="p-8 text-center text-gray-400">กำลังโหลดรายงาน...</div>;
  if (!run) return <div className="p-8 text-center text-red-400">ไม่พบรายงานการรัน</div>;

  const chartData = [
    { name: 'ผ่าน', value: run.passCount },
    { name: 'ไม่ผ่าน', value: run.failCount },
  ];
  const COLORS = ['#22c55e', '#ef4444'];
  const duration = run.totalDuration ? `${(run.totalDuration / 1000).toFixed(1)} วินาที` : '-';

  return (
    <div className="p-6 space-y-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">รายงานผลการทดสอบ</h1>
          <p className="text-sm text-gray-500 mt-1">{run.projectName}</p>
        </div>
        <div className="flex gap-3">
          <button onClick={() => navigate(-1)} className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50">
            ← ย้อนกลับ
          </button>
          <button
            onClick={handleReRun}
            disabled={isReRunning}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            {isReRunning ? 'กำลังรัน...' : '🔄 รันซ้ำอีกครั้ง'}
          </button>
        </div>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Pie Chart */}
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 flex flex-col items-center">
          <h2 className="text-base font-semibold text-gray-700 mb-3 self-start">สัดส่วนผลการรัน</h2>
          {run.passCount + run.failCount > 0 ? (
            <PieChart width={240} height={200}>
              <Pie data={chartData} cx={120} cy={90} outerRadius={80} dataKey="value" label={({ name, value }) => `${name}: ${value}`}>
                {chartData.map((_, index) => (
                  <Cell key={index} fill={COLORS[index % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip />
              <Legend />
            </PieChart>
          ) : (
            <div className="text-gray-400 text-sm py-8">ไม่มีข้อมูล</div>
          )}
          <p className="text-sm text-gray-500 mt-2">เวลารวม: <span className="font-semibold text-gray-700">{duration}</span></p>
        </div>

        {/* Stats */}
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 space-y-4">
          <h2 className="text-base font-semibold text-gray-700">สรุปตัวเลข</h2>
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-green-50 rounded-lg p-4 text-center">
              <p className="text-3xl font-bold text-green-600">{run.passCount}</p>
              <p className="text-sm text-green-700 mt-1">ผ่าน</p>
            </div>
            <div className="bg-red-50 rounded-lg p-4 text-center">
              <p className="text-3xl font-bold text-red-500">{run.failCount}</p>
              <p className="text-sm text-red-600 mt-1">ไม่ผ่าน</p>
            </div>
          </div>
          <div className="text-sm text-gray-500 space-y-1">
            <p>เริ่มรัน: {run.startedAt ? new Date((run.startedAt as any).seconds * 1000).toLocaleString('th-TH') : '-'}</p>
            <p>เสร็จสิ้น: {run.completedAt ? new Date((run.completedAt as any).seconds * 1000).toLocaleString('th-TH') : '-'}</p>
          </div>
        </div>
      </div>

      {/* Error Logs */}
      {run.logs && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
          <h2 className="text-base font-semibold text-gray-700 mb-3">System Logs & Error Details</h2>
          <pre className="bg-gray-900 text-gray-200 rounded-lg p-4 text-xs overflow-x-auto whitespace-pre-wrap max-h-64">
            {run.logs}
          </pre>
        </div>
      )}

      {/* Screenshot Gallery */}
      {run.screenshotUrls && run.screenshotUrls.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
          <h2 className="text-base font-semibold text-gray-700 mb-3">หลักฐานภาพ Screenshots (กรณีเทสไม่ผ่าน)</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {run.screenshotUrls.map((url, i) => (
              <div key={i} className="rounded-lg overflow-hidden border border-gray-200">
                <img
                  src={url}
                  alt={`Screenshot ${i + 1}`}
                  className="w-full object-contain max-h-64 bg-gray-100"
                  loading="lazy"
                />
                <p className="text-xs text-gray-400 text-center py-1">Screenshot {i + 1}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
