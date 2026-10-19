import { useEffect, useMemo, useRef, useState } from 'react';
import { collection, onSnapshot } from 'firebase/firestore';
import { useSearchParams } from 'react-router-dom';
import { db } from '../lib/firebase';
import type { TestCase, Project } from '../types';
import { useAuth } from '../context/AuthContext';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:4000';

interface FailedGenerationCase {
  jobId: string;
  caseId: string;
  projectId: string;
  projectName: string;
  title: string;
  page: string;
  type: 'UI' | 'API';
  errorMessage: string;
  retryErrorMessage: string;
  retryStatus: 'idle' | 'running' | 'failed';
}

interface GenerationJobCase {
  id: string;
  sequence: number;
  title: string;
  description: string;
  type: 'UI' | 'API';
  testSteps: string[];
  expectedResult: string;
  page: string;
  status: 'planned' | 'generating' | 'saved' | 'failed';
  testCaseId?: string;
  errorMessage?: string;
  retryStatus?: 'idle' | 'running' | 'failed';
}

interface GenerationJob {
  id: string;
  projectId: string;
  projectName: string;
  targetUrl: string;
  status: string;
  caseCount: number;
  createdAt?: unknown;
  scriptGenerationStatus?: string;
  scriptGenerationTargetCount?: number;
  scriptGenerationCompletedCount?: number;
  scriptGenerationCurrentTitle?: string;
  scriptGenerationMessage?: string;
  scriptGenerationError?: string;
  cases: GenerationJobCase[];
}

