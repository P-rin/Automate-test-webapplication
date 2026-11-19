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
  /** Exact UI label of the main element under test; used for semantic de-duplication across pages. */
  targetElement?: string;
  /** Input value(s) or start state being exercised (e.g. "quantity=0", "light -> dark"); "" when none. */
  inputVariant?: string;
  /** GENERATION_MODE=ecommerce: structured steps + oracle compiled by code (services/ecommerce/storedCase.ts). */
  structured?: Record<string, unknown>;
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
  selectedByUser?: boolean;
  confirmedByUser?: boolean;
}

export interface GenerationPage {
  pageId: string;
  title: string;
  urlPattern: string;
  sampleUrl: string;
  depth: number;
  requiresLogin: boolean;
  suggestedAcIds: string[];
}

export interface GeneratedTestCase {
  id: string;
  title: string;
  script: string;
  /** Compiled with computed assertions that only the Playwright engine runs (GENERATION_MODE=ecommerce). */
  requiresPlaywrightEngine?: boolean;
}
