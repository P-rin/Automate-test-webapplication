import { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

interface StepState {
  connecting: 'idle' | 'loading' | 'done' | 'error';
  reading: 'idle' | 'loading' | 'done' | 'error';
  fetching: 'idle' | 'loading' | 'done' | 'error';
  writing: 'idle' | 'loading' | 'done' | 'error';
}

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:4000';

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
  status: 'planned' | 'generating' | 'saved' | 'failed';
  testCaseId?: string;
  errorMessage?: string;
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
  coverageComplete?: boolean;
  coverageStopReason?: string;
  primaryGeneratedTest?: GeneratedJobTest;
  cases?: GenerationJobCase[];
  caseCursor?: string;
}

export default function SetupPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [url, setUrl] = useState('https://example.com');
  const [requirementsText, setRequirementsText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedCode, setGeneratedCode] = useState('');
  const [projectName, setProjectName] = useState('');
  const [jobId, setJobId] = useState('');
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
    setSteps({ connecting: 'loading', reading: 'idle', fetching: 'idle', writing: 'idle' });

    try {
      const formData = new FormData();
      formData.append('url', url);
      formData.append('projectName', projectName || url);
      formData.append('requirements', requirementsText.trim());
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
    { key: 'writing', label: 'Writing Playwright Scripts & Criteria with Ollama' },
  ];

  const stepIcon = (status: string) => {
    if (status === 'done') return <span className="text-green-500">✓</span>;
    if (status === 'loading') return <span className="animate-spin inline-block">⟳</span>;
    if (status === 'error') return <span className="text-red-500">✗</span>;
    return <span className="text-gray-300">○</span>;
  };

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
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 mt-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">สถานะงานหลังบ้าน (Background Job)</h3>
          <div className="text-sm text-gray-700 space-y-2">
            <p><span className="font-medium">Job ID:</span> {jobId}</p>
            <p><span className="font-medium">สถานะ:</span> {jobStatus || 'pending'}</p>
            <p><span className="font-medium">ขั้นตอน:</span> {jobStage || 'กำลังรอการประมวลผล'}</p>
            <p><span className="font-medium">ความคืบหน้า:</span> {jobPercentage}%</p>
            <p><span className="font-medium">เคส:</span> {jobCompletedCaseCount} บันทึกแล้ว / {jobCaseCount} วางแผนแล้ว / {jobFailedCaseCount} ล้มเหลว</p>
            <p><span className="font-medium">หน้า/สถานะที่สำรวจ:</span> {jobProcessedSnapshotCount}/{jobSnapshotCount}</p>
            <p><span className="font-medium">ข้อความ:</span> {jobMessage || 'กำลังรอการประมวลผล'}</p>
            {jobError && <p className="text-red-600"><span className="font-medium">ข้อผิดพลาด:</span> {jobError}</p>}
            {jobStatus === 'incomplete' && (
              <p className="text-amber-700"><span className="font-medium">Coverage ยังไม่ครบ:</span> {coverageStopReason || jobMessage}</p>
            )}
            {coverageComplete && jobStatus !== 'running' && jobStatus !== 'incomplete' && (
              <p className="text-green-700">ตรวจสอบ coverage ที่ค้นพบครบแล้ว</p>
            )}
          </div>
          <div className="w-full bg-gray-100 rounded-full h-2 mt-3 overflow-hidden">
            <div className="h-2 bg-blue-600" style={{ width: `${Math.min(jobPercentage, 100)}%` }} />
          </div>
          {jobCases.length > 0 && (
            <ol className="mt-4 divide-y divide-gray-100 border-t border-gray-100">
              {jobCases.map((testCase) => (
                <li key={testCase.id} className="py-3 text-sm">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <span className="font-medium text-gray-800">{testCase.sequence}. {testCase.title}</span>
                    <span className={testCase.status === 'failed' ? 'text-red-600' : testCase.status === 'saved' ? 'text-green-700' : 'text-blue-700'}>
                      {testCase.status}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-gray-500">{testCase.page}</p>
                  {testCase.errorMessage && <p className="mt-1 text-xs text-red-600">{testCase.errorMessage}</p>}
                </li>
              ))}
            </ol>
          )}
        </div>
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
