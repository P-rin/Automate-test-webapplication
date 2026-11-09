export type TestCaseKind = "UI" | "API";

export type TestCaseStatus = "pass" | "fail" | "flaky" | "pending" | "running";

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

export const TEST_PLAN_CATEGORIES = [
  "happy_path",
  "validation",
  "negative",
  "boundary",
  "access_control",
  "exploratory",
] as const;

export type TestPlanCategory = typeof TEST_PLAN_CATEGORIES[number];

export interface TestPlan {
  id: string;
  title: string;
  description: string;
  type: TestCaseKind;
  testSteps: string[];
  expectedResult: string;
  /** AC IDs (e.g. "AC-003") this plan verifies; [] for exploratory cases. */
  requirementIds?: string[];
  category?: TestPlanCategory;
}

export interface RequirementUnit {
  ref: string;
  section: string;
  sourceText: string;
}

export interface AcceptanceCriterion {
  id: string;
  requirementRef: string;
  scenario: string;
  action: string;
  expected: string;
  mustNot: string;
  category: Exclude<TestPlanCategory, "exploratory">;
  priority: "required" | "important" | "optional";
  verification: "automated" | "manual";
  ambiguity: string;
}

export interface GeneratedTestCase {
  id: string;
  title: string;
  script: string;
}
