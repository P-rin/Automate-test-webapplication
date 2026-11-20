import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useProjectTestCases } from '../lib/testCasesStore';
import { useProjectPages } from '../lib/projectPages';
import type { TestCase, Project, ValidationStatus } from '../types';
import { useAuth } from '../context/AuthContext';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:4000';

interface GenerationJobCase {
  id: string;
  sequence: number;
  title: string;
  description: string;
  type: 'UI' | 'API';
  testSteps: string[];
  expectedResult: string;
  page: string;
  pageId?: string;
  status: 'planned' | 'generating' | 'saved' | 'failed';
  requirementIds?: string[];
  category?: string;
  testCaseId?: string;
  errorMessage?: string;
  retryErrorMessage?: string;
  retryStatus?: 'idle' | 'running' | 'failed';
}

type CoverageState = 'missing' | 'in_progress' | 'unverified' | 'failing' | 'covered' | 'manual';

interface CoverageReport {
  criteria: Array<{
    id: string;
    priority: string;
    expected: string;
    state: CoverageState;
    ambiguity: string;
    linkedCases: Array<{
      id: string;
      title: string;
      status: string;
      lastStatus?: string;
    }>;
  }>;
  totals: Record<CoverageState, number>;
  ambiguities: Array<{ acId: string; text: string }>;
}

