import type { Timestamp } from 'firebase/firestore';

export interface Project {
  id: string;
  name: string;
  url: string;
  createdAt: Date;
}

export interface TestCase {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  type: 'UI' | 'API';
  script: string;
  lastStatus: 'pass' | 'fail' | 'flaky' | 'pending' | 'running';
  lastRunAt?: Date;
  createdAt: Date;
}

export interface TestRun {
  id: string;
  projectId: string;
  projectName: string;
  testCaseIds: string[];
  status: 'running' | 'completed' | 'failed';
  passCount: number;
  failCount: number;
  flakyCount?: number;
  skippedCount?: number;
  totalDuration: number; // ms
  logs: string;
  screenshotUrls: string[];
  videoUrls?: string[];
  traceUrls?: string[];
  errorDetails: string;
  engineRequested?: 'playwright' | 'mcp';
  engineUsed?: 'playwright' | 'mcp';
  fallbackReason?: string;
  mcpTrace?: Array<Record<string, unknown>>;
  caseResults?: Array<{
    testCaseId: string;
    passed: boolean;
    outcome?: 'passed' | 'failed' | 'flaky' | 'skipped';
    errors: string[];
    duration: number;
    filePattern?: string;
    screenshotUrls?: string[];
    videoUrl?: string;
    traceUrl?: string;
  }>;
  startedAt: Date | Timestamp;
  completedAt?: Date | Timestamp;
}
