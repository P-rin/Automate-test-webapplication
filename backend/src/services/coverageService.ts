import type { AcceptanceCriterion, RequirementUnit } from "../types.js";

export type CoverageState =
  | "missing"
  | "in_progress"
  | "unverified"
  | "failing"
  | "covered"
  | "manual";

export interface CoverageCaseInput {
  id: string;
  title: string;
  status: string;
  requirementIds?: string[];
  category?: string;
  testCaseId?: string;
  page?: string;
}

export interface CoverageTestCaseInput {
  id: string;
  lastStatus: string;
  generationCaseId?: string;
}

export interface CoverageCriterion extends AcceptanceCriterion {
  state: CoverageState;
  source?: RequirementUnit;
  linkedCases: Array<{
    id: string;
    title: string;
    status: string;
    category?: string;
    testCaseId?: string;
    lastStatus?: string;
  }>;
  gapReason?: string;
  needsNegativeCase: boolean;
}

export interface CoverageReport {
  criteria: CoverageCriterion[];
  totals: Record<CoverageState, number>;
  exploratoryCaseCount: number;
  analysisWarnings: string[];
  ambiguities: Array<{ acId: string; text: string }>;
  cases: CoverageCaseInput[];
}

const emptyTotals = (): Record<CoverageState, number> => ({
  missing: 0,
  in_progress: 0,
  unverified: 0,
  failing: 0,
  covered: 0,
  manual: 0,
});

export const computeCoverage = (
  criteria: AcceptanceCriterion[],
  cases: CoverageCaseInput[],
  testCases: CoverageTestCaseInput[],
  gaps: Array<{ acId: string; reason: string }>,
  requirementUnits: RequirementUnit[] = [],
  analysisWarnings: string[] = [],
): CoverageReport => {
  const testCasesById = new Map(testCases.map((testCase) => [testCase.id, testCase]));
  const testCasesByGenerationCaseId = new Map(
    testCases
      .filter((testCase) => typeof testCase.generationCaseId === "string")
      .map((testCase) => [testCase.generationCaseId!, testCase]),
  );
  const gapsByAcId = new Map(gaps.map((gap) => [gap.acId, gap.reason]));
  const inputRelatedRefs = new Set(criteria
    .filter((criterion) => ["validation", "negative", "boundary"].includes(criterion.category))
    .map((criterion) => criterion.requirementRef));
  const unitsByRef = new Map(requirementUnits.map((unit) => [unit.ref, unit]));
  const totals = emptyTotals();

  const criterionReports = criteria.map((criterion): CoverageCriterion => {
    const linkedCases = cases.filter((testCase) => testCase.requirementIds?.includes(criterion.id) ?? false);
    const linkedCasesWithStatus = linkedCases.map((testCase) => {
      const savedTestCase = (testCase.testCaseId ? testCasesById.get(testCase.testCaseId) : undefined)
        ?? testCasesByGenerationCaseId.get(testCase.id);
      return {
        ...testCase,
        ...(savedTestCase ? { lastStatus: savedTestCase.lastStatus } : {}),
      };
    });
    const linkedTestCases = linkedCasesWithStatus.filter((testCase) =>
      typeof testCase.lastStatus === "string");

    let state: CoverageState;
    if (criterion.verification === "manual") {
      state = "manual";
    } else if (linkedCases.length === 0) {
      state = "missing";
    } else if (linkedTestCases.some((testCase) => testCase.lastStatus === "fail")) {
      state = "failing";
    } else if (linkedTestCases.length > 0) {
      state = linkedTestCases.every((testCase) => testCase.lastStatus === "pass")
        ? "covered"
        : "unverified";
    } else if (linkedCases.some((testCase) => ["planned", "generating"].includes(testCase.status))) {
      state = "in_progress";
    } else {
      state = "missing";
    }

    const isInputRelated = inputRelatedRefs.has(criterion.requirementRef);
    const hasNegativeCase = linkedCases.some((testCase) =>
      ["validation", "negative", "boundary"].includes(testCase.category ?? ""));
    const needsNegativeCase = criterion.priority === "required"
      && (["validation", "negative", "boundary"].includes(criterion.category) || isInputRelated)
      && !hasNegativeCase;
    totals[state] += 1;

    return {
      ...criterion,
      state,
      ...(unitsByRef.has(criterion.requirementRef) ? { source: unitsByRef.get(criterion.requirementRef) } : {}),
      linkedCases: linkedCasesWithStatus,
      ...(state === "missing" && gapsByAcId.has(criterion.id)
        ? { gapReason: gapsByAcId.get(criterion.id) }
        : {}),
      needsNegativeCase,
    };
  });

  const ambiguities = criterionReports
    .filter((criterion) => criterion.ambiguity.trim().length > 0)
    .map((criterion) => ({ acId: criterion.id, text: criterion.ambiguity }));

  return {
    criteria: criterionReports,
    totals,
    exploratoryCaseCount: cases.filter((testCase) => testCase.category === "exploratory").length,
    analysisWarnings: [...analysisWarnings],
    ambiguities,
    cases: cases.map((testCase) => ({ ...testCase })),
  };
};