const fetchFailedGenerationCases = async (token: string): Promise<FailedGenerationCase[]> => {
  const response = await fetch(`${BACKEND_URL}/api/v2/generation-failures`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await response.json() as { cases?: FailedGenerationCase[]; error?: string };
  if (!response.ok) throw new Error(data.error || 'โหลดรายการสร้าง Test Script ที่ล้มเหลวไม่สำเร็จ');
  return Array.isArray(data.cases) ? data.cases : [];
};

const fetchGenerationJobs = async (
  token: string,
  caseCursors: Map<string, string>,
  casesByJob: Map<string, GenerationJobCase[]>,
  wasJobActive: Map<string, boolean>,
): Promise<GenerationJob[]> => {
  const response = await fetch(`${BACKEND_URL}/api/v2/generation-jobs`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await response.json() as { jobs?: Omit<GenerationJob, 'cases'>[]; error?: string };
  if (!response.ok) throw new Error(data.error || 'โหลดรายการ Test case ไม่สำเร็จ');

  const jobs = await Promise.all((data.jobs ?? []).map(async job => {
    const cachedCases = casesByJob.get(job.id);
    const isActive = Boolean(['pending', 'running'].includes(job.status)
      || job.scriptGenerationStatus === 'running'
      || cachedCases?.some(testCase => testCase.retryStatus === 'running'));
    const needsFinalRefresh = wasJobActive.get(job.id) === true;
    wasJobActive.set(job.id, isActive);
    if (cachedCases && !isActive && !needsFinalRefresh) return { ...job, cases: cachedCases };

    const query = new URLSearchParams({ includePrimaryScript: 'false' });
    const cursor = caseCursors.get(job.id);
    if (cursor) query.set('since', cursor);

    const detailResponse = await fetch(`${BACKEND_URL}/api/v2/generation-jobs/${encodeURIComponent(job.id)}?${query}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const detail = await detailResponse.json() as { cases?: GenerationJobCase[]; caseCursor?: string; error?: string };
    if (!detailResponse.ok) throw new Error(detail.error || `โหลด Test case ของ Job ${job.id} ไม่สำเร็จ`);

    const mergedCases = new Map((casesByJob.get(job.id) ?? []).map(testCase => [testCase.id, testCase]));
    (detail.cases ?? []).forEach(testCase => mergedCases.set(testCase.id, testCase));
    const cases = Array.from(mergedCases.values()).sort((left, right) => left.sequence - right.sequence);
    casesByJob.set(job.id, cases);
    if (detail.caseCursor) caseCursors.set(job.id, detail.caseCursor);

    return { ...job, cases };
  }));

  const activeJobIds = new Set(jobs.map(job => job.id));
  caseCursors.forEach((_, jobId) => {
    if (!activeJobIds.has(jobId)) {
      caseCursors.delete(jobId);
      wasJobActive.delete(jobId);
    }
  });
  casesByJob.forEach((_, jobId) => {
    if (!activeJobIds.has(jobId)) casesByJob.delete(jobId);
  });
  return jobs;
};

const toMillis = (value: unknown): number => {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();

  const asTimestamp = value as { seconds?: number; nanoseconds?: number; toDate?: () => Date };
  if (typeof asTimestamp.toDate === 'function') {
    return asTimestamp.toDate().getTime();
  }
  if (typeof asTimestamp.seconds === 'number') {
    const nanos = typeof asTimestamp.nanoseconds === 'number' ? asTimestamp.nanoseconds : 0;
    return asTimestamp.seconds * 1000 + Math.floor(nanos / 1_000_000);
  }

  return 0;
};

export default function TestCasesPage() {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const requestedJobId = searchParams.get('jobId');
  const [projects, setProjects] = useState<Project[]>([]);
  const [testCases, setTestCases] = useState<TestCase[]>([]);
  const [failedGenerationCases, setFailedGenerationCases] = useState<FailedGenerationCase[]>([]);
  const [isLoadingGenerationFailures, setIsLoadingGenerationFailures] = useState(true);
  const [generationFailureRefreshKey, setGenerationFailureRefreshKey] = useState(0);
  const [generationJobs, setGenerationJobs] = useState<GenerationJob[]>([]);
  const [isLoadingGenerationJobs, setIsLoadingGenerationJobs] = useState(true);
  const [generationJobsError, setGenerationJobsError] = useState('');
  const [generationJobsRefreshKey, setGenerationJobsRefreshKey] = useState(0);
  const generationJobCursors = useRef(new Map<string, string>());
  const generationCasesByJob = useRef(new Map<string, GenerationJobCase[]>());
  const generationJobActiveStates = useRef(new Map<string, boolean>());
  const [selectedPlanCaseIds, setSelectedPlanCaseIds] = useState<string[]>([]);
  const [generatingJobIds, setGeneratingJobIds] = useState<string[]>([]);
  const [generationActionMessage, setGenerationActionMessage] = useState('');
  const [retryingCaseIds, setRetryingCaseIds] = useState<string[]>([]);
  const [generationFailureMessage, setGenerationFailureMessage] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [editingCase, setEditingCase] = useState<TestCase | null>(null);
  const [editedScript, setEditedScript] = useState('');
  const [isRunning, setIsRunning] = useState(false);

  useEffect(() => {
    const unsubCases = onSnapshot(collection(db, 'testCases'), (snapshot) => {
      const cases = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as TestCase));
      setTestCases(cases);

      // Derive unique projects and keep each project's earliest case createdAt.
      const projMap = new Map<string, Project>();
      cases.forEach(tc => {
        const caseCreatedAt = tc.createdAt ? new Date(toMillis(tc.createdAt as unknown)) : new Date(0);
        const existing = projMap.get(tc.projectId);

        if (!existing) {
          projMap.set(tc.projectId, { id: tc.projectId, name: tc.projectName, url: '', createdAt: caseCreatedAt });
          return;
        }

        if (caseCreatedAt.getTime() < existing.createdAt.getTime()) {
          projMap.set(tc.projectId, { ...existing, createdAt: caseCreatedAt });
        }
      });
      const projList = Array.from(projMap.values()).sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
      );

      setProjects(projList);
    });

    return () => unsubCases();
  }, []);

  useEffect(() => {
    let active = true;
    if (!user) {
      return () => { active = false; };
    }

    user.getIdToken()
      .then(fetchFailedGenerationCases)
      .then(cases => {
        if (active) {
          setFailedGenerationCases(cases);
          setGenerationFailureMessage('');
        }
      })
      .catch(error => {
        if (active) setGenerationFailureMessage(error instanceof Error ? error.message : 'โหลดรายการที่ล้มเหลวไม่สำเร็จ');
      })
      .finally(() => {
        if (active) setIsLoadingGenerationFailures(false);
      });

    return () => { active = false; };
  }, [user, generationFailureRefreshKey]);

  useEffect(() => {
    let active = true;
    if (!user) {
      setGenerationJobs([]);
      setIsLoadingGenerationJobs(false);
      generationJobCursors.current.clear();
      generationCasesByJob.current.clear();
      generationJobActiveStates.current.clear();
      return () => { active = false; };
    }

    setIsLoadingGenerationJobs(true);
    user.getIdToken()
      .then(token => fetchGenerationJobs(
        token,
        generationJobCursors.current,
        generationCasesByJob.current,
        generationJobActiveStates.current,
      ))
      .then(jobs => {
        if (active) {
          setGenerationJobs(jobs);
          setGenerationJobsError('');
        }
      })
      .catch(error => {
        if (active) setGenerationJobsError(error instanceof Error ? error.message : 'โหลดรายการ Test case ไม่สำเร็จ');
      })
      .finally(() => {
        if (active) setIsLoadingGenerationJobs(false);
      });

    return () => { active = false; };
  }, [user, generationJobsRefreshKey]);

  useEffect(() => {
    const requestedJob = generationJobs.find(job => job.id === requestedJobId);
    if (requestedJob) setSelectedProjectId(requestedJob.projectId);
  }, [generationJobs, requestedJobId]);

  const hasActiveGenerationJobs = generationJobs.some(job =>
    ['pending', 'running'].includes(job.status)
      || job.scriptGenerationStatus === 'running'
      || job.cases.some(testCase => testCase.retryStatus === 'running')
  );

  useEffect(() => {
    if (!hasActiveGenerationJobs) return;
    const intervalId = window.setInterval(() => {
      setGenerationJobsRefreshKey(key => key + 1);
    }, 10000);
    return () => window.clearInterval(intervalId);
  }, [hasActiveGenerationJobs]);

  const allProjects = useMemo(() => {
    const projectMap = new Map(projects.map(project => [project.id, project]));
    generationJobs.forEach(job => {
      if (!projectMap.has(job.projectId)) {
        projectMap.set(job.projectId, {
          id: job.projectId,
          name: job.projectName,
          url: job.targetUrl,
          createdAt: new Date(toMillis(job.createdAt)),
        });
      }
    });
    failedGenerationCases.forEach(failedCase => {
      if (!projectMap.has(failedCase.projectId)) {
        projectMap.set(failedCase.projectId, {
          id: failedCase.projectId,
          name: failedCase.projectName,
          url: '',
          createdAt: new Date(0),
        });
      }
    });
    return Array.from(projectMap.values()).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }, [projects, generationJobs, failedGenerationCases]);

  const activeProjectId = selectedProjectId && allProjects.some(project => project.id === selectedProjectId)
    ? selectedProjectId
    : allProjects[0]?.id ?? null;

  const filteredCases = activeProjectId
    ? testCases.filter(tc => tc.projectId === activeProjectId)
    : [];
  const filteredFailedGenerationCases = activeProjectId
    ? failedGenerationCases.filter(failedCase => failedCase.projectId === activeProjectId)
    : failedGenerationCases;
  const filteredGenerationJobs = activeProjectId
    ? generationJobs.filter(job => job.projectId === activeProjectId && (!requestedJobId || job.id === requestedJobId))
    : [];

  const togglePlanCase = (jobId: string, caseId: string) => {
    const selectionKey = `${jobId}:${caseId}`;
    setSelectedPlanCaseIds(previous => previous.includes(selectionKey)
      ? previous.filter(id => id !== selectionKey)
      : [...previous, selectionKey]);
  };

  const handleGenerateJobScripts = async (jobId: string, requestedCaseIds?: string[]) => {
    if (!user) return;
    setGeneratingJobIds(previous => [...previous, jobId]);
    setGenerationActionMessage('');
    try {
      const token = await user.getIdToken();
      const response = await fetch(`${BACKEND_URL}/api/v2/generation-jobs/${encodeURIComponent(jobId)}/generate-scripts`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestedCaseIds ? { caseIds: requestedCaseIds } : {}),
      });
      const data = await response.json() as { acceptedCaseCount?: number; error?: string };
      if (!response.ok) throw new Error(data.error || 'เริ่มสร้าง Test Script ไม่สำเร็จ');
      setGenerationActionMessage(`เริ่มสร้าง Test Script ${data.acceptedCaseCount ?? 0} เคสใน Job ${jobId} แล้ว`);
      setSelectedPlanCaseIds(previous => previous.filter(id => requestedCaseIds
        ? !requestedCaseIds.some(caseId => id === `${jobId}:${caseId}`)
        : !id.startsWith(`${jobId}:`)));
      setGenerationJobsRefreshKey(key => key + 1);
    } catch (error) {
      setGenerationActionMessage(error instanceof Error ? error.message : 'เริ่มสร้าง Test Script ไม่สำเร็จ');
    } finally {
      setGeneratingJobIds(previous => previous.filter(id => id !== jobId));
    }
  };

  const handleRetryGenerationCase = async (failedCase: FailedGenerationCase) => {
    if (!user) return;
    const retryKey = `${failedCase.jobId}:${failedCase.caseId}`;
    setRetryingCaseIds(previous => [...previous, retryKey]);
    setGenerationFailureMessage('');
    try {
      const token = await user.getIdToken();
      const response = await fetch(`${BACKEND_URL}/api/v2/generation-jobs/${encodeURIComponent(failedCase.jobId)}/cases/${encodeURIComponent(failedCase.caseId)}/retry`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || 'สร้าง Test Script ใหม่ไม่สำเร็จ');
      const cases = await fetchFailedGenerationCases(token);
      setFailedGenerationCases(cases);
      setGenerationJobsRefreshKey(key => key + 1);
    } catch (error) {
      setGenerationFailureMessage(error instanceof Error ? error.message : 'สร้าง Test Script ใหม่ไม่สำเร็จ');
      setGenerationJobsRefreshKey(key => key + 1);
      try {
        const token = await user.getIdToken();
        setFailedGenerationCases(await fetchFailedGenerationCases(token));
      } catch (refreshError) {
        console.error(refreshError);
      }
    } finally {
      setRetryingCaseIds(previous => previous.filter(id => id !== retryKey));
    }
  };

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
        {allProjects.length === 0 ? (
          <p className="text-xs text-gray-400">ยังไม่มีโปรเจค</p>
        ) : (
          allProjects.map(p => (
            <button
              key={p.id}
              onClick={() => setSelectedProjectId(p.id)}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                activeProjectId === p.id ? 'bg-blue-100 text-blue-700 font-medium' : 'text-gray-600 hover:bg-gray-100'
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

        <section className="overflow-hidden rounded-xl border border-blue-200 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-blue-100 px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold text-gray-800">Test case ตาม Job</h2>
              <p className="mt-1 text-xs text-gray-500">รายการแสดงทุกเคสและสถานะ Script ของแต่ละเคส</p>
            </div>
            <button
              type="button"
              onClick={() => setGenerationJobsRefreshKey(key => key + 1)}
              disabled={isLoadingGenerationJobs || !user}
              className="text-xs font-medium text-blue-700 hover:text-blue-900 disabled:cursor-wait disabled:opacity-50"
            >
              {isLoadingGenerationJobs ? 'กำลังโหลด...' : 'รีเฟรช Job'}
            </button>
          </div>
          {generationJobsError && (
            <p role="alert" className="border-b border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">{generationJobsError}</p>
          )}
          {generationActionMessage && (
            <p role="status" className="border-b border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-800">{generationActionMessage}</p>
          )}
          {isLoadingGenerationJobs && filteredGenerationJobs.length === 0 ? (
            <p className="px-4 py-4 text-sm text-gray-500">กำลังโหลด Test case...</p>
          ) : filteredGenerationJobs.length === 0 ? (
            <p className="px-4 py-4 text-sm text-gray-500">ยังไม่มี Job ในโปรเจกต์นี้</p>
          ) : (
            filteredGenerationJobs.map(job => {
              const planReady = ['completed', 'incomplete'].includes(job.status);
              const eligibleCases = planReady
                ? job.cases.filter(testCase => (testCase.status === 'planned' || testCase.status === 'failed') && testCase.retryStatus !== 'running')
                : [];
              const selectedCaseIds = eligibleCases
                .filter(testCase => selectedPlanCaseIds.includes(`${job.id}:${testCase.id}`))
                .map(testCase => testCase.id);
              const isGenerating = generatingJobIds.includes(job.id) || job.scriptGenerationStatus === 'running';

              return (
                <article key={job.id} className="border-b border-gray-100 last:border-b-0">
                  <div className="flex flex-col gap-3 bg-gray-50 px-4 py-4 lg:flex-row lg:items-center lg:justify-between">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-gray-800">{job.projectName}</p>
                      <p className="mt-1 break-all text-xs text-gray-500">Job ID: {job.id}</p>
                      <p className="mt-1 text-xs text-gray-500">{job.cases.length} เคส · {job.targetUrl}</p>
                      {job.scriptGenerationMessage && (
                        <p className="mt-1 text-xs text-blue-700">
                          {job.scriptGenerationMessage}{job.scriptGenerationCurrentTitle ? ` · ${job.scriptGenerationCurrentTitle}` : ''}
                        </p>
                      )}
                      {job.scriptGenerationStatus === 'running' && (
                        <p className="mt-1 text-xs text-gray-600">ความคืบหน้า Script: {job.scriptGenerationCompletedCount ?? 0}/{job.scriptGenerationTargetCount ?? 0}</p>
                      )}
                      {job.scriptGenerationError && <p className="mt-1 text-xs text-red-700">{job.scriptGenerationError}</p>}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleGenerateJobScripts(job.id, selectedCaseIds)}
                        disabled={selectedCaseIds.length === 0 || isGenerating || !user}
                        className="rounded-md border border-blue-700 px-3 py-2 text-xs font-medium text-blue-800 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        สร้างที่เลือก ({selectedCaseIds.length})
                      </button>
                      <button
                        type="button"
                        onClick={() => handleGenerateJobScripts(job.id)}
                        disabled={eligibleCases.length === 0 || isGenerating || !user}
                        className="rounded-md bg-blue-700 px-3 py-2 text-xs font-medium text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {isGenerating ? 'กำลังสร้าง...' : `สร้างทั้งหมดที่เหลือ (${eligibleCases.length})`}
                      </button>
                    </div>
                  </div>
                  {job.cases.length === 0 ? (
                    <p className="px-4 py-4 text-sm text-gray-500">Job นี้ยังไม่มี Test case ที่วางแผนไว้</p>
                  ) : (
                    <ol className="divide-y divide-gray-100">
                      {job.cases.map(testCase => {
                        const isEligible = (testCase.status === 'planned' || testCase.status === 'failed') && testCase.retryStatus !== 'running';
                        const isSelected = selectedPlanCaseIds.includes(`${job.id}:${testCase.id}`);
                        const stateClass = testCase.retryStatus === 'running' || testCase.status === 'generating'
                          ? 'text-blue-700'
                          : testCase.status === 'saved'
                          ? 'text-green-700'
                          : testCase.status === 'failed'
                            ? 'text-red-700'
                            : 'text-gray-600';
                        const stateLabel = testCase.retryStatus === 'running'
                          ? 'กำลังลองสร้างใหม่'
                          : testCase.status === 'saved'
                          ? 'สร้างแล้ว'
                          : testCase.status === 'failed'
                            ? 'สร้างไม่สำเร็จ'
                            : testCase.status === 'generating'
                              ? 'กำลังสร้าง'
                              : 'รอสร้าง';

                        return (
                          <li key={testCase.id} className="grid grid-cols-[auto_minmax(0,1fr)] gap-3 px-4 py-4 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              disabled={!isEligible || !planReady || isGenerating}
                              onChange={() => togglePlanCase(job.id, testCase.id)}
                              aria-label={`เลือก ${testCase.title} สำหรับสร้าง Script`}
                              className="mt-1 rounded"
                            />
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                                <span className="text-sm font-medium text-gray-800">{testCase.sequence}. {testCase.title}</span>
                                <span className={`text-xs font-medium ${stateClass}`}>{stateLabel}</span>
                                <span className="text-xs text-gray-500">{testCase.type}</span>
                              </div>
                              <p className="mt-1 text-xs text-gray-500">{testCase.page}</p>
                              <p className="mt-2 text-sm text-gray-700">{testCase.description}</p>
                              {testCase.testSteps.length > 0 && (
                                <ol className="mt-2 list-inside list-decimal space-y-1 text-xs text-gray-600">
                                  {testCase.testSteps.map((step, index) => <li key={`${testCase.id}-step-${index}`}>{step}</li>)}
                                </ol>
                              )}
                              <p className="mt-2 text-xs text-gray-600"><span className="font-medium">ผลที่คาดหวัง:</span> {testCase.expectedResult}</p>
                              {testCase.testCaseId && <p className="mt-1 text-xs text-gray-500">Test Script ID: {testCase.testCaseId}</p>}
                              {testCase.errorMessage && <p className="mt-1 text-xs text-red-700">{testCase.errorMessage}</p>}
                            </div>
                            {isEligible && !isGenerating && planReady && (
                              <button
                                type="button"
                                onClick={() => handleGenerateJobScripts(job.id, [testCase.id])}
                                disabled={!user}
                                className="col-start-2 justify-self-start text-xs font-medium text-blue-700 hover:text-blue-900 disabled:opacity-50 sm:col-start-3 sm:self-center"
                              >
                                สร้าง Script
                              </button>
                            )}
                          </li>
                        );
                      })}
                    </ol>
                  )}
                </article>
              );
            })
          )}
        </section>

        <section className="bg-white rounded-xl border border-amber-200 overflow-hidden">
          <div className="flex items-center justify-between border-b border-amber-100 px-4 py-3">
            <h2 className="text-sm font-semibold text-gray-800">สร้าง Test Script ไม่สำเร็จ</h2>
            <div className="flex items-center gap-3">
              <span className="text-xs text-amber-700">{filteredFailedGenerationCases.length} รายการ</span>
              <button
                type="button"
                onClick={() => {
                  setIsLoadingGenerationFailures(true);
                  setGenerationFailureRefreshKey(key => key + 1);
                }}
                disabled={isLoadingGenerationFailures || !user}
                className="text-xs font-medium text-blue-600 hover:text-blue-800 disabled:cursor-wait disabled:opacity-50"
              >
                {isLoadingGenerationFailures ? 'กำลังโหลด...' : 'รีเฟรชรายการ'}
              </button>
            </div>
          </div>
          {generationFailureMessage && (
            <p role="alert" className="px-4 py-3 text-sm text-red-700 bg-red-50">{generationFailureMessage}</p>
          )}
          {isLoadingGenerationFailures && filteredFailedGenerationCases.length === 0 ? (
            <p className="px-4 py-4 text-sm text-gray-500">กำลังโหลดรายการที่ลองสร้างใหม่ได้...</p>
          ) : filteredFailedGenerationCases.length === 0 ? (
            <p className="px-4 py-4 text-sm text-gray-500">ไม่มี Test Script ที่ล้มเหลวในโปรเจกต์นี้ หากเพิ่งจบงาน ให้กด “รีเฟรชรายการ”</p>
          ) : (
            filteredFailedGenerationCases.map(failedCase => {
              const retryKey = `${failedCase.jobId}:${failedCase.caseId}`;
              const isRetrying = retryingCaseIds.includes(retryKey) || failedCase.retryStatus === 'running';
              return (
                <div key={retryKey} className="flex flex-col gap-3 border-b border-gray-100 px-4 py-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-800">{failedCase.title}</p>
                    <p className="mt-1 text-xs text-gray-500">{failedCase.projectName}{failedCase.page ? ` · ${failedCase.page}` : ''}</p>
                    <p className="mt-2 text-xs text-red-700">{failedCase.errorMessage}</p>
                    {failedCase.retryErrorMessage && (
                      <p className="mt-1 text-xs text-red-700">ลองใหม่ล่าสุดไม่สำเร็จ: {failedCase.retryErrorMessage}</p>
                    )}
                  </div>
                  <button
                    onClick={() => handleRetryGenerationCase(failedCase)}
                    disabled={isRetrying || !user}
                    className="shrink-0 rounded-md bg-amber-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isRetrying ? 'กำลังลองสร้างใหม่...' : 'สร้าง Test Script ใหม่'}
                  </button>
                </div>
              );
            })
          )}
        </section>

        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          {filteredCases.length === 0 ? (
            <div className="p-8 text-center text-gray-400 text-sm">
              {activeProjectId ? 'ยังไม่มีชุดทดสอบในโปรเจคนี้' : 'กรุณาเลือกโปรเจค'}
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
                      {tc.lastRunAt ? new Date(toMillis(tc.lastRunAt)).toLocaleDateString('th-TH') : '-'}
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
