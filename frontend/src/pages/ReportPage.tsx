import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { doc, onSnapshot } from 'firebase/firestore';
import { PieChart, Pie, Cell, Tooltip, Legend } from 'recharts';
import { db } from '../lib/firebase';
import type { TestRun } from '../types';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:4000';

const formatTimestamp = (value: Date | TestRun['startedAt'] | undefined): string => {
  if (!value) return '-';
  const date = value instanceof Date ? value : value.toDate();
  return date.toLocaleString('th-TH');
};

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
      const res = await fetch(`${BACKEND_URL}/api/v2/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testCaseIds: run.testCaseIds, engine: 'playwright' }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json() as { runId?: string; engineUsed?: string; fallbackReason?: string };
      const fallbackLine = data.fallbackReason ? `\nFallback: ${data.fallbackReason}` : '';
      alert(`สั่งรันซ้ำเรียบร้อยแล้ว\nRun ID: ${data.runId ?? '-'}\nEngine: ${data.engineUsed ?? 'playwright'}${fallbackLine}`);
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
    { name: 'ไม่เสถียร', value: run.flakyCount ?? 0 },
    { name: 'ข้าม', value: run.skippedCount ?? 0 },
  ];
  const COLORS = ['#22c55e', '#ef4444', '#f59e0b', '#9ca3af'];
  const duration = run.totalDuration ? `${(run.totalDuration / 1000).toFixed(1)} วินาที` : '-';
  const flakyCount = run.flakyCount ?? run.caseResults?.filter((item) => item.outcome === 'flaky').length ?? 0;
  const skippedCount = run.skippedCount ?? run.caseResults?.filter((item) => item.outcome === 'skipped').length ?? 0;
  const totalCount = run.passCount + run.failCount + flakyCount + skippedCount;
  const usesMcp = run.engineUsed === 'mcp';
  const unsupportedCount = (run.caseResults ?? []).reduce((total, item) => {
    const count = item.errors.filter((error) => error.includes('UNSUPPORTED_STEP')).length;
    return total + count;
  }, 0);

  return (
    <div className="p-6 space-y-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">รายงานผลการทดสอบ</h1>
          <p className="text-sm text-gray-500 mt-1">{run.projectName}</p>
          <div className="mt-2">
            {usesMcp ? (
            <span className={`text-xs px-2 py-1 rounded-full font-medium ${unsupportedCount > 0 ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'}`}>
              Unsupported Steps: {unsupportedCount}
            </span>
            ) : (
              <span className="text-xs px-2 py-1 rounded-full font-medium bg-blue-100 text-blue-700">
                Runtime: Playwright
              </span>
            )}
          </div>
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
          {totalCount > 0 ? (
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
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="rounded-lg bg-blue-50 p-4 text-center">
              <p className="text-3xl font-bold text-blue-700">{totalCount}</p>
              <p className="mt-1 text-sm text-blue-800">ทั้งหมด</p>
            </div>
            <div className="bg-green-50 rounded-lg p-4 text-center">
              <p className="text-3xl font-bold text-green-600">{run.passCount}</p>
              <p className="text-sm text-green-700 mt-1">ผ่าน</p>
            </div>
            <div className="bg-red-50 rounded-lg p-4 text-center">
              <p className="text-3xl font-bold text-red-500">{run.failCount}</p>
              <p className="text-sm text-red-600 mt-1">ไม่ผ่าน</p>
            </div>
            <div className="rounded-lg bg-amber-50 p-4 text-center">
              <p className="text-3xl font-bold text-amber-600">{flakyCount}</p>
              <p className="mt-1 text-sm text-amber-700">ไม่เสถียร (flaky)</p>
            </div>
            <div className="rounded-lg bg-gray-100 p-4 text-center">
              <p className="text-3xl font-bold text-gray-600">{skippedCount}</p>
              <p className="mt-1 text-sm text-gray-700">ข้าม (skipped)</p>
            </div>
          </div>
          <div className="text-sm text-gray-500 space-y-1">
            <p>เริ่มรัน: {formatTimestamp(run.startedAt)}</p>
            <p>เสร็จสิ้น: {formatTimestamp(run.completedAt)}</p>
            <p>Engine Requested: <span className="font-semibold text-gray-700">{run.engineRequested ?? '-'}</span></p>
            <p>Engine Used: <span className="font-semibold text-gray-700">{run.engineUsed ?? '-'}</span></p>
            {run.fallbackReason && <p className="text-amber-600">Fallback: {run.fallbackReason}</p>}
          </div>
        </div>
      </div>

      {run.caseResults && run.caseResults.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
          <h2 className="text-base font-semibold text-gray-700 mb-3">ผลลัพธ์ราย Test Case</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-gray-500 text-left">
                  <th className="px-4 py-2 font-medium">Test Case ID</th>
                  <th className="px-4 py-2 font-medium">ไฟล์</th>
                  <th className="px-4 py-2 font-medium">ผลลัพธ์</th>
                  <th className="px-4 py-2 font-medium">เวลา</th>
                  <th className="px-4 py-2 font-medium">Errors</th>
                  {usesMcp && <th className="px-4 py-2 font-medium">Unsupported</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {run.caseResults.map((item, index) => {
                  const unsupportedPerCase = item.errors.filter((error) => error.includes('UNSUPPORTED_STEP')).length;
                  const outcome = item.outcome ?? (item.passed ? 'passed' : 'failed');
                  const needsEvidence = outcome === 'failed' || outcome === 'flaky';
                  return (
                    <tr key={`${item.testCaseId}-${index}`}>
                      <td className="px-4 py-2 text-gray-700">{item.testCaseId}</td>
                      <td className="px-4 py-2 text-gray-500">{item.filePattern ?? '-'}</td>
                      <td className="px-4 py-2">
                        <span className={`text-xs px-2 py-1 rounded-full ${
                          outcome === 'passed'
                            ? 'bg-green-100 text-green-700'
                            : outcome === 'flaky'
                              ? 'bg-amber-100 text-amber-800'
                              : outcome === 'skipped'
                                ? 'bg-gray-100 text-gray-700'
                                : 'bg-red-100 text-red-600'
                        }`}>
                          {outcome === 'passed' ? 'ผ่าน' : outcome === 'flaky' ? 'ไม่เสถียร' : outcome === 'skipped' ? 'ข้าม' : 'ไม่ผ่าน'}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-gray-500">{(item.duration / 1000).toFixed(2)}s</td>
                      <td className="min-w-64 px-4 py-2 text-gray-600">
                        {needsEvidence && (
                          <div className="space-y-2">
                            {item.errors.length > 0 ? (
                              <ul className="list-inside list-disc space-y-1">
                                {item.errors.map((error, errorIndex) => (
                                  <li key={`${item.testCaseId}-error-${errorIndex}`} className="whitespace-pre-wrap">{error}</li>
                                ))}
                              </ul>
                            ) : <p>ไม่มีข้อความผิดพลาด</p>}
                            {item.screenshotUrls && item.screenshotUrls.length > 0 && (
                              <div className="flex flex-wrap gap-2">
                                {item.screenshotUrls.map((url, screenshotIndex) => (
                                  <a key={url} href={url} target="_blank" rel="noreferrer" aria-label={`เปิดภาพหลักฐาน ${screenshotIndex + 1}`}>
                                    <img src={url} alt={`ภาพหลักฐาน ${screenshotIndex + 1}`} className="h-20 rounded border border-gray-200 object-contain" loading="lazy" />
                                  </a>
                                ))}
                              </div>
                            )}
                            {item.videoUrl && (
                              <video controls preload="metadata" className="max-h-48 w-full rounded border border-gray-200">
                                <source src={item.videoUrl} type="video/webm" />
                                เบราว์เซอร์ไม่รองรับวิดีโอ
                              </video>
                            )}
                            {item.traceUrl && (
                              <a className="inline-flex text-blue-700 underline" href={item.traceUrl} target="_blank" rel="noreferrer">
                                เปิด Trace ({item.traceUrl.split('/').pop()})
                              </a>
                            )}
                          </div>
                        )}
                        {!needsEvidence && item.errors.length}
                      </td>
                      {usesMcp && (
                        <td className="px-4 py-2">
                          <span className={`text-xs px-2 py-1 rounded-full ${unsupportedPerCase > 0 ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-600'}`}>
                            {unsupportedPerCase}
                          </span>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {usesMcp && run.mcpTrace && run.mcpTrace.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
          <h2 className="text-base font-semibold text-gray-700 mb-3">MCP Trace</h2>
          <div className="max-h-72 overflow-auto rounded-lg border border-gray-200">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-gray-500 text-left">
                  <th className="px-4 py-2 font-medium">Time</th>
                  <th className="px-4 py-2 font-medium">Step</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Message</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {run.mcpTrace.map((item, index) => {
                  const row = item as {
                    timestamp?: string;
                    step?: string;
                    status?: string;
                    message?: string;
                  };

                  return (
                    <tr key={`${row.timestamp ?? 't'}-${index}`}>
                      <td className="px-4 py-2 text-gray-500">{row.timestamp ?? '-'}</td>
                      <td className="px-4 py-2 text-gray-700">{row.step ?? '-'}</td>
                      <td className="px-4 py-2">
                        <span className={`text-xs px-2 py-1 rounded-full ${row.status === 'ok' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'}`}>
                          {row.status ?? '-'}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-gray-600">{row.message ?? '-'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

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