const markdownCell = (value: string): string => value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();

const coverageLabel = (state: CoverageState): string => state.replace(/_/g, " ");

const statusForLinkedCase = (testCase: CoverageCriterion["linkedCases"][number]): string =>
  testCase.lastStatus ?? testCase.status;

export const renderCoverageMarkdown = (report: CoverageReport): string => {
  const pageGroups = new Map<string, CoverageCaseInput[]>();
  for (const testCase of report.cases) {
    const page = testCase.page?.trim() || "Unspecified page";
    const group = pageGroups.get(page) ?? [];
    group.push(testCase);
    pageGroups.set(page, group);
  }

  const lines = [
    "# TESTS.md",
    "",
    "## Test Asset Map",
    "",
    "| Page | Cases | Categories | Acceptance criteria |",
    "|---|---:|---|---|",
  ];

  if (pageGroups.size === 0) lines.push("| No discovered pages | 0 | - | - |");
  for (const [page, pageCases] of pageGroups) {
    const categories = [...new Set(pageCases.map((testCase) => testCase.category).filter(Boolean))].join(", ") || "-";
    const acIds = [...new Set(pageCases.flatMap((testCase) => testCase.requirementIds ?? []))].join(", ") || "-";
    lines.push(`| ${markdownCell(page)} | ${pageCases.length} | ${markdownCell(categories)} | ${markdownCell(acIds)} |`);
  }

  lines.push("", "## Required Test Points", "");
  if (report.criteria.length === 0) lines.push("No acceptance criteria were generated.", "");
  for (const criterion of report.criteria) {
    const source = criterion.source
      ? `${criterion.source.ref}${criterion.source.section ? ` — ${criterion.source.section}` : ""}: ${criterion.source.sourceText.slice(0, 200)}`
      : criterion.requirementRef;
    lines.push(
      `### ${criterion.id} — ${markdownCell(criterion.priority)} / ${markdownCell(criterion.category)}`,
      "",
      `- State: ${coverageLabel(criterion.state)}`,
      `- Source: ${markdownCell(source)}`,
      `- Expected behavior: ${markdownCell(criterion.expected)}`,
      `- Linked test cases: ${criterion.linkedCases.length > 0
        ? criterion.linkedCases.map((testCase) => `${markdownCell(testCase.title)} (${markdownCell(statusForLinkedCase(testCase))})`).join("; ")
        : "None"}`,
      "",
    );
  }

  lines.push("## Manual Verification Exits", "", "| Check | Expected behavior | Evidence |", "|---|---|---|");
  const manualCriteria = report.criteria.filter((criterion) => criterion.verification === "manual");
  if (manualCriteria.length === 0) lines.push("| No manual checks | - | |");
  for (const criterion of manualCriteria) {
    lines.push(`| ${criterion.id} | ${markdownCell(criterion.expected)} | |`);
  }

  lines.push("", "## Current Gaps and Actions", "");
  const gapCriteria = report.criteria
    .filter((criterion) =>
      ["missing", "failing", "unverified"].includes(criterion.state) || criterion.needsNegativeCase)
    .sort((left, right) =>
      Number(right.priority === "required") - Number(left.priority === "required")
      || left.id.localeCompare(right.id));
  if (gapCriteria.length === 0) lines.push("No current gaps.", "");
  for (const criterion of gapCriteria) {
    const actions = [
      criterion.state !== "covered" && criterion.state !== "manual" ? coverageLabel(criterion.state) : "",
      criterion.gapReason ?? "",
      criterion.needsNegativeCase ? "add a negative, validation, or boundary case" : "",
    ].filter(Boolean).join("; ");
    lines.push(`- [ ] ${criterion.id} (${criterion.priority}): ${markdownCell(actions || "Review linked test case")}`);
  }

  lines.push("", "## Ambiguities to confirm", "");
  if (report.ambiguities.length === 0) lines.push("No ambiguities recorded.");
  for (const ambiguity of report.ambiguities) {
    lines.push(`- ${ambiguity.acId}: ${markdownCell(ambiguity.text)}`);
  }

  return `${lines.join("\n").trimEnd()}\n`;
};
