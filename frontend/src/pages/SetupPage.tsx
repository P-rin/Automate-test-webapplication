import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

interface StepState {
  connecting: 'idle' | 'loading' | 'done' | 'error';
  reading: 'idle' | 'loading' | 'done' | 'error';
  fetching: 'idle' | 'loading' | 'done' | 'error';
  writing: 'idle' | 'loading' | 'done' | 'error';
}

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:4000';

export default function SetupPage() {
  const navigate = useNavigate();
  const [url, setUrl] = useState('http://localhost:3000');
  const [files, setFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedCode, setGeneratedCode] = useState('');
  const [projectName, setProjectName] = useState('');
  const [steps, setSteps] = useState<StepState>({
    connecting: 'idle', reading: 'idle', fetching: 'idle', writing: 'idle',
  });
  const [isSaving, setIsSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
    if (!url || files.length === 0) {
      alert('กรุณากรอก URL และอัปโหลดไฟล์ความต้องการอย่างน้อย 1 ไฟล์');
      return;
    }
    setIsGenerating(true);
    setGeneratedCode('');
    setSteps({ connecting: 'loading', reading: 'idle', fetching: 'idle', writing: 'idle' });

    try {
      const formData = new FormData();
      formData.append('url', url);
      formData.append('projectName', projectName || url);
      files.forEach(f => formData.append('files', f));

      setStep('connecting', 'done');
      setStep('reading', 'loading');

      const res = await fetch(`${BACKEND_URL}/api/generate`, {
        method: 'POST',
        body: formData,
      });

      setStep('reading', 'done');
      setStep('fetching', 'loading');

      if (!res.ok) throw new Error(await res.text());

      setStep('fetching', 'done');
      setStep('writing', 'loading');

      const data = await res.json();
      setStep('writing', 'done');
      setGeneratedCode(data.script || '');
    } catch (err) {
      console.error(err);
      const failedStep = steps.writing === 'loading' ? 'writing'
        : steps.fetching === 'loading' ? 'fetching'
        : steps.reading === 'loading' ? 'reading' : 'connecting';
      setStep(failedStep, 'error');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSave = async () => {
    if (!generatedCode) return;
    setIsSaving(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/save-test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, projectName: projectName || url, script: generatedCode }),
      });
      if (!res.ok) throw new Error(await res.text());
      alert('บันทึกลงฐานข้อมูลเรียบร้อยแล้ว!');
      navigate('/test-cases');
    } catch (err) {
      console.error(err);
      alert('เกิดข้อผิดพลาดในการบันทึก');
    } finally {
      setIsSaving(false);
    }
  };

  const stepItems: { key: keyof StepState; label: string }[] = [
    { key: 'connecting', label: 'Connecting to Localhost' },
    { key: 'reading', label: 'Reading Context Specification File(s)' },
    { key: 'fetching', label: 'Fetching Accessibility Snapshot via MCP' },
    { key: 'writing', label: 'Writing Playwright Scripts & Criteria with GitHub Copilot' },
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
          placeholder="http://localhost:3000"
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {/* File Uploader */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 space-y-3">
        <label className="block text-sm font-medium text-gray-700">อัปโหลดไฟล์ความต้องการ (.md / .txt)</label>
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
          </div>
          <pre className="bg-gray-900 text-green-300 rounded-lg p-4 text-xs overflow-x-auto whitespace-pre-wrap max-h-96">
            {generatedCode}
          </pre>
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="w-full bg-green-600 text-white py-2.5 rounded-lg font-medium hover:bg-green-700 disabled:opacity-50 transition-colors"
          >
            {isSaving ? 'กำลังบันทึก...' : '💾 บันทึกลงฐานข้อมูล (Save to Database)'}
          </button>
        </div>
      )}
    </div>
  );
}
