/**
 * Baseline / comparison report for generation jobs (ECOMMERCE_TESTGEN_CONTEXT.md Phase 0 and Phase 10).
 *
 * Reads `generationJobs/{id}.generationMetrics` (written by generationJobService), the job's saved test
 * cases, and their most recent `testRuns` results, then prints a markdown table and writes JSON.
 *
 * Usage (from backend/):
 *   npx tsx scripts/generation-metrics-report.ts <jobId> [<jobId> ...] [--label=baseline-legacy] [--out=metrics]
 *
 * Output: <out>/<label>.json and <out>/<label>.md (default out dir: backend/metrics, label: report-<timestamp>).
 * Read-only: never writes to Firestore.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { db } from "../src/lib/firestore.js";
import {
  deriveGenerationRates,
  summarizeLatestCaseResults,
  type GenerationMetricsSnapshot,
  type RunForSummary,
} from "../src/services/generationMetrics.js";

const args = process.argv.slice(2);
const option = (name: string): string | undefined =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3).trim() || undefined;
const jobIds = args.filter((arg) => !arg.startsWith("--"));
const label = option("label") ?? `report-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const outDir = path.resolve(process.cwd(), option("out") ?? "metrics");

if (jobIds.length === 0) {
  console.error("Usage: npx tsx scripts/generation-metrics-report.ts <jobId> [<jobId> ...] [--label=name] [--out=dir]");
  process.exit(1);
}

const toMillis = (value: unknown): number | null => {
  if (value && typeof (value as { toMillis?: unknown }).toMillis === "function") {
    return (value as { toMillis: () => number }).toMillis();
  }
  return null;
};

const emptyMetrics = (): Pick<GenerationMetricsSnapshot, "planning" | "script" | "llmCalls"> => ({
  planning: {
    plannedCount: 0,
    rejectedCount: 0,
    rejectedByReason: { duplicate_registry: 0, duplicate_title: 0 },
    stalledSnapshotCount: 0,
    referencesCutByCompaction: 0,
    referencesNotOnPage: 0,
    byCategory: {},
    byPage: {},
    byPageType: {},
  },
  script: { attemptCount: 0, validationPassedCount: 0, validationFailedCount: 0, casesSavedCount: 0, casesFailedCount: 0 },
  llmCalls: {
    planner: { count: 0, totalPromptChars: 0, maxPromptChars: 0 },
    script: { count: 0, totalPromptChars: 0, maxPromptChars: 0 },
  },
});

/** Firestore drops untouched counters, so merge the stored partial object over zeroed defaults. */
const mergeMetrics = (stored: Record<string, unknown> | undefined) => {
  const base = emptyMetrics();
  const planning = (stored?.planning ?? {}) as Partial<typeof base.planning>;
  const script = (stored?.script ?? {}) as Partial<typeof base.script>;
  const llmCalls = (stored?.llmCalls ?? {}) as Partial<typeof base.llmCalls>;
  return {
    mode: String(stored?.mode ?? "unknown"),
    planning: {
      ...base.planning,
      ...planning,
      rejectedByReason: { ...base.planning.rejectedByReason, ...planning.rejectedByReason },
    },
    script: { ...base.script, ...script },
    llmCalls: {
      planner: { ...base.llmCalls.planner, ...llmCalls.planner },
      script: { ...base.llmCalls.script, ...llmCalls.script },
    },
  };
};

const chunk = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

const loadRuns = async (testCaseIds: string[]): Promise<RunForSummary[]> => {
  const runs = new Map<string, RunForSummary>();
  for (const ids of chunk(testCaseIds, 30)) {
    const snapshot = await db.collection("testRuns").where("testCaseIds", "array-contains-any", ids).get();
    for (const document of snapshot.docs) {
      const data = document.data();
      const completedAtMs = toMillis(data.completedAt);
      if (completedAtMs === null || data.isRunning === true) continue;
      runs.set(document.id, {
        completedAtMs,
        caseResults: Array.isArray(data.caseResults)
          ? data.caseResults.map((result: Record<string, unknown>) => ({
            testCaseId: String(result.testCaseId ?? ""),
            passed: result.passed === true,
          }))
          : [],
      });
    }
  }
  return [...runs.values()];
};

/** Max prompt length per stage from logs/generation-metrics/<jobId>.jsonl (only on the machine that ran the job). */
const loadMaxPromptChars = async (jobId: string): Promise<{ planner: number; script: number } | null> => {
  try {
    const content = await readFile(path.resolve(process.cwd(), "logs", "generation-metrics", `${jobId.replace(/[^\w-]/g, "_")}.jsonl`), "utf8");
    const max = { planner: 0, script: 0 };
    for (const line of content.split("\n").filter(Boolean)) {
      const entry = JSON.parse(line) as { calls?: Array<{ stage: "planner" | "script"; promptChars: number }> };
      for (const call of entry.calls ?? []) max[call.stage] = Math.max(max[call.stage], call.promptChars);
    }
    return max;
  } catch {
    return null;
  }
};

