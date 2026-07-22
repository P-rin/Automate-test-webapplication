import { useEffect, useState } from 'react';
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from '../lib/firebase';
import type { TestCase, Project } from '../types';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:4000';

export default function TestCasesPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [testCases, setTestCases] = useState<TestCase[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [editingCase, setEditingCase] = useState<TestCase | null>(null);
  const [editedScript, setEditedScript] = useState('');
  const [isRunning, setIsRunning] = useState(false);

  useEffect(() => {
    const unsubCases = onSnapshot(collection(db, 'testCases'), (snapshot) => {
      const cases = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as TestCase));
      setTestCases(cases);

      // Derive unique projects
      const projMap = new Map<string, Project>();
      cases.forEach(tc => {
        if (!projMap.has(tc.projectId)) {
          projMap.set(tc.projectId, { id: tc.projectId, name: tc.projectName, url: '', createdAt: new Date() });
        }
      });
      const projList = Array.from(projMap.values());
      setProjects(projList);
      if (!selectedProjectId && projList.length > 0) {
        setSelectedProjectId(projList[0].id);
      }
    });

    return () => unsubCases();
  }, []);

  const filteredCases = selectedProjectId
    ? testCases.filter(tc => tc.projectId === selectedProjectId)
    : [];

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const handleExecute = async () => {
    if (selectedIds.length === 0) return;
    setIsRunning(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/v2/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testCaseIds: selectedIds, engine: 'playwright' }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json() as {
        runId: string;
        engineRequested?: 'playwright' | 'mcp';
        engineUsed?: 'playwright' | 'mcp';
        fallbackReason?: string;
      };

      const fallbackLine = data.fallbackReason ? `\nFallback: ${data.fallbackReason}` : '';
      alert(`สั่งรันเทสเรียบร้อยแล้ว\nRun ID: ${data.runId}\nEngine: ${data.engineUsed ?? 'playwright'}${fallbackLine}`);
      setSelectedIds([]);
    } catch (err) {
      console.error(err);
      alert('เกิดข้อผิดพลาดในการสั่งรัน');
    } finally {
      setIsRunning(false);
    }
  };

  const handleSaveEdit = async () => {
    if (!editingCase) return;
    try {
      const res = await fetch(`${BACKEND_URL}/api/test-case-script`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testCaseId: editingCase.id, script: editedScript }),
      });

      if (!res.ok) {
        throw new Error(await res.text());
      }

      setEditingCase(null);
    } catch (err) {
      console.error(err);
      alert('เกิดข้อผิดพลาดในการบันทึกการแก้ไข');
    }
  };

  const statusBadge = (status: string) => {
    const map: Record<string, string> = {
      pass: 'bg-green-100 text-green-700',
      fail: 'bg-red-100 text-red-600',
      running: 'bg-yellow-100 text-yellow-700',
      pending: 'bg-gray-100 text-gray-500',
    };
    const labels: Record<string, string> = {
      pass: 'ผ่าน', fail: 'ไม่ผ่าน', running: 'กำลังรัน', pending: 'รอดำเนินการ',
    };
    return (
      <span className={`text-xs px-2 py-1 rounded-full font-medium ${map[status] || map.pending}`}>
        {labels[status] || 'รอดำเนินการ'}
      </span>
    );
  };

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <aside className="w-56 bg-white border-r border-gray-200 p-4 space-y-1">
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">โปรเจค</h2>
        {projects.length === 0 ? (
          <p className="text-xs text-gray-400">ยังไม่มีโปรเจค</p>
        ) : (
          projects.map(p => (
            <button
              key={p.id}
              onClick={() => setSelectedProjectId(p.id)}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                selectedProjectId === p.id ? 'bg-blue-100 text-blue-700 font-medium' : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              {p.name}
            </button>
          ))
        )}
      </aside>

      {/* Main */}
      <div className="flex-1 p-6 space-y-4 overflow-auto">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-800">คลังชุดทดสอบ</h1>
          <button
            onClick={handleExecute}
            disabled={selectedIds.length === 0 || isRunning}
            className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {isRunning ? 'กำลังสั่งรัน...' : `▶ รันที่เลือก (${selectedIds.length})`}
          </button>
        </div>

        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          {filteredCases.length === 0 ? (
            <div className="p-8 text-center text-gray-400 text-sm">
              {selectedProjectId ? 'ยังไม่มีชุดทดสอบในโปรเจคนี้' : 'กรุณาเลือกโปรเจค'}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-gray-500 text-left">
                  <th className="px-4 py-3 w-10"></th>
                  <th className="px-4 py-3 font-medium">ชื่อชุดทดสอบ</th>
                  <th className="px-4 py-3 font-medium">ประเภท</th>
                  <th className="px-4 py-3 font-medium">ผลล่าสุด</th>
                  <th className="px-4 py-3 font-medium">แก้ไขล่าสุด</th>
                  <th className="px-4 py-3 font-medium">จัดการ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filteredCases.map(tc => (
                  <tr key={tc.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(tc.id)}
                        onChange={() => toggleSelect(tc.id)}
                        className="rounded"
                      />
                    </td>
                    <td className="px-4 py-3 text-gray-800 font-medium">{tc.title}</td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-1 rounded-full ${tc.type === 'UI' ? 'bg-purple-100 text-purple-700' : 'bg-orange-100 text-orange-700'}`}>
                        {tc.type}
                      </span>
                    </td>
                    <td className="px-4 py-3">{statusBadge(tc.lastStatus)}</td>
                    <td className="px-4 py-3 text-gray-400 text-xs">
                      {tc.lastRunAt ? new Date((tc.lastRunAt as any).seconds * 1000).toLocaleDateString('th-TH') : '-'}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => { setEditingCase(tc); setEditedScript(tc.script); }}
                        className="text-blue-500 hover:underline text-xs"
                      >
                        ดู/แก้ไขโค้ด
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Edit Modal */}
      {editingCase && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between p-5 border-b">
              <h3 className="font-semibold text-gray-800">{editingCase.title}</h3>
              <button onClick={() => setEditingCase(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
            </div>
            <div className="flex-1 p-5 overflow-auto">
              <textarea
                value={editedScript}
                onChange={e => setEditedScript(e.target.value)}
                className="w-full h-72 bg-gray-900 text-green-300 text-xs p-4 rounded-lg font-mono resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="flex justify-end gap-3 p-5 border-t">
              <button onClick={() => setEditingCase(null)} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">ยกเลิก</button>
              <button onClick={handleSaveEdit} className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">บันทึกการแก้ไข</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
