export type PlaywrightTestOutcome = "passed" | "failed" | "flaky" | "skipped";

interface PlaywrightTestResult {
  status?: string;
  duration?: number;
  errors?: Array<{ message?: string; stack?: string }>;
}

interface PlaywrightTest {
  outcome?: string;
  results?: PlaywrightTestResult[];
}

interface PlaywrightSuite {
  specs?: Array<{
    tests?: PlaywrightTest[];
  }>;
  suites?: PlaywrightSuite[];
}

export interface PlaywrightResultCounts {
  passCount: number;
  failCount: number;
  flakyCount: number;
  skippedCount: number;
  errors: string[];
  outcomes: PlaywrightTestOutcome[];
}

const classifyTestOutcome = (test: PlaywrightTest): PlaywrightTestOutcome => {
  const statuses = (test.results ?? []).map((result) => result.status);
  if (test.outcome === "flaky" || (statuses.includes("passed") && statuses.some((status) =>
    status === "failed" || status === "timedOut" || status === "interrupted"))) {
    return "flaky";
  }
  if (test.outcome === "skipped" || statuses.length === 0 || statuses.every((status) => status === "skipped")) {
    return "skipped";
  }
  if (test.outcome === "unexpected") return "failed";
  if (test.outcome === "expected" || statuses.at(-1) === "passed") return "passed";
  return "failed";
};

export const countResultsRecursive = (suite: PlaywrightSuite): PlaywrightResultCounts => {
  const counts: PlaywrightResultCounts = {
    passCount: 0,
    failCount: 0,
    flakyCount: 0,
    skippedCount: 0,
    errors: [],
    outcomes: [],
  };

  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      const outcome = classifyTestOutcome(test);
      counts.outcomes.push(outcome);
      if (outcome === "passed") counts.passCount += 1;
      if (outcome === "failed") counts.failCount += 1;
      if (outcome === "flaky") counts.flakyCount += 1;
      if (outcome === "skipped") counts.skippedCount += 1;

      if (outcome === "failed" || outcome === "flaky") {
        for (const result of test.results ?? []) {
          if (result.status !== "failed" && result.status !== "timedOut" && result.status !== "interrupted") continue;
          for (const error of result.errors ?? []) {
            if (error.message) counts.errors.push(error.message);
            else if (error.stack) counts.errors.push(error.stack);
          }
        }
      }
    }
  }

  for (const nestedSuite of suite.suites ?? []) {
    const nested = countResultsRecursive(nestedSuite);
    counts.passCount += nested.passCount;
    counts.failCount += nested.failCount;
    counts.flakyCount += nested.flakyCount;
    counts.skippedCount += nested.skippedCount;
    counts.errors.push(...nested.errors);
    counts.outcomes.push(...nested.outcomes);
  }

  return counts;
};

export const parsePlaywrightReport = (
  report: PlaywrightSuite & { stats?: { duration?: number } },
): PlaywrightResultCounts & { duration: number } => {
  const counts = countResultsRecursive({ suites: report.suites });
  return {
    ...counts,
    duration: report.stats?.duration ?? 0,
  };
};
