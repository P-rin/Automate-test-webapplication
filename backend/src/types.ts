export type TestCaseKind = "UI" | "API";

export type TestCaseStatus = "pass" | "fail" | "pending" | "running";

export interface StoredTestCase {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  type: TestCaseKind;
  script: string;
  lastStatus: TestCaseStatus;
  lastRunAt?: Date;
  createdAt: Date;
}

export interface GeneratedArtifact {
  title: string;
  type: TestCaseKind;
  criteria: string[];
  script: string;
}