const percent = (value: number | null): string => (value === null ? "-" : `${(value * 100).toFixed(1)}%`);
const formatCounts = (record: Record<string, number>): string =>
  Object.entries(record).sort(([, a], [, b]) => b - a).map(([key, count]) => `${key}: ${count}`).join(", ") || "-";

const reports = [];
for (const jobId of jobIds) {
  const jobSnapshot = await db.collection("generationJobs").doc(jobId).get();
  if (!jobSnapshot.exists) {
    console.warn(`Job ${jobId} not found; skipped`);
    continue;
  }
  const job = jobSnapshot.data() as Record<string, unknown>;
  const metrics = mergeMetrics(job.generationMetrics as Record<string, unknown> | undefined);
  const maxPromptChars = await loadMaxPromptChars(jobId);
  if (maxPromptChars) {
    metrics.llmCalls.planner.maxPromptChars = maxPromptChars.planner;
    metrics.llmCalls.script.maxPromptChars = maxPromptChars.script;
  }
  const testCases = await db.collection("testCases").where("generationJobId", "==", jobId).get();
  const testCaseIds = testCases.docs.map((document) => document.id);
  const execution = summarizeLatestCaseResults(testCaseIds, await loadRuns(testCaseIds));
  const startedAt = toMillis(job.startedAt);
  const completedAt = toMillis(job.completedAt);
  reports.push({
    jobId,
    projectName: String(job.projectName ?? ""),
    targetUrl: String(job.targetUrl ?? ""),
    status: String(job.status ?? ""),
    hasGenerationMetrics: job.generationMetrics !== undefined,
    planningDurationSeconds: startedAt !== null && completedAt !== null ? Math.round((completedAt - startedAt) / 1000) : null,
    caseCount: Number(job.caseCount ?? 0),
    coverageGaps: Array.isArray(job.coverageGaps) ? job.coverageGaps.length : 0,
    metrics,
    rates: deriveGenerationRates(metrics),
    execution,
  });
}

if (reports.length === 0) {
  console.error("No jobs found");
  process.exit(1);
}

const lines = [
  `# Generation metrics: ${label}`,
  "",
  `Generated ${new Date().toISOString()}`,
  "",
  "| Job | Site | Mode | Status | Planned | Duplicates (rate) | Stalled pages | Script valid (attempts) | Scripts saved | Pass rate (latest run) | Avg planner prompt | Max planner prompt* | Avg script prompt | Planning time |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ...reports.map((report) => {
    const { metrics: m, rates: r, execution: e } = report;
    return `| ${report.jobId} | ${report.targetUrl} | ${m.mode} | ${report.status} | ${m.planning.plannedCount} | ${m.planning.rejectedCount} (${percent(r.duplicateRate)}) | ${m.planning.stalledSnapshotCount} | ${m.script.validationPassedCount}/${m.script.attemptCount} (${percent(r.scriptAttemptPassRate)}) | ${m.script.casesSavedCount}/${m.script.casesSavedCount + m.script.casesFailedCount} | ${e.passedCount}/${e.executedCount} of ${e.testCaseCount} (${percent(e.passRate)}) | ${r.averagePromptChars.planner ?? "-"} | ${m.llmCalls.planner.maxPromptChars || "-"} | ${r.averagePromptChars.script ?? "-"} | ${report.planningDurationSeconds ?? "-"}s |`;
  }),
  "",
  "\\* max prompt length comes from logs/generation-metrics/<jobId>.jsonl on the machine that ran the job (\"-\" when that log is missing).",
  "",
  "## Cases per category / page",
  "",
  ...reports.flatMap((report) => [
    `### ${report.jobId} (${report.metrics.mode})`,
    "",
    `- Category: ${formatCounts(report.metrics.planning.byCategory)}`,
    `- Page: ${formatCounts(report.metrics.planning.byPage)}`,
    `- Page type: ${formatCounts(report.metrics.planning.byPageType)}`,
    `- Duplicates: registry ${report.metrics.planning.rejectedByReason.duplicate_registry}, title ${report.metrics.planning.rejectedByReason.duplicate_title}`,
    `- AC coverage gaps: ${report.coverageGaps}`,
    `- Labels used by the planner but missing from the compact prompt (ecommerce): cut by compaction ${report.metrics.planning.referencesCutByCompaction}, not on page ${report.metrics.planning.referencesNotOnPage}`,
    ...(report.hasGenerationMetrics ? [] : ["- ⚠ job has no generationMetrics (created before Phase 0 metrics)"]),
    "",
  ]),
];

await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, `${label}.json`), `${JSON.stringify({ label, generatedAt: new Date().toISOString(), reports }, null, 2)}\n`, "utf8");
await writeFile(path.join(outDir, `${label}.md`), `${lines.join("\n")}\n`, "utf8");
console.log(lines.join("\n"));
console.log(`\nSaved ${path.join(outDir, `${label}.json`)} and .md`);
process.exit(0);
