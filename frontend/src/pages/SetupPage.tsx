import { useEffect, useState, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

interface StepState {
  connecting: 'idle' | 'loading' | 'done' | 'error';
  reading: 'idle' | 'loading' | 'done' | 'error';
  fetching: 'idle' | 'loading' | 'done' | 'error';
  writing: 'idle' | 'loading' | 'done' | 'error';
}

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:4000';

const jobStageLabels: Record<string, string> = {
  analysis: 'วิเคราะห์ Requirement',
  discovery: 'กำลังสำรวจหน้าเว็บ',
  ac_review: 'ตรวจทาน Acceptance Criteria',
  page_selection: 'เลือกหน้าที่ต้องการทดสอบ',
  planning: 'กำลังวางแผนทดสอบ',
  script: 'กำลังสร้างสคริปต์ทดสอบ',
  completed: 'เสร็จสิ้น',
};

interface GeneratedJobTest {
  id?: string;
  title?: string;
  script?: string;
}

interface GenerationJobCase {
  id: string;
  sequence: number;
  title: string;
  page: string;
  pageId?: string;
  status: 'planned' | 'generating' | 'saved' | 'failed';
  testCaseId?: string;
  errorMessage?: string;
}

type AcceptanceCriterionCategory = 'happy_path' | 'validation' | 'negative' | 'boundary' | 'access_control';

interface AcceptanceCriterion {
  id: string;
  requirementRef: string;
  scenario: string;
  action: string;
  expected: string;
  mustNot: string;
  category: AcceptanceCriterionCategory;
  priority: 'required' | 'important' | 'optional';
  verification: 'automated' | 'manual';
  ambiguity: string;
  selectedByUser?: boolean;
  confirmedByUser?: boolean;
}

interface GenerationPage {
  pageId: string;
  title: string;
  urlPattern: string;
  sampleUrl: string;
  depth: number;
  requiresLogin: boolean;
  suggestedAcIds: string[];
}

interface GenerationJobDoc {
  status?: string;
  percentage?: number;
  stage?: string;
  message?: string;
  errorMessage?: string;
  caseCount?: number;
  completedCaseCount?: number;
  failedCaseCount?: number;
  snapshotCount?: number;
  processedSnapshotCount?: number;
  pageCount?: number;
  pageDiscoveryComplete?: boolean;
  pageDiscoveryStopReason?: string;
  coverageComplete?: boolean;
  coverageStopReason?: string;
  primaryGeneratedTest?: GeneratedJobTest;
  cases?: GenerationJobCase[];
  caseCursor?: string;
}

interface AcceptanceCriteriaReview {
  criteria: AcceptanceCriterion[];
  analysisWarnings?: string[];
  requirementUnitCount?: number;
}

export default function SetupPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const [url, setUrl] = useState('https://example.com');
  const [requirementsText, setRequirementsText] = useState('');
  const [allowMutatingTests, setAllowMutatingTests] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedCode, setGeneratedCode] = useState('');
  const [projectName, setProjectName] = useState('');
  const [jobId, setJobId] = useState(() => searchParams.get('jobId') ?? '');
  const [jobStatus, setJobStatus] = useState('');
  const [jobPercentage, setJobPercentage] = useState(0);
  const [jobMessage, setJobMessage] = useState('');
  const [jobError, setJobError] = useState('');
  const [jobStage, setJobStage] = useState('');
  const [jobCaseCount, setJobCaseCount] = useState(0);
  const [jobCompletedCaseCount, setJobCompletedCaseCount] = useState(0);
  const [jobFailedCaseCount, setJobFailedCaseCount] = useState(0);
  const [jobSnapshotCount, setJobSnapshotCount] = useState(0);
  const [jobProcessedSnapshotCount, setJobProcessedSnapshotCount] = useState(0);
  const [coverageComplete, setCoverageComplete] = useState(false);
  const [coverageStopReason, setCoverageStopReason] = useState('');
  const [jobCases, setJobCases] = useState<GenerationJobCase[]>([]);
  const [acceptanceCriteria, setAcceptanceCriteria] = useState<AcceptanceCriterion[]>([]);
  const [analysisWarnings, setAnalysisWarnings] = useState<string[]>([]);
  const [requirementUnitCount, setRequirementUnitCount] = useState<number | null>(null);
  const [generationPages, setGenerationPages] = useState<GenerationPage[]>([]);
  const [pageDiscoveryComplete, setPageDiscoveryComplete] = useState(true);
  const [pageDiscoveryStopReason, setPageDiscoveryStopReason] = useState('');
  const [selectedPageIds, setSelectedPageIds] = useState<string[]>([]);
  const [workflowError, setWorkflowError] = useState('');
  const [isWorkflowSubmitting, setIsWorkflowSubmitting] = useState(false);
  const [coverageWarnings, setCoverageWarnings] = useState<string[]>([]);
  const [warningConfirmationRequired, setWarningConfirmationRequired] = useState(false);
  const [steps, setSteps] = useState<StepState>({
    connecting: 'idle', reading: 'idle', fetching: 'idle', writing: 'idle',
  });
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string>('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const saveGeneratedArtifact = async (generated: {
    title?: string;
    type?: 'UI' | 'API';
    criteria?: string[];
    script?: string;
  }) => {
    const res = await fetch(`${BACKEND_URL}/api/save-generated`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        projectName: projectName || url,
        url,
        generated: {
          title: generated.title,
          type: generated.type,
          criteria: generated.criteria ?? [],
          script: generated.script,
        },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || 'save-generated failed');
    }

    return res.json() as Promise<{ id: string }>;
  };

  const handleFileAdd = (newFiles: FileList | null) => {
    if (!newFiles) return;
    const valid = Array.from(newFiles).filter(f => f.name.endsWith('.md') || f.name.endsWith('.txt'));
    setFiles(prev => [...prev, ...valid]);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    handleFileAdd(e.dataTransfer.files);
  };

  const setStep = (step: keyof StepState, status: 'loading' | 'done' | 'error') => {
    setSteps(prev => ({ ...prev, [step]: status }));
  };

  const handleGenerate = async () => {
    if (!user) {
      alert('กรุณาเข้าสู่ระบบก่อนสร้างชุดทดสอบ');
      return;
    }

    if (!url) {
      alert('กรุณากรอก URL ของระบบที่ต้องการทดสอบ');
      return;
    }

    setIsGenerating(true);
    setGeneratedCode('');
    setSaveStatus('');
    setJobId('');
    setSearchParams(params => {
      params.delete('jobId');
      return params;
    }, { replace: true });
    setJobStatus('');
    setJobPercentage(0);
    setJobMessage('');
    setJobError('');
    setJobStage('');
    setJobCaseCount(0);
    setJobCompletedCaseCount(0);
    setJobFailedCaseCount(0);
    setJobSnapshotCount(0);
    setJobProcessedSnapshotCount(0);
    setCoverageComplete(false);
    setCoverageStopReason('');
    setJobCases([]);
    setAcceptanceCriteria([]);
    setAnalysisWarnings([]);
    setRequirementUnitCount(null);
    setGenerationPages([]);
    setPageDiscoveryComplete(true);
    setPageDiscoveryStopReason('');
    setSelectedPageIds([]);
    setWorkflowError('');
    setCoverageWarnings([]);
    setWarningConfirmationRequired(false);
    setSteps({ connecting: 'loading', reading: 'idle', fetching: 'idle', writing: 'idle' });

    try {
      const formData = new FormData();
      formData.append('url', url);
      formData.append('projectName', projectName || url);
      formData.append('requirements', requirementsText.trim());
      formData.append('allowMutatingTests', String(allowMutatingTests));
      formData.append('humanReview', 'true');
      files.forEach(f => formData.append('files', f));
      const idToken = await user.getIdToken();

      setStep('connecting', 'done');
      setStep('reading', 'done');
      setStep('fetching', 'loading');

      const res = await fetch(`${BACKEND_URL}/api/v2/generate-job`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${idToken}`,
        },
        body: formData,
      });

      setStep('fetching', 'done');

      if (!res.ok) {
        throw new Error(await res.text());
      }

      const data = await res.json();
      setJobId(data.jobId);
      setSearchParams(params => {
        params.set('jobId', data.jobId);
        return params;
      }, { replace: true });
      setJobStatus(data.status ?? 'pending');
      setJobMessage('Job accepted and running in background');

      setStep('writing', 'loading');
    } catch (err) {
      console.error(err);
      setStep('fetching', 'error');
      const message = err instanceof Error ? err.message : String(err);
      alert(`เกิดข้อผิดพลาดระหว่างส่งงาน: ${message}`);
    } finally {
      setIsGenerating(false);
    }
  };

  useEffect(() => {
    if (!jobId || !user) return;

    let cancelled = false;
    let timeoutId: number | undefined;
    let caseCursor: string | undefined;
    let primaryScriptLoaded = false;
    const casesById = new Map<string, GenerationJobCase>();
    const pollJob = async () => {
      try {
        const idToken = await user.getIdToken();
        const params = new URLSearchParams();
        if (caseCursor) params.set('since', caseCursor);
        if (primaryScriptLoaded) params.set('includePrimaryScript', 'false');
        const query = params.size > 0 ? `?${params.toString()}` : '';
        const response = await fetch(`${BACKEND_URL}/api/v2/generation-jobs/${jobId}${query}`, {
          headers: { Authorization: `Bearer ${idToken}` },
        });
        if (!response.ok) throw new Error(await response.text());
        const data = await response.json() as GenerationJobDoc;
        if (cancelled) return;

        setJobStatus(data.status ?? 'pending');
        setJobPercentage(data.percentage ?? 0);
        setJobStage(data.stage ?? '');
        setJobMessage(data.message ?? '');
        setJobError(data.errorMessage ?? '');
        setJobCaseCount(data.caseCount ?? 0);
        setJobCompletedCaseCount(data.completedCaseCount ?? 0);
        setJobFailedCaseCount(data.failedCaseCount ?? 0);
        setJobSnapshotCount(data.snapshotCount ?? 0);
        setJobProcessedSnapshotCount(data.processedSnapshotCount ?? 0);
        setCoverageComplete(data.coverageComplete ?? false);
        setCoverageStopReason(data.coverageStopReason ?? '');
        for (const jobCase of data.cases ?? []) casesById.set(jobCase.id, jobCase);
        caseCursor = data.caseCursor ?? caseCursor;
        setJobCases(Array.from(casesById.values()).sort((left, right) => left.sequence - right.sequence));

        const primaryScript = data.primaryGeneratedTest?.script;
        if (primaryScript) {
          primaryScriptLoaded = true;
          setGeneratedCode(primaryScript);
        }

        if (data.status === 'completed') {
          setStep('writing', 'done');
        } else if (data.status === 'failed' || data.status === 'incomplete') {
          setStep('writing', 'error');
        } else {
          timeoutId = window.setTimeout(() => void pollJob(), 5000);
        }
      } catch (error) {
        if (cancelled) return;
        setJobError(error instanceof Error ? error.message : String(error));
        timeoutId = window.setTimeout(() => void pollJob(), 5000);
      }
    };

    void pollJob();
    return () => {
      cancelled = true;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [jobId, user]);

  useEffect(() => {
    if (!jobId || !user || !['awaiting_ac_review', 'awaiting_page_selection'].includes(jobStatus)) return;

    let cancelled = false;
    const loadReviewData = async () => {
      try {
        const idToken = await user.getIdToken();
        const headers = { Authorization: `Bearer ${idToken}` };
        if (jobStatus === 'awaiting_ac_review') {
          const response = await fetch(`${BACKEND_URL}/api/v2/generation-jobs/${jobId}/acceptance-criteria`, { headers });
          if (!response.ok) throw new Error(await response.text());
          const data = await response.json() as AcceptanceCriteriaReview;
          if (!cancelled) {
            setAcceptanceCriteria(data.criteria.map(criterion => ({
              ...criterion,
              selectedByUser: criterion.selectedByUser ?? true,
            })));
            setAnalysisWarnings(data.analysisWarnings ?? []);
            setRequirementUnitCount(data.requirementUnitCount ?? null);
          }
        } else {
          const [criteriaResponse, pagesResponse] = await Promise.all([
            fetch(`${BACKEND_URL}/api/v2/generation-jobs/${jobId}/acceptance-criteria`, { headers }),
            fetch(`${BACKEND_URL}/api/v2/generation-jobs/${jobId}/pages`, { headers }),
          ]);
          if (!criteriaResponse.ok) throw new Error(await criteriaResponse.text());
          if (!pagesResponse.ok) throw new Error(await pagesResponse.text());
          const criteriaData = await criteriaResponse.json() as AcceptanceCriteriaReview;
          const data = await pagesResponse.json() as { pages: GenerationPage[]; complete?: boolean; stopReason?: string };
          if (!cancelled) {
            setAcceptanceCriteria(criteriaData.criteria);
            setAnalysisWarnings(criteriaData.analysisWarnings ?? []);
            setRequirementUnitCount(criteriaData.requirementUnitCount ?? null);
            setGenerationPages(data.pages);
            setPageDiscoveryComplete(data.complete ?? true);
            setPageDiscoveryStopReason(data.stopReason ?? '');
            const suggestedIds = data.pages
              .filter(page => page.suggestedAcIds.length > 0)
              .map(page => page.pageId);
            setSelectedPageIds(suggestedIds.length > 0
              ? suggestedIds
              : data.pages.filter(page => page.depth === 0).map(page => page.pageId));
          }
        }
      } catch (error) {
        if (!cancelled) setWorkflowError(error instanceof Error ? error.message : String(error));
      }
    };

    void loadReviewData();
    return () => { cancelled = true; };
  }, [jobId, user, jobStatus]);

  const updateAcceptanceCriterion = <K extends keyof AcceptanceCriterion>(
    criterionId: string,
    key: K,
    value: AcceptanceCriterion[K],
  ) => {
    setAcceptanceCriteria(criteria => criteria.map(criterion => criterion.id === criterionId
      ? { ...criterion, [key]: value }
      : criterion));
  };

  const handleAddAcceptanceCriterion = () => {
    const id = `AC-USER-${Date.now()}`;
    setAcceptanceCriteria(criteria => [...criteria, {
      id,
      requirementRef: 'ผู้ใช้เพิ่ม',
      scenario: '',
      action: '',
      expected: '',
      mustNot: '',
      category: 'happy_path',
      priority: 'required',
      verification: 'automated',
      ambiguity: '',
      selectedByUser: true,
    }]);
  };

  const handleConfirmAcceptanceCriteria = async () => {
    if (!user || !jobId) return;
    setIsWorkflowSubmitting(true);
    setWorkflowError('');
    try {
      const idToken = await user.getIdToken();
      const headers = { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' };
      const saveResponse = await fetch(`${BACKEND_URL}/api/v2/generation-jobs/${jobId}/acceptance-criteria`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ criteria: acceptanceCriteria }),
      });
      if (!saveResponse.ok) throw new Error(await saveResponse.text());
      const confirmResponse = await fetch(`${BACKEND_URL}/api/v2/generation-jobs/${jobId}/acceptance-criteria/confirm`, {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      });
      if (!confirmResponse.ok) throw new Error(await confirmResponse.text());
      setAcceptanceCriteria(acceptanceCriteria
        .filter(criterion => criterion.selectedByUser !== false)
        .map(criterion => ({ ...criterion, selectedByUser: true, confirmedByUser: true })));
      setJobStatus('running');
      setJobMessage('ยืนยัน Acceptance Criteria แล้ว กำลังค้นหาหน้าเว็บ');
    } catch (error) {
      setWorkflowError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsWorkflowSubmitting(false);
    }
  };

  const handleConfirmPageSelection = async () => {
    if (!user || !jobId || selectedPageIds.length === 0) return;
    setIsWorkflowSubmitting(true);
    setWorkflowError('');
    try {
      const idToken = await user.getIdToken();
      const response = await fetch(`${BACKEND_URL}/api/v2/generation-jobs/${jobId}/pages/confirm`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pageIds: selectedPageIds,
          confirmCoverageWarnings: warningConfirmationRequired,
        }),
      });
      if (!response.ok) throw new Error(await response.text());
      const data = await response.json() as { confirmed: boolean; warnings?: string[] };
      if (!data.confirmed) {
        setCoverageWarnings(data.warnings ?? []);
        setWarningConfirmationRequired(true);
        return;
      }
      setCoverageWarnings(data.warnings ?? []);
      setWarningConfirmationRequired(false);
      setJobStatus('running');
      setJobMessage('ยืนยันหน้าที่เลือกแล้ว กำลังสำรวจเชิงลึกและออกแบบ Test case');
    } catch (error) {
      setWorkflowError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsWorkflowSubmitting(false);
    }
  };

  const handlePageSelectionChange = (pageId: string, selected: boolean) => {
    setSelectedPageIds(current => selected
      ? [...new Set([...current, pageId])]
      : current.filter(id => id !== pageId));
    setCoverageWarnings([]);
    setWarningConfirmationRequired(false);
  };

  const unsupportedAcceptanceCriteria = acceptanceCriteria.filter(criterion =>
    !generationPages.some(page => selectedPageIds.includes(page.pageId) && page.suggestedAcIds.includes(criterion.id)));

  const handleSave = async () => {
    if (!generatedCode) return;
    setIsSaving(true);
    try {
      await saveGeneratedArtifact({
        title: `Generated test - ${projectName || url}`,
        type: 'UI',
        criteria: [],
        script: generatedCode,
      });
      alert('บันทึกลงฐานข้อมูลเรียบร้อยแล้ว!');
      setSaveStatus('บันทึก Test Case ลงระบบเรียบร้อยแล้ว');
      navigate('/test-cases');
    } catch (err) {
      console.error(err);
      alert('เกิดข้อผิดพลาดในการบันทึก');
    } finally {
      setIsSaving(false);
    }
  };

  const handleCopyCode = async () => {
    if (!generatedCode) return;

    try {
      await navigator.clipboard.writeText(generatedCode);
      alert('คัดลอกโค้ดเรียบร้อยแล้ว');
    } catch (err) {
      console.error(err);
      alert('ไม่สามารถคัดลอกโค้ดได้');
    }
  };

  const handleDownloadCode = () => {
    if (!generatedCode) return;

    const fileName = `${(projectName || 'generated-test').replace(/\s+/g, '-').toLowerCase()}.spec.ts`;
    const blob = new Blob([generatedCode], { type: 'text/plain;charset=utf-8' });
    const urlObject = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = urlObject;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(urlObject);
  };

  const stepItems: { key: keyof StepState; label: string }[] = [
    { key: 'connecting', label: 'Connecting to Target Website' },
        { key: 'reading', label: 'Reading Context Specification File(s) (Optional)' },
    { key: 'fetching', label: 'Fetching Accessibility Snapshot via MCP' },
    { key: 'writing', label: 'Planning Test Cases from Snapshots' },
  ];

  const stepIcon = (status: string) => {
    if (status === 'done') return <span className="text-green-500">✓</span>;
    if (status === 'loading') return <span className="animate-spin inline-block">⟳</span>;
    if (status === 'error') return <span className="text-red-500">✗</span>;
    return <span className="text-gray-300">○</span>;
  };

  const jobStatusLabel: Record<string, string> = {
    pending: 'รอเริ่มทำงาน',
    running: 'กำลังประมวลผล',
    awaiting_ac_review: 'รอตรวจทาน Acceptance Criteria',
    awaiting_page_selection: 'รอเลือกหน้าทดสอบ',
    completed: 'เสร็จสมบูรณ์',
    incomplete: 'เสร็จบางส่วน',
    failed: 'ทำงานไม่สำเร็จ',
  };
  const jobStatusClass = jobStatus === 'completed'
    ? 'bg-green-100 text-green-800'
    : jobStatus === 'incomplete'
      ? 'bg-amber-100 text-amber-800'
      : jobStatus === 'failed'
        ? 'bg-red-100 text-red-800'
        : jobStatus.startsWith('awaiting_')
          ? 'bg-amber-100 text-amber-800'
          : 'bg-blue-100 text-blue-800';
  const displayedStageLabel = jobStatus === 'awaiting_ac_review'
    ? 'ตรวจทานและยืนยัน Acceptance Criteria'
    : jobStatus === 'awaiting_page_selection'
      ? 'เลือกหน้าที่ต้องการทดสอบ'
      : jobStageLabels[jobStage] ?? (jobStage || 'กำลังรอการประมวลผล');
  const workflowStepLabels = ['สร้าง Acceptance Criteria', 'ตรวจทานและแก้ไข AC', 'เลือกหน้าเว็บ', 'ออกแบบ Test case', 'เสร็จสิ้น'];
  const activeWorkflowStep = jobStatus === 'awaiting_ac_review'
    ? 1
    : jobStatus === 'awaiting_page_selection' || (jobStatus === 'running' && jobStage === 'discovery')
      ? 2
      : jobStatus === 'completed' || jobStatus === 'incomplete' || jobStatus === 'failed'
        ? 4
        : jobStage === 'planning' || jobStage === 'script'
          ? 3
          : 0;

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-gray-800">ตั้งค่าโปรเจคและสร้างชุดทดสอบ</h1>

      {/* Project Name */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 space-y-3">
        <label className="block text-sm font-medium text-gray-700">ชื่อโปรเจค</label>
        <input
          type="text"
          value={projectName}
          onChange={e => setProjectName(e.target.value)}
          placeholder="เช่น My Web App"
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {/* URL Input */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 space-y-3">
        <label className="block text-sm font-medium text-gray-700">URL ระบบที่ต้องการทดสอบ</label>
        <input
          type="url"
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="https://example.com"
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 space-y-3">
        <label className="block text-sm font-medium text-gray-700">Context / Requirements</label>
        <textarea
          value={requirementsText}
          onChange={e => setRequirementsText(e.target.value)}
          rows={6}
          placeholder="ระบุเงื่อนไขทดสอบ, flow สำคัญ, ข้อมูลทดสอบ หรือข้อกำหนดที่ต้องการให้ระบบสร้างเคส"
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <label className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
        <input
          type="checkbox"
          checked={allowMutatingTests}
          onChange={event => setAllowMutatingTests(event.target.checked)}
          className="mt-0.5 rounded border-amber-400 text-amber-700 focus:ring-amber-600"
        />
        <span>
          <span className="block font-medium">เว็บเป้าหมายเป็นสภาพแวดล้อมทดสอบ (อนุญาตให้ทดสอบขั้นตอนที่เปลี่ยนข้อมูล)</span>
          <span className="mt-1 block text-xs text-amber-800">หากไม่เลือก ระบบจะหยุดที่หน้าสุดท้ายก่อนยืนยันการซื้อ ชำระเงิน ลบข้อมูล หรือเปลี่ยนบัญชี</span>
        </span>
      </label>

      {/* File Uploader */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 space-y-3">
        <label className="block text-sm font-medium text-gray-700">อัปโหลดไฟล์ความต้องการ (.md / .txt) (ไม่บังคับ)</label>
        <div
          onDrop={handleDrop}
          onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onClick={() => fileInputRef.current?.click()}
          className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
            isDragging ? 'border-blue-400 bg-blue-50' : 'border-gray-300 hover:border-blue-400 hover:bg-gray-50'
          }`}
        >
          <p className="text-gray-500 text-sm">ลากวางไฟล์หรือคลิกเพื่อเลือกไฟล์</p>
          <p className="text-gray-400 text-xs mt-1">รองรับเฉพาะไฟล์ .md และ .txt</p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".md,.txt"
            multiple
            className="hidden"
            onChange={e => handleFileAdd(e.target.files)}
          />
        </div>

        {/* File List */}
        {files.length > 0 && (
          <ul className="space-y-2 mt-2">
            {files.map((f, i) => (
              <li key={i} className="flex items-center justify-between bg-gray-50 px-3 py-2 rounded-lg text-sm">
                <span className="text-gray-700 truncate">{f.name}</span>
                <button
                  onClick={() => setFiles(prev => prev.filter((_, idx) => idx !== i))}
                  className="text-red-400 hover:text-red-600 ml-2 flex-shrink-0"
                  title="ลบไฟล์"
                >
                  🗑
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Generate Button */}
      <button
        onClick={handleGenerate}
        disabled={isGenerating}
        className="w-full bg-blue-600 text-white py-3 rounded-xl font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {isGenerating ? 'กำลังประมวลผล...' : '🚀 สร้างชุดทดสอบ (Generate Test Cases)'}
      </button>

      {jobId && (
        <section aria-live="polite" className="overflow-hidden rounded-xl border border-blue-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-blue-100 bg-blue-50/70 px-5 py-4">
            <div>
              <h2 className="text-base font-semibold text-gray-900">ติดตามการสร้างชุดทดสอบ</h2>
              <p className="mt-1 break-all text-xs text-gray-500">Job ID: {jobId}</p>
            </div>
            <span className={`rounded-full px-3 py-1 text-xs font-semibold ${jobStatusClass}`}>
              {jobStatusLabel[jobStatus] ?? 'กำลังเชื่อมต่อสถานะ'}
            </span>
          </div>
          <div className="space-y-4 p-5">
            <ol className="grid gap-2 sm:grid-cols-5">
              {workflowStepLabels.map((label, index) => {
                const isDone = index < activeWorkflowStep || (index === 4 && jobStatus === 'completed');
                const isActive = index === activeWorkflowStep && jobStatus !== 'completed';
                return (
                  <li
                    key={label}
                    className={`rounded-md border px-3 py-2 text-xs ${
                      isDone ? 'border-green-200 bg-green-50 text-green-800'
                        : isActive ? 'border-blue-300 bg-blue-50 font-semibold text-blue-800'
                          : 'border-gray-200 bg-gray-50 text-gray-500'
                    }`}
                  >
                    {index + 1}. {label}
                  </li>
                );
              })}
            </ol>
            <div>
              <div className="mb-2 flex items-center justify-between gap-3 text-sm">
                <span className="font-medium text-gray-700">{displayedStageLabel}</span>
                <span className="font-semibold tabular-nums text-blue-800">{Math.min(jobPercentage, 100)}%</span>
              </div>
              <div
                className="h-2.5 overflow-hidden rounded-full bg-gray-100"
                role="progressbar"
                aria-label="ความคืบหน้าการสร้างชุดทดสอบ"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.min(jobPercentage, 100)}
              >
                <div className="h-full rounded-full bg-blue-600 transition-[width] duration-500" style={{ width: `${Math.min(jobPercentage, 100)}%` }} />
              </div>
              <p className="mt-2 text-sm text-gray-600">{jobMessage || 'กำลังรอการประมวลผล'}</p>
            </div>
            {workflowError && <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{workflowError}</p>}
            {jobStatus === 'awaiting_ac_review' && (
              <section className="space-y-4 rounded-lg border border-amber-200 bg-amber-50/60 p-4">
                <div>
                  <h3 className="font-semibold text-gray-900">ขั้นที่ 2: ตรวจทาน Acceptance Criteria</h3>
                  <p className="mt-1 text-sm text-gray-600">แก้ไข เพิ่ม ลบ หรือเลือกข้อกำหนดที่ต้องการใช้ก่อนให้ AI สำรวจเว็บไซต์</p>
                </div>
                {requirementUnitCount !== null && (
                  <p className="text-sm text-gray-700">
                    ระบบอ่าน Requirement ได้ {requirementUnitCount} ข้อ และสร้าง Acceptance Criteria ได้ {acceptanceCriteria.length} ข้อ
                  </p>
                )}
                {analysisWarnings.length > 0 && (
                  <div role="status" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                    <p className="font-medium">มีปัญหาระหว่างวิเคราะห์ Requirement:</p>
                    <ul className="mt-1 list-inside list-disc space-y-1">
                      {analysisWarnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}
                    </ul>
                  </div>
                )}
                {requirementUnitCount === 0 && (
                  <p role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
                    ระบบไม่พบข้อกำหนดในข้อมูลที่ส่งมา กรุณาตรวจสอบข้อความหรือเพิ่ม Acceptance Criteria ด้วยตนเอง
                  </p>
                )}
                {requirementUnitCount !== null && requirementUnitCount > 0 && acceptanceCriteria.length === 0 && analysisWarnings.length === 0 && (
                  <p role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
                    AI ไม่ได้ส่ง Acceptance Criteria ที่ระบบตรวจสอบรูปแบบได้ จึงไม่มีรายการให้แสดง กรุณาเพิ่ม Acceptance Criteria ด้วยตนเอง
                  </p>
                )}
                <div className="space-y-3">
                  {acceptanceCriteria.map(criterion => (
                    <article key={criterion.id} className="space-y-3 rounded-lg border border-gray-200 bg-white p-4">
                      <div className="flex items-start justify-between gap-3">
                        <label className="flex items-center gap-2 text-sm font-medium text-gray-800">
                          <input
                            type="checkbox"
                            checked={criterion.selectedByUser !== false}
                            onChange={event => updateAcceptanceCriterion(criterion.id, 'selectedByUser', event.target.checked)}
                          />
                          ใช้ {criterion.id}
                        </label>
                        <button
                          type="button"
                          onClick={() => setAcceptanceCriteria(criteria => criteria.filter(item => item.id !== criterion.id))}
                          className="text-sm text-red-600 hover:text-red-800"
                        >
                          ลบ
                        </button>
                      </div>
                      <label className="block text-xs font-medium text-gray-600">
                        อ้างอิง Requirement
                        <input
                          value={criterion.requirementRef}
                          onChange={event => updateAcceptanceCriterion(criterion.id, 'requirementRef', event.target.value)}
                          className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                        />
                      </label>
                      <label className="block text-xs font-medium text-gray-600">
                        สถานการณ์
                        <textarea
                          value={criterion.scenario}
                          onChange={event => updateAcceptanceCriterion(criterion.id, 'scenario', event.target.value)}
                          rows={2}
                          className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                        />
                      </label>
                      <label className="block text-xs font-medium text-gray-600">
                        การกระทำ
                        <textarea
                          value={criterion.action}
                          onChange={event => updateAcceptanceCriterion(criterion.id, 'action', event.target.value)}
                          rows={2}
                          className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                        />
                      </label>
                      <label className="block text-xs font-medium text-gray-600">
                        ผลลัพธ์ที่คาดหวัง
                        <textarea
                          value={criterion.expected}
                          onChange={event => updateAcceptanceCriterion(criterion.id, 'expected', event.target.value)}
                          rows={2}
                          className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                        />
                      </label>
                      <label className="block text-xs font-medium text-gray-600">
                        สิ่งที่ต้องไม่เกิด
                        <input
                          value={criterion.mustNot}
                          onChange={event => updateAcceptanceCriterion(criterion.id, 'mustNot', event.target.value)}
                          className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                        />
                      </label>
                      <label className="block text-xs font-medium text-gray-600">
                        ความกำกวม/หมายเหตุ
                        <input
                          value={criterion.ambiguity}
                          onChange={event => updateAcceptanceCriterion(criterion.id, 'ambiguity', event.target.value)}
                          className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                        />
                      </label>
                      <div className="grid gap-3 sm:grid-cols-3">
                        <label className="text-xs font-medium text-gray-600">
                          ประเภท
                          <select
                            value={criterion.category}
                            onChange={event => updateAcceptanceCriterion(criterion.id, 'category', event.target.value as AcceptanceCriterionCategory)}
                            className="mt-1 w-full rounded-md border border-gray-300 px-2 py-2 text-sm"
                          >
                            <option value="happy_path">เส้นทางปกติ</option>
                            <option value="validation">ตรวจสอบข้อมูล</option>
                            <option value="negative">กรณีไม่สำเร็จ</option>
                            <option value="boundary">ขอบเขตข้อมูล</option>
                            <option value="access_control">สิทธิ์การเข้าถึง</option>
                          </select>
                        </label>
                        <label className="text-xs font-medium text-gray-600">
                          ความสำคัญ
                          <select
                            value={criterion.priority}
                            onChange={event => updateAcceptanceCriterion(criterion.id, 'priority', event.target.value as AcceptanceCriterion['priority'])}
                            className="mt-1 w-full rounded-md border border-gray-300 px-2 py-2 text-sm"
                          >
                            <option value="required">จำเป็น</option>
                            <option value="important">สำคัญ</option>
                            <option value="optional">ไม่บังคับ</option>
                          </select>
                        </label>
                        <label className="text-xs font-medium text-gray-600">
                          วิธีตรวจ
                          <select
                            value={criterion.verification}
                            onChange={event => updateAcceptanceCriterion(criterion.id, 'verification', event.target.value as AcceptanceCriterion['verification'])}
                            className="mt-1 w-full rounded-md border border-gray-300 px-2 py-2 text-sm"
                          >
                            <option value="automated">อัตโนมัติ</option>
                            <option value="manual">ตรวจด้วยตนเอง</option>
                          </select>
                        </label>
                      </div>
                    </article>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={handleAddAcceptanceCriterion} className="rounded-md border border-blue-600 px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50">
                    เพิ่ม Acceptance Criteria
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleConfirmAcceptanceCriteria()}
                    disabled={isWorkflowSubmitting || !acceptanceCriteria.some(criterion => criterion.selectedByUser !== false)}
                    className="rounded-md bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50"
                  >
                    {isWorkflowSubmitting ? 'กำลังบันทึก...' : 'ยืนยัน AC และค้นหาหน้าเว็บ'}
                  </button>
                </div>
              </section>
            )}
            {jobStatus === 'awaiting_page_selection' && (
              <section className="space-y-4 rounded-lg border border-blue-200 bg-blue-50/50 p-4">
                <div>
                  <h3 className="font-semibold text-gray-900">ขั้นที่ 3: เลือกหน้าที่ต้องการทดสอบ</h3>
                  <p className="mt-1 text-sm text-gray-600">เลือกหน้าที่ตรงกับ Acceptance Criteria ระบบจะสำรวจเชิงลึกเฉพาะหน้าที่เลือก</p>
                </div>
                {!pageDiscoveryComplete && (
                  <p role="status" className="rounded-md bg-amber-100 px-3 py-2 text-sm text-amber-900">
                    สำรวจหน้าได้บางส่วน: {pageDiscoveryStopReason || `จำกัดไว้ที่ ${generationPages.length} หน้า`}
                  </p>
                )}
                {unsupportedAcceptanceCriteria.length > 0 && (
                  <p role="alert" className="rounded-md bg-amber-100 px-3 py-2 text-sm text-amber-900">
                    หน้าที่เลือกยังไม่รองรับ: {unsupportedAcceptanceCriteria.map(criterion => criterion.id).join(', ')}. เลือกหน้าเพิ่มหรือยืนยันเพื่อดำเนินการต่อโดยรับทราบคำเตือน
                  </p>
                )}
                {coverageWarnings.length > 0 && warningConfirmationRequired && (
                  <p role="alert" className="rounded-md bg-amber-100 px-3 py-2 text-sm text-amber-900">
                    คำเตือน: AC {coverageWarnings.join(', ')} ไม่มีหน้าที่เลือกแนะนำให้รองรับ กดปุ่มยืนยันอีกครั้งหากต้องการดำเนินการต่อ
                  </p>
                )}
                {generationPages.length === 0 ? (
                  <p className="text-sm text-gray-600">ไม่พบหน้าที่เลือกได้</p>
                ) : (
                  <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
                    <table className="min-w-full divide-y divide-gray-200 text-left text-sm">
                      <thead className="bg-gray-50 text-xs font-semibold uppercase text-gray-600">
                        <tr>
                          <th className="px-3 py-3">เลือก</th>
                          <th className="px-3 py-3">ชื่อหน้า</th>
                          <th className="px-3 py-3">URL pattern</th>
                          <th className="px-3 py-3">ล็อกอิน</th>
                          <th className="px-3 py-3">AC ที่เกี่ยวข้อง</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {generationPages.map(page => (
                          <tr key={page.pageId}>
                            <td className="px-3 py-3">
                              <input
                                type="checkbox"
                                aria-label={`เลือกหน้า ${page.title}`}
                                checked={selectedPageIds.includes(page.pageId)}
                                onChange={event => handlePageSelectionChange(page.pageId, event.target.checked)}
                              />
                            </td>
                            <td className="px-3 py-3 font-medium text-gray-800">{page.title}</td>
                            <td className="max-w-sm break-all px-3 py-3 text-xs text-gray-600">{page.urlPattern}</td>
                            <td className="px-3 py-3">{page.requiresLogin ? 'ต้องล็อกอิน' : 'ไม่ต้องล็อกอิน'}</td>
                            <td className="px-3 py-3">{page.suggestedAcIds.length > 0 ? page.suggestedAcIds.join(', ') : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => void handleConfirmPageSelection()}
                  disabled={isWorkflowSubmitting || selectedPageIds.length === 0}
                  className="rounded-md bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50"
                >
                  {isWorkflowSubmitting
                    ? 'กำลังเริ่มสำรวจ...'
                    : warningConfirmationRequired ? 'รับทราบคำเตือนและเริ่ม' : 'ยืนยันหน้าที่เลือกและเริ่มออกแบบ'}
                </button>
              </section>
            )}
            <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-gray-200 bg-gray-200 sm:grid-cols-4">
              <div className="bg-white px-3 py-3">
                <dt className="text-xs text-gray-500">Test case</dt>
                <dd className="mt-1 text-lg font-semibold tabular-nums text-gray-900">{jobCaseCount}</dd>
              </div>
              <div className="bg-white px-3 py-3">
                <dt className="text-xs text-gray-500">สำเร็จ</dt>
                <dd className="mt-1 text-lg font-semibold tabular-nums text-green-700">{jobCompletedCaseCount}</dd>
              </div>
              <div className="bg-white px-3 py-3">
                <dt className="text-xs text-gray-500">ไม่สำเร็จ</dt>
                <dd className="mt-1 text-lg font-semibold tabular-nums text-red-700">{jobFailedCaseCount}</dd>
              </div>
              <div className="bg-white px-3 py-3">
                <dt className="text-xs text-gray-500">หน้าที่สำรวจ</dt>
                <dd className="mt-1 text-lg font-semibold tabular-nums text-gray-900">{jobProcessedSnapshotCount}/{jobSnapshotCount}</dd>
              </div>
            </dl>
            {jobError && <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">ข้อผิดพลาด: {jobError}</p>}
            {jobStatus === 'incomplete' && (
              <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">Coverage ยังไม่ครบ: {coverageStopReason || jobMessage}</p>
            )}
            {coverageComplete && jobStatus !== 'running' && jobStatus !== 'incomplete' && (
              <p className="text-sm text-green-700">ตรวจสอบ coverage ที่ค้นพบครบแล้ว</p>
            )}
          </div>
          {['completed', 'incomplete', 'failed'].includes(jobStatus) && (
            <button
              type="button"
              onClick={() => navigate(`/test-cases?jobId=${encodeURIComponent(jobId)}`)}
              className="mx-5 mb-5 rounded-md bg-blue-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-800"
            >
              ดู Test case และสถานะทั้งหมด
            </button>
          )}
          {jobCases.length > 0 && (
            <ol className="divide-y divide-gray-100 border-t border-gray-100 px-5">
              {jobCases.map((testCase) => (
                <li key={testCase.id} className="py-3 text-sm">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <span className="font-medium text-gray-800">{testCase.sequence}. {testCase.title}</span>
                    <span className={testCase.status === 'failed' ? 'text-red-600' : testCase.status === 'saved' ? 'text-green-700' : testCase.status === 'generating' ? 'text-blue-700' : 'text-gray-600'}>
                      {testCase.status === 'saved' ? 'สร้างแล้ว' : testCase.status === 'failed' ? 'สร้างไม่สำเร็จ' : testCase.status === 'generating' ? 'กำลังสร้าง' : 'รอสร้าง'}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-gray-500">{testCase.page}</p>
                  {testCase.errorMessage && <p className="mt-1 text-xs text-red-600">{testCase.errorMessage}</p>}
                </li>
              ))}
            </ol>
          )}
        </section>
      )}

      {/* Live Stepper */}
      {(isGenerating || Object.values(steps).some(s => s !== 'idle')) && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">สถานะการประมวลผล</h3>
          <ol className="space-y-2">
            {stepItems.map((step, i) => (
              <li key={step.key} className="flex items-center gap-3 text-sm">
                <span className="w-5 text-center">{stepIcon(steps[step.key])}</span>
                <span className={`${steps[step.key] === 'loading' ? 'text-blue-600 font-medium' : steps[step.key] === 'done' ? 'text-green-600' : steps[step.key] === 'error' ? 'text-red-500' : 'text-gray-400'}`}>
                  {i + 1}. [{step.label}]
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* Generated Code Preview */}
      {generatedCode && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-700">โค้ด Playwright Script ที่สร้างได้</h3>
            <div className="flex items-center gap-2">
              <button
                onClick={handleCopyCode}
                className="px-3 py-1.5 text-xs rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-100"
              >
                Copy
              </button>
              <button
                onClick={handleDownloadCode}
                className="px-3 py-1.5 text-xs rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-100"
              >
                Download
              </button>
            </div>
          </div>
          {saveStatus && (
            <p className={`text-xs ${saveStatus.includes('ไม่สำเร็จ') ? 'text-amber-600' : 'text-green-600'}`}>
              {saveStatus}
            </p>
          )}
          <pre className="bg-gray-900 text-green-300 rounded-lg p-4 text-xs overflow-x-auto whitespace-pre-wrap max-h-96">
            {generatedCode}
          </pre>
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="w-full bg-green-600 text-white py-2.5 rounded-lg font-medium hover:bg-green-700 disabled:opacity-50 transition-colors"
          >
            {isSaving ? 'กำลังบันทึก...' : '💾 บันทึกอีกครั้ง (Save Again)'}
          </button>
        </div>
      )}
    </div>
  );
}
