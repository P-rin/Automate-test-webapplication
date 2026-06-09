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
  lastStatus: 'pass' | 'fail' | 'pending' | 'running';
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
  totalDuration: number; // ms
  logs: string;
  screenshotUrls: string[];
  errorDetails: string;
  startedAt: Date;
  completedAt?: Date;
}