interface CoveragePanelState {
  report?: CoverageReport;
  isLoading: boolean;
  error?: string;
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

const testPlanCategoryLabels: Record<string, string> = {
  happy_path: 'เส้นทางปกติ',
  validation: 'ตรวจสอบข้อมูล',
  negative: 'กรณีผิดพลาด',
  boundary: 'ค่าขอบเขต',
  access_control: 'สิทธิ์การเข้าถึง',
  exploratory: 'สำรวจเพิ่มเติม',
};

const coverageStateLabels: Record<CoverageState, string> = {
  missing: 'ยังไม่มีเคส',
  in_progress: 'รอดำเนินการ',
  unverified: 'ยังไม่ยืนยันผล',
  failing: 'ไม่ผ่าน',
  covered: 'ครอบคลุมแล้ว',
  manual: 'ตรวจสอบด้วยคน',
};

const coverageStateStyles: Record<CoverageState, string> = {
  missing: 'bg-gray-100 text-gray-700',
  in_progress: 'bg-blue-100 text-blue-800',
  unverified: 'bg-amber-100 text-amber-800',
  failing: 'bg-red-100 text-red-700',
  covered: 'bg-green-100 text-green-700',
  manual: 'bg-purple-100 text-purple-700',
};

const coverageStates: CoverageState[] = [
  'missing',
  'in_progress',
  'unverified',
  'failing',
  'covered',
  'manual',
];

type GenerationJobSummary = Omit<GenerationJob, 'cases'>;

const fetchGenerationJobSummaries = async (
  token: string,
  filter: { projectId: string } | { jobId: string },
): Promise<GenerationJobSummary[]> => {
  const response = await fetch(`${BACKEND_URL}/api/v2/generation-jobs?${new URLSearchParams(filter)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await response.json() as { jobs?: GenerationJobSummary[]; error?: string };
  if (!response.ok) throw new Error(data.error || 'โหลดรายการ Test case ไม่สำเร็จ');
  return data.jobs ?? [];
};

/**
 * Loads one project's jobs. Case details are cached per job (casesByJob) across
 * projects, and only re-fetched while a job is active or once right after it finishes.
 */
const fetchGenerationJobs = async (
  token: string,
  projectId: string,
  caseCursors: Map<string, string>,
  casesByJob: Map<string, GenerationJobCase[]>,
  wasJobActive: Map<string, boolean>,
): Promise<GenerationJob[]> => {
  const data = { jobs: await fetchGenerationJobSummaries(token, { projectId }) };

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

  return jobs.sort((left, right) => toMillis(right.createdAt) - toMillis(left.createdAt));
};

const toMillis = (value: unknown): number => {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();

  const asTimestamp = value as {
    seconds?: number;
    nanoseconds?: number;
    _seconds?: number;
    _nanoseconds?: number;
    toDate?: () => Date;
  };
  if (typeof asTimestamp.toDate === 'function') {
    return asTimestamp.toDate().getTime();
  }
  const seconds = asTimestamp.seconds ?? asTimestamp._seconds;
  if (typeof seconds === 'number') {
    const nanoseconds = asTimestamp.nanoseconds ?? asTimestamp._nanoseconds;
    const nanos = typeof nanoseconds === 'number' ? nanoseconds : 0;
    return seconds * 1000 + Math.floor(nanos / 1_000_000);
  }

  return 0;
};

const SHOWN_VALIDATION_STATUSES = new Set<ValidationStatus>(['verified', 'possible_bug']);

const VALIDATION_BADGES: Record<ValidationStatus, { label: string; className: string; title: string }> = {
  verified: { label: 'ยืนยันแล้ว', className: 'bg-green-50 text-green-700 border-green-200', title: 'รันกับเว็บจริงก่อนบันทึกแล้วผ่าน' },
  possible_bug: { label: 'อาจเป็นบั๊ก', className: 'bg-red-50 text-red-700 border-red-200', title: 'กรณีผิดปกติหรือค่าขอบเขตที่ตรวจไม่ผ่าน เว็บอาจไม่ได้จัดการกรณีนี้ ผู้ใช้เป็นผู้ตัดสิน' },
  oracle_unreliable: { label: 'ตัวตรวจไม่น่าเชื่อถือ', className: 'bg-amber-50 text-amber-800 border-amber-200', title: 'กรณีปกติที่ตรวจไม่ผ่าน มีแนวโน้มว่าวิธีตรวจผิด ไม่ใช่เว็บผิด' },
  needs_review: { label: 'ต้องตรวจสอบ', className: 'bg-gray-100 text-gray-600 border-gray-200', title: 'รันไม่จบ เช่น หา element ไม่เจอ หรือเตรียมสถานะไม่สำเร็จ' },
};

const evidenceLabel = (url: string): string => (/\.zip$/i.test(url) ? 'trace' : /\.webm$/i.test(url) ? 'วิดีโอ' : 'ภาพหน้าจอ');

export default function TestCasesPage() {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const requestedJobId = searchParams.get('jobId');
  const projectPages = useProjectPages(user?.uid);
  // A project opened from a link (?jobId=) may not be on the loaded page of projects;
  // it is shown pinned above the list.
  const [linkedProject, setLinkedProject] = useState<Project | null>(null);
  // Jobs of the open project. Each project's jobs are cached with the refresh key they
  // were loaded at, so switching back to a project doesn't call the backend again.
  const [generationJobs, setGenerationJobs] = useState<GenerationJob[]>([]);
  const generationJobsByProject = useRef(new Map<string, { jobs: GenerationJob[]; refreshKey: number }>());
  const [isLoadingGenerationJobs, setIsLoadingGenerationJobs] = useState(true);
  const [generationJobsError, setGenerationJobsError] = useState('');
  const [generationJobsRefreshKey, setGenerationJobsRefreshKey] = useState(0);
  const [expandedCoverageJobIds, setExpandedCoverageJobIds] = useState<Set<string>>(() => new Set());
  const [coverageByJobId, setCoverageByJobId] = useState<Record<string, CoveragePanelState>>({});
  const [coverageExportErrors, setCoverageExportErrors] = useState<Record<string, string>>({});
  const generationJobCursors = useRef(new Map<string, string>());
  const generationCasesByJob = useRef(new Map<string, GenerationJobCase[]>());
  const generationJobActiveStates = useRef(new Map<string, boolean>());
  const [selectedPlanCaseIds, setSelectedPlanCaseIds] = useState<string[]>([]);
  const [generatingJobIds, setGeneratingJobIds] = useState<string[]>([]);
  const [generationActionMessage, setGenerationActionMessage] = useState('');
  const [expandedTestCaseIds, setExpandedTestCaseIds] = useState<Set<string>>(() => new Set());
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [editingCase, setEditingCase] = useState<TestCase | null>(null);
  const [editedScript, setEditedScript] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showReviewCases, setShowReviewCases] = useState(false);

  const sidebarProjects = useMemo(() => (
    linkedProject && !projectPages.projects.some(project => project.id === linkedProject.id)
      ? [linkedProject, ...projectPages.projects]
      : projectPages.projects
  ), [linkedProject, projectPages.projects]);

  // The selection survives page changes; without one, the first listed project opens.
  const activeProjectId = selectedProjectId ?? sidebarProjects[0]?.id ?? null;

  // Only the open project's test cases are loaded (see testCasesStore).
  const { testCases: filteredCases, loaded: areTestCasesLoaded } = useProjectTestCases(user?.uid, activeProjectId);
  // Cases the validation run could not confirm (Phase 8d) are listed apart, with the reason; cases without a
  // validation result (legacy generation, hand-written) stay in the main list.
  const { mainCases, reviewCases } = useMemo(() => ({
    mainCases: filteredCases.filter(tc => !tc.validationStatus || SHOWN_VALIDATION_STATUSES.has(tc.validationStatus)),
    reviewCases: filteredCases.filter(tc => tc.validationStatus && !SHOWN_VALIDATION_STATUSES.has(tc.validationStatus)),
  }), [filteredCases]);

  // Opening a job from a link (?jobId=) selects its project, wherever it is in the list.
  useEffect(() => {
    if (!user || !requestedJobId) return;
    let active = true;
    user.getIdToken()
      .then(token => fetchGenerationJobSummaries(token, { jobId: requestedJobId }))
      .then(([job]) => {
        if (!active || !job) return;
        setLinkedProject({
          id: job.projectId,
          name: job.projectName,
          url: job.targetUrl,
          createdAt: new Date(toMillis(job.createdAt)),
        });
        setSelectedProjectId(job.projectId);
      })
      .catch(error => console.error('Could not open the linked job:', error));
    return () => { active = false; };
  }, [user, requestedJobId]);

  useEffect(() => {
    if (!user) {
      setGenerationJobs([]);
      setIsLoadingGenerationJobs(false);
      generationJobsByProject.current.clear();
      generationJobCursors.current.clear();
      generationCasesByJob.current.clear();
      generationJobActiveStates.current.clear();
      return;
    }
    if (!activeProjectId) {
      setGenerationJobs([]);
      setIsLoadingGenerationJobs(false);
      return;
    }

    const cached = generationJobsByProject.current.get(activeProjectId);
    setGenerationJobs(cached?.jobs ?? []);
    if (cached && cached.refreshKey === generationJobsRefreshKey) {
      setIsLoadingGenerationJobs(false);
      return;
    }

    let active = true;
    const projectId = activeProjectId;
    const refreshKey = generationJobsRefreshKey;
    setIsLoadingGenerationJobs(true);
    user.getIdToken()
      .then(token => fetchGenerationJobs(
        token,
        projectId,
        generationJobCursors.current,
        generationCasesByJob.current,
        generationJobActiveStates.current,
      ))
      .then(jobs => {
        generationJobsByProject.current.set(projectId, { jobs, refreshKey });
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
  }, [user, activeProjectId, generationJobsRefreshKey]);

  // Idle jobs normally reuse their cached cases; a manual refresh or a delete must reload
  // them, since cases can change while no job is running (e.g. reset to "planned").
  const reloadGenerationJobs = () => {
    generationJobCursors.current.clear();
    generationCasesByJob.current.clear();
    generationJobActiveStates.current.clear();
    setGenerationJobsRefreshKey(key => key + 1);
  };

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

  const fetchCoverage = async (jobId: string) => {
    if (!user) return;
    setCoverageByJobId(previous => ({
      ...previous,
      [jobId]: { ...previous[jobId], isLoading: true, error: undefined },
    }));

    try {
      const token = await user.getIdToken();
      const response = await fetch(`${BACKEND_URL}/api/v2/generation-jobs/${encodeURIComponent(jobId)}/coverage`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json() as CoverageReport & { error?: string };
      if (!response.ok) throw new Error(data.error || 'โหลดสรุป Requirement Coverage ไม่สำเร็จ');
      setCoverageByJobId(previous => ({
        ...previous,
        [jobId]: { report: data, isLoading: false },
      }));
    } catch (error) {
      setCoverageByJobId(previous => ({
        ...previous,
        [jobId]: {
          ...previous[jobId],
          isLoading: false,
          error: error instanceof Error ? error.message : 'โหลดสรุป Requirement Coverage ไม่สำเร็จ',
        },
      }));
    }
  };

  const toggleCoveragePanel = (jobId: string) => {
    const isExpanded = expandedCoverageJobIds.has(jobId);
    setExpandedCoverageJobIds(previous => {
      const next = new Set(previous);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });

    const panel = coverageByJobId[jobId];
    if (!isExpanded && !panel?.isLoading && (!panel?.report || panel.error)) void fetchCoverage(jobId);
  };

  const handleExportCoverage = async (jobId: string) => {
    if (!user) return;
    setCoverageExportErrors(previous => ({ ...previous, [jobId]: '' }));
    try {
      const token = await user.getIdToken();
      const response = await fetch(`${BACKEND_URL}/api/v2/generation-jobs/${encodeURIComponent(jobId)}/coverage.md`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        const contentType = response.headers.get('content-type') ?? '';
        const message = contentType.includes('application/json')
          ? ((await response.json()) as { error?: string }).error
          : undefined;
        throw new Error(message || 'ส่งออก TESTS.md ไม่สำเร็จ');
      }

      const markdown = await response.blob();
      const downloadUrl = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = 'TESTS.md';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 0);
    } catch (error) {
      setCoverageExportErrors(previous => ({
        ...previous,
        [jobId]: error instanceof Error ? error.message : 'ส่งออก TESTS.md ไม่สำเร็จ',
      }));
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const handleExecute = async () => {
    if (selectedIds.length === 0 || !user) return;
    setIsRunning(true);
    try {
      const token = await user.getIdToken();
      const res = await fetch(`${BACKEND_URL}/api/v2/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
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

  const handleDelete = async () => {
    if (selectedIds.length === 0 || !user) return;
    const confirmed = window.confirm(
      `ลบชุดทดสอบที่เลือก ${selectedIds.length} รายการ?\n`
      + 'ลบแล้วกู้คืนไม่ได้ เคสที่มาจากแผนทดสอบจะกลับเป็นสถานะ "วางแผนแล้ว" เพื่อให้สั่งสร้างสคริปต์ใหม่ได้',
    );
    if (!confirmed) return;

    setIsDeleting(true);
    try {
      const token = await user.getIdToken();
      const res = await fetch(`${BACKEND_URL}/api/test-cases/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ testCaseIds: selectedIds }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setSelectedIds([]);
      reloadGenerationJobs();
    } catch (err) {
      console.error(err);
      alert(`ลบชุดทดสอบไม่สำเร็จ: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleSaveEdit = async () => {
    if (!editingCase || !user) return;
    try {
      const token = await user.getIdToken();
      const res = await fetch(`${BACKEND_URL}/api/test-case-script`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
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

  const validationBadge = (tc: TestCase) => {
    if (!tc.validationStatus) return null;
    const badge = VALIDATION_BADGES[tc.validationStatus];
    return (
      <span title={badge.title} className={`ml-2 inline-block align-middle text-[11px] px-1.5 py-0.5 rounded border font-normal ${badge.className}`}>
        {badge.label}
      </span>
    );
  };

  const renderCaseTable = (cases: TestCase[]) => (
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
        {cases.map(tc => (
          <tr key={tc.id} className="hover:bg-gray-50 align-top">
            <td className="px-4 py-3">
              <input
                type="checkbox"
                checked={selectedIds.includes(tc.id)}
                onChange={() => toggleSelect(tc.id)}
                className="rounded"
              />
            </td>
            <td className="px-4 py-3 text-gray-800 font-medium">
              {tc.title}
              {validationBadge(tc)}
              {tc.validationStatus && tc.validationStatus !== 'verified' && tc.validationReason && (
                <p className="mt-1 text-xs font-normal text-gray-500 break-words">{tc.validationReason}</p>
              )}
              {tc.validationStatus && tc.validationStatus !== 'verified' && (tc.validationEvidence?.length ?? 0) > 0 && (
                <p className="mt-1 text-xs font-normal space-x-3">
                  {tc.validationEvidence!.map(url => (
                    <a key={url} href={url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">
                      {evidenceLabel(url)}
                    </a>
                  ))}
                </p>
              )}
            </td>
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
  );

  const statusBadge = (status: string) => {
    const map: Record<string, string> = {
      pass: 'bg-green-100 text-green-700',
      fail: 'bg-red-100 text-red-600',
      flaky: 'bg-amber-100 text-amber-800',
      running: 'bg-yellow-100 text-yellow-700',
      pending: 'bg-gray-100 text-gray-500',
    };
    const labels: Record<string, string> = {
      pass: 'ผ่าน', fail: 'ไม่ผ่าน', flaky: 'ไม่เสถียร', running: 'กำลังรัน', pending: 'รอดำเนินการ',
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
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">โปรเจค</h2>
          <button
            type="button"
            onClick={projectPages.refresh}
            disabled={projectPages.isLoading || !user}
            className="text-xs text-blue-600 hover:text-blue-800 disabled:opacity-40"
          >
            รีเฟรช
          </button>
        </div>
        {projectPages.error && (
          <p role="alert" className="text-xs text-red-600 break-words">{projectPages.error}</p>
        )}
        {projectPages.isLoading && sidebarProjects.length === 0 ? (
          <p className="text-xs text-gray-400">กำลังโหลด...</p>
        ) : sidebarProjects.length === 0 ? (
          <p className="text-xs text-gray-400">ยังไม่มีโปรเจค</p>
        ) : (
          sidebarProjects.map(p => (
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
        {(projectPages.hasPrevious || projectPages.hasNext) && (
          <div className="flex items-center justify-between border-t border-gray-100 pt-3 mt-3 text-xs">
            <button
              type="button"
              onClick={projectPages.previousPage}
              disabled={!projectPages.hasPrevious || projectPages.isLoading}
              className="rounded px-2 py-1 text-gray-600 hover:bg-gray-100 disabled:opacity-30"
            >
              ← ก่อนหน้า
            </button>
            <span className="text-gray-400">หน้า {projectPages.pageIndex + 1}</span>
            <button
              type="button"
              onClick={projectPages.nextPage}
              disabled={!projectPages.hasNext || projectPages.isLoading}
              className="rounded px-2 py-1 text-gray-600 hover:bg-gray-100 disabled:opacity-30"
            >
              ถัดไป →
            </button>
          </div>
        )}
      </aside>

      {/* Main */}
      <div className="flex-1 p-6 space-y-4 overflow-auto">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-800">คลังชุดทดสอบ</h1>
          <div className="flex items-center gap-2">
            <button
              onClick={handleDelete}
              disabled={selectedIds.length === 0 || isDeleting || isRunning || !user}
              className="border border-red-300 text-red-600 px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {isDeleting ? 'กำลังลบ...' : `🗑 ลบที่เลือก (${selectedIds.length})`}
            </button>
            <button
              onClick={handleExecute}
              disabled={selectedIds.length === 0 || isRunning || isDeleting}
              className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {isRunning ? 'กำลังสั่งรัน...' : `▶ รันที่เลือก (${selectedIds.length})`}
            </button>
          </div>
        </div>

        <section className="overflow-hidden rounded-xl border border-blue-200 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-blue-100 px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold text-gray-800">Test case ตาม Job</h2>
              <p className="mt-1 text-xs text-gray-500">รายการแสดงทุกเคสและสถานะ Script ของแต่ละเคส</p>
            </div>
            <button
              type="button"
              onClick={reloadGenerationJobs}
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
              const isCoverageExpanded = expandedCoverageJobIds.has(job.id);
              const coveragePanel = coverageByJobId[job.id];

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
                      {['awaiting_ac_review', 'awaiting_page_selection'].includes(job.status) && (
                        <Link
                          to={`/setup?jobId=${encodeURIComponent(job.id)}`}
                          className="rounded-md border border-amber-600 px-3 py-2 text-xs font-medium text-amber-800 hover:bg-amber-50"
                        >
                          ดำเนินการตรวจทานต่อ
                        </Link>
                      )}
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
                      <button
                        type="button"
                        onClick={() => toggleCoveragePanel(job.id)}
                        aria-expanded={isCoverageExpanded}
                        aria-controls={`${job.id}-coverage`}
                        disabled={!user}
                        className="rounded-md border border-teal-700 px-3 py-2 text-xs font-medium text-teal-800 hover:bg-teal-50 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {isCoverageExpanded ? 'ซ่อน Requirement Coverage' : 'Requirement Coverage'}
                      </button>
                    </div>
                  </div>
                  {isCoverageExpanded && (
                    <section
                      id={`${job.id}-coverage`}
                      aria-label="สรุป Requirement Coverage"
                      className="space-y-4 border-b border-teal-100 bg-teal-50/40 p-4"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <h3 className="text-sm font-semibold text-gray-900">สรุป Requirement Coverage</h3>
                          <p className="mt-1 text-xs text-gray-600">สถานะการทดสอบตาม Acceptance Criteria ของ Job นี้</p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {coveragePanel?.report && (
                            <button
                              type="button"
                              onClick={() => void handleExportCoverage(job.id)}
                              className="rounded-md bg-teal-700 px-3 py-2 text-xs font-medium text-white hover:bg-teal-800"
                            >
                              Export TESTS.md
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => void fetchCoverage(job.id)}
                            disabled={coveragePanel?.isLoading}
                            className="rounded-md border border-gray-300 bg-white px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-wait disabled:opacity-50"
                          >
                            {coveragePanel?.isLoading ? 'กำลังโหลด...' : 'โหลดใหม่'}
                          </button>
                        </div>
                      </div>
                      {coveragePanel?.isLoading && <p role="status" className="text-sm text-gray-600">กำลังโหลดข้อมูล Coverage...</p>}
                      {coveragePanel?.error && (
                        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                          {coveragePanel.error}
                        </p>
                      )}
                      {coverageExportErrors[job.id] && (
                        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                          {coverageExportErrors[job.id]}
                        </p>
                      )}
                      {coveragePanel?.report && (
                        <>
                          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
                            {coverageStates.map(state => (
                              <div key={state} className="rounded-lg border border-gray-200 bg-white px-3 py-2">
                                <dt className="text-xs text-gray-600">{coverageStateLabels[state]}</dt>
                                <dd className="mt-1 text-lg font-semibold tabular-nums text-gray-900">
                                  {coveragePanel.report?.totals[state] ?? 0}
                                </dd>
                              </div>
                            ))}
                          </dl>
                          <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
                            <table className="w-full min-w-[760px] text-left text-xs">
                              <thead className="bg-gray-50 text-gray-600">
                                <tr>
                                  <th className="px-3 py-2 font-semibold">Acceptance Criteria</th>
                                  <th className="px-3 py-2 font-semibold">ความสำคัญ</th>
                                  <th className="px-3 py-2 font-semibold">ผลที่คาดหวัง</th>
                                  <th className="px-3 py-2 font-semibold">สถานะ</th>
                                  <th className="px-3 py-2 font-semibold">เคสที่เชื่อมโยง</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-gray-100">
                                {coveragePanel.report.criteria.map(criterion => (
                                  <tr key={criterion.id} className="align-top">
                                    <td className="whitespace-nowrap px-3 py-2 font-medium text-gray-800">{criterion.id}</td>
                                    <td className="whitespace-nowrap px-3 py-2 text-gray-700">{criterion.priority}</td>
                                    <td className="min-w-52 px-3 py-2 text-gray-700">{criterion.expected}</td>
                                    <td className="whitespace-nowrap px-3 py-2">
                                      <span className={`inline-flex rounded-full px-2 py-1 font-medium ${coverageStateStyles[criterion.state]}`}>
                                        {coverageStateLabels[criterion.state]}
                                      </span>
                                    </td>
                                    <td className="min-w-44 px-3 py-2 text-gray-700">
                                      {criterion.linkedCases.length > 0
                                        ? criterion.linkedCases.map(testCase => (
                                          <span key={testCase.id} className="mb-1 mr-1 inline-flex rounded bg-gray-100 px-2 py-1">
                                            {testCase.title} ({testCase.lastStatus ?? testCase.status})
                                          </span>
                                        ))
                                        : 'ยังไม่มีเคสที่เชื่อมโยง'}
                                    </td>
                                  </tr>
                                ))}
                                {coveragePanel.report.criteria.length === 0 && (
                                  <tr>
                                    <td colSpan={5} className="px-3 py-4 text-center text-gray-500">Job นี้ไม่มี Acceptance Criteria</td>
                                  </tr>
                                )}
                              </tbody>
                            </table>
                          </div>
                          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
                            <h4 className="text-sm font-semibold text-amber-900">ข้อที่ควรยืนยันกับผู้ใช้</h4>
                            {coveragePanel.report.ambiguities.length > 0 ? (
                              <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-amber-900">
                                {coveragePanel.report.ambiguities.map(ambiguity => (
                                  <li key={ambiguity.acId}><span className="font-medium">{ambiguity.acId}:</span> {ambiguity.text}</li>
                                ))}
                              </ul>
                            ) : (
                              <p className="mt-2 text-sm text-amber-900">ไม่มีประเด็นที่ต้องยืนยัน</p>
                            )}
                          </div>
                        </>
                      )}
                    </section>
                  )}
                  {job.cases.length === 0 ? (
                    <p className="px-4 py-4 text-sm text-gray-500">Job นี้ยังไม่มี Test case ที่วางแผนไว้</p>
                  ) : (
                    <ol className="divide-y divide-gray-100">
                      {job.cases.map(testCase => {
                        const isEligible = (testCase.status === 'planned' || testCase.status === 'failed') && testCase.retryStatus !== 'running';
                        const isSelected = selectedPlanCaseIds.includes(`${job.id}:${testCase.id}`);
                        const detailsId = `${job.id}:${testCase.id}-details`;
                        const areDetailsExpanded = expandedTestCaseIds.has(detailsId);
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
                                <button
                                  type="button"
                                  onClick={() => setExpandedTestCaseIds(previous => {
                                    const next = new Set(previous);
                                    if (next.has(detailsId)) next.delete(detailsId);
                                    else next.add(detailsId);
                                    return next;
                                  })}
                                  aria-label={`${areDetailsExpanded ? 'ซ่อน' : 'แสดง'}ขั้นตอนและผลที่คาดหวัง: ${testCase.title}`}
                                  aria-expanded={areDetailsExpanded}
                                  aria-controls={detailsId}
                                  title={`${areDetailsExpanded ? 'ซ่อน' : 'แสดง'}ขั้นตอนและผลที่คาดหวัง`}
                                  className="inline-flex items-center text-gray-500 transition-colors hover:text-blue-700"
                                >
                                  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
                                    {areDetailsExpanded ? (
                                      <>
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18" />
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M10.6 10.6a2 2 0 002.8 2.8" />
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M9.9 5.2A10.7 10.7 0 0112 5c5 0 8.3 4.5 9 7-.2.8-.8 1.8-1.6 2.8M6.2 6.2C3.9 7.7 2.4 10 2 12c.5 2.5 4 7 10 7 1.2 0 2.3-.2 3.3-.6" />
                                      </>
                                    ) : (
                                      <>
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
                                        <circle cx="12" cy="12" r="3" />
                                      </>
                                    )}
                                  </svg>
                                </button>
                                <span className={`text-xs font-medium ${stateClass}`}>{stateLabel}</span>
                                <span className="text-xs text-gray-500">{testCase.type}</span>
                              </div>
                              {(testCase.category || (testCase.requirementIds?.length ?? 0) > 0) && (
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                  {testCase.category && (
                                    <span className="inline-flex rounded-full bg-teal-100 px-2 py-1 text-[11px] font-medium text-teal-800">
                                      {testPlanCategoryLabels[testCase.category] ?? testCase.category}
                                    </span>
                                  )}
                                  {testCase.requirementIds?.map(requirementId => (
                                    <span key={requirementId} className="inline-flex rounded-full bg-indigo-100 px-2 py-1 text-[11px] font-medium text-indigo-800">
                                      {requirementId}
                                    </span>
                                  ))}
                                </div>
                              )}
                              <p className="mt-1 text-xs text-gray-500">
                                {testCase.page}
                                {testCase.pageId ? ` · ${testCase.pageId}` : ''}
                              </p>
                              <p className="mt-2 text-sm text-gray-700">{testCase.description}</p>
                              <div id={detailsId} hidden={!areDetailsExpanded} className="mt-2">
                                {testCase.testSteps.length > 0 && (
                                  <ol className="list-inside list-decimal space-y-1 text-xs text-gray-600">
                                    {testCase.testSteps.map((step, index) => <li key={`${testCase.id}-step-${index}`}>{step}</li>)}
                                  </ol>
                                )}
                                <p className="mt-2 text-xs text-gray-600"><span className="font-medium">ผลที่คาดหวัง:</span> {testCase.expectedResult}</p>
                              </div>
                              {testCase.testCaseId && <p className="mt-1 text-xs text-gray-500">Test Script ID: {testCase.testCaseId}</p>}
                              {testCase.errorMessage && <p className="mt-1 text-xs text-red-700">{testCase.errorMessage}</p>}
                              {testCase.retryErrorMessage && <p className="mt-1 text-xs text-red-700">ลองใหม่ล่าสุดไม่สำเร็จ: {testCase.retryErrorMessage}</p>}
                            </div>
                            {isEligible && !isGenerating && planReady && (
                              <button
                                type="button"
                                onClick={() => handleGenerateJobScripts(job.id, [testCase.id])}
                                disabled={!user}
                                className="col-start-2 justify-self-start text-xs font-medium text-blue-700 hover:text-blue-900 disabled:opacity-50 sm:col-start-3 sm:self-center"
                              >
                                {testCase.status === 'failed' ? 'ลองสร้างใหม่' : 'สร้าง Script'}
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

        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          {mainCases.length === 0 ? (
            <div className="p-8 text-center text-gray-400 text-sm">
              {!activeProjectId
                ? 'กรุณาเลือกโปรเจค'
                : !areTestCasesLoaded
                  ? 'กำลังโหลดชุดทดสอบ...'
                  : reviewCases.length > 0 ? 'ยังไม่มีชุดทดสอบที่ยืนยันแล้ว ดูรายการที่ต้องตรวจสอบด้านล่าง' : 'ยังไม่มีชุดทดสอบในโปรเจคนี้'}
            </div>
          ) : renderCaseTable(mainCases)}
        </div>

        {reviewCases.length > 0 && (
          <section className="mt-4 bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
            <button
              type="button"
              onClick={() => setShowReviewCases(value => !value)}
              aria-expanded={showReviewCases}
              className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-50"
            >
              <span className="text-sm font-medium text-gray-700">
                ต้องตรวจสอบ ({reviewCases.length})
                <span className="ml-2 text-xs font-normal text-gray-400">ชุดทดสอบที่รันตรวจก่อนบันทึกแล้วยืนยันไม่ได้ พร้อมเหตุผล</span>
              </span>
              <span className="text-xs text-blue-600">{showReviewCases ? 'ซ่อน' : 'แสดง'}</span>
            </button>
            {showReviewCases && renderCaseTable(reviewCases)}
          </section>
        )}
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
