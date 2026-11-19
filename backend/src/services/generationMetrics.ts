/**
 * Per-job generation metrics, used to compare GENERATION_MODE=legacy against GENERATION_MODE=ecommerce.
 *
 * The collector is pure (no Firestore/Ollama/browser): services feed it events through optional hooks and
 * persist `toJSON()` themselves. Execution pass rate is not collected here; it comes from `testRuns` and is
 * joined in by `scripts/generation-metrics-report.ts`.
 */
import type { GenerationMode } from "../config/env.js";

export type LlmCallStage = "planner" | "script";

export interface LlmCallMetric {
  stage: LlmCallStage;
  model: string;
  /** Characters of the system instruction + user prompt (+ tool messages on later turns). */
  promptChars: number;
}

export type PlanRejectionReason = "duplicate_registry" | "duplicate_title";

export interface ScriptAttemptMetric {
  attempt: number;
  passed: boolean;
  reason?: string;
}

export interface LlmCallAggregate {
  count: number;
  totalPromptChars: number;
  maxPromptChars: number;
}

export interface PlanningMetrics {
  plannedCount: number;
  rejectedCount: number;
  rejectedByReason: Record<PlanRejectionReason, number>;
  stalledSnapshotCount: number;
  /** ecommerce mode: labels a plan used that the compact prompt did not contain but the full snapshot did. */
  referencesCutByCompaction: number;
  /** ecommerce mode: labels a plan used that are on neither (model invention). */
  referencesNotOnPage: number;
  byCategory: Record<string, number>;
  byPage: Record<string, number>;
  byPageType: Record<string, number>;
}

export interface ScriptMetrics {
  attemptCount: number;
  validationPassedCount: number;
  validationFailedCount: number;
  casesSavedCount: number;
  casesFailedCount: number;
}

export interface GenerationMetricsSnapshot {
  mode: GenerationMode;
  planning: PlanningMetrics;
  script: ScriptMetrics;
  llmCalls: Record<LlmCallStage, LlmCallAggregate>;
}

/** Hooks that the LLM services call; all optional so existing callers are unaffected. */
export interface GenerationMetricsHooks {
  onLlmCall?: (call: LlmCallMetric) => void;
  onScriptAttempt?: (attempt: ScriptAttemptMetric) => void;
  onPromptReferenceMiss?: (miss: { text: string; inFullSnapshot: boolean }) => void;
}

const MAX_RECORDED_CALLS = 2000;

const emptyAggregate = (): LlmCallAggregate => ({ count: 0, totalPromptChars: 0, maxPromptChars: 0 });

const increment = (record: Record<string, number>, key: string, by = 1): void => {
  record[key] = (record[key] ?? 0) + by;
};

export class GenerationMetricsCollector {
  private readonly planning: PlanningMetrics = {
    plannedCount: 0,
    rejectedCount: 0,
    rejectedByReason: { duplicate_registry: 0, duplicate_title: 0 },
    stalledSnapshotCount: 0,
    referencesCutByCompaction: 0,
    referencesNotOnPage: 0,
    byCategory: {},
    byPage: {},
    byPageType: {},
  };

  private readonly script: ScriptMetrics = {
    attemptCount: 0,
    validationPassedCount: 0,
    validationFailedCount: 0,
    casesSavedCount: 0,
    casesFailedCount: 0,
  };

  private readonly llm: Record<LlmCallStage, LlmCallAggregate> = { planner: emptyAggregate(), script: emptyAggregate() };

  /** Every LLM call in order (capped), for the per-call prompt length log. */
  readonly calls: LlmCallMetric[] = [];

  constructor(readonly mode: GenerationMode) {}

  readonly hooks: Required<GenerationMetricsHooks> = {
    onLlmCall: (call) => this.recordLlmCall(call),
    onScriptAttempt: (attempt) => this.recordScriptAttempt(attempt),
    onPromptReferenceMiss: (miss) => this.recordPromptReferenceMiss(miss.inFullSnapshot),
  };

  recordPlanned(input: { category?: string; page: string; pageType?: string }): void {
    this.planning.plannedCount += 1;
    increment(this.planning.byCategory, input.category || "uncategorized");
    increment(this.planning.byPage, input.page || "unknown");
    increment(this.planning.byPageType, input.pageType || "unclassified");
  }

  recordRejected(reason: PlanRejectionReason): void {
    this.planning.rejectedCount += 1;
    this.planning.rejectedByReason[reason] += 1;
  }

  recordPromptReferenceMiss(inFullSnapshot: boolean): void {
    if (inFullSnapshot) this.planning.referencesCutByCompaction += 1;
    else this.planning.referencesNotOnPage += 1;
  }

  recordStalledSnapshot(): void {
    this.planning.stalledSnapshotCount += 1;
  }

  recordLlmCall(call: LlmCallMetric): void {
    const aggregate = this.llm[call.stage];
    aggregate.count += 1;
    aggregate.totalPromptChars += call.promptChars;
    aggregate.maxPromptChars = Math.max(aggregate.maxPromptChars, call.promptChars);
    if (this.calls.length < MAX_RECORDED_CALLS) this.calls.push({ ...call });
  }

  recordScriptAttempt(attempt: ScriptAttemptMetric): void {
    this.script.attemptCount += 1;
    if (attempt.passed) this.script.validationPassedCount += 1;
    else this.script.validationFailedCount += 1;
  }

  recordScriptCase(saved: boolean): void {
    if (saved) this.script.casesSavedCount += 1;
    else this.script.casesFailedCount += 1;
  }

  toJSON(): GenerationMetricsSnapshot {
    return structuredClone({
      mode: this.mode,
      planning: this.planning,
      script: this.script,
      llmCalls: this.llm,
    });
  }
}

const ratio = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? Math.round((numerator / denominator) * 1000) / 1000 : null;

export interface DerivedGenerationRates {
  /** Rejected (duplicate) plans / all plans the planner proposed. */
  duplicateRate: number | null;
  /** Script attempts that passed validateGeneratedScript / all attempts. */
  scriptAttemptPassRate: number | null;
  /** Cases that ended with a saved script / cases that went through script generation. */
  scriptCaseSaveRate: number | null;
  averagePromptChars: Record<LlmCallStage, number | null>;
}

export const deriveGenerationRates = (metrics: Pick<GenerationMetricsSnapshot, "planning" | "script" | "llmCalls">): DerivedGenerationRates => {
  const { planning, script, llmCalls } = metrics;
  const average = (aggregate: LlmCallAggregate | undefined): number | null =>
    aggregate && aggregate.count > 0 ? Math.round(aggregate.totalPromptChars / aggregate.count) : null;
  return {
    duplicateRate: ratio(planning.rejectedCount, planning.plannedCount + planning.rejectedCount),
    scriptAttemptPassRate: ratio(script.validationPassedCount, script.attemptCount),
    scriptCaseSaveRate: ratio(script.casesSavedCount, script.casesSavedCount + script.casesFailedCount),
    averagePromptChars: { planner: average(llmCalls.planner), script: average(llmCalls.script) },
  };
};

/** Firestore dotted field paths split on "." and reject some characters, so dynamic keys are reduced to letters/digits/_/-. */
export const metricKey = (value: string): string =>
  value.trim().replace(/[^\p{L}\p{M}\p{N}_-]+/gu, "_").replace(/^_+|_+$/g, "").slice(0, 120) || "unknown";

/**
 * Flattens every non-zero counter into a dotted Firestore field path under `generationMetrics`, so that the
 * separate invocations of one job (analysis, page discovery, planning, script runs, retries) accumulate with
 * FieldValue.increment instead of overwriting each other. `maxPromptChars` is not incrementable and is left to
 * the per-call JSON log.
 */
export const metricIncrements = (metrics: GenerationMetricsSnapshot): Record<string, number> => {
  const entries: Record<string, number> = {};
  const visit = (value: unknown, path: string[]): void => {
    if (typeof value === "number") {
      if (value !== 0 && path[path.length - 1] !== "maxPromptChars") {
        entries[["generationMetrics", ...path].join(".")] = value;
      }
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) visit(child, [...path, metricKey(key)]);
    }
  };
  visit(metrics.planning, ["planning"]);
  visit(metrics.script, ["script"]);
  visit(metrics.llmCalls, ["llmCalls"]);
  return entries;
};

export interface RunForSummary {
  completedAtMs: number;
  caseResults: Array<{ testCaseId: string; passed: boolean }>;
}

export interface ExecutionSummary {
  testCaseCount: number;
  executedCount: number;
  passedCount: number;
  /** Latest result per test case: passed / executed. */
  passRate: number | null;
}

/** Uses only the most recent run of each test case, so re-runs after fixes do not double count. */
export const summarizeLatestCaseResults = (testCaseIds: string[], runs: RunForSummary[]): ExecutionSummary => {
  const wanted = new Set(testCaseIds);
  const latest = new Map<string, { at: number; passed: boolean }>();
  for (const run of runs) {
    for (const result of run.caseResults) {
      if (!wanted.has(result.testCaseId)) continue;
      const previous = latest.get(result.testCaseId);
      if (!previous || run.completedAtMs >= previous.at) {
        latest.set(result.testCaseId, { at: run.completedAtMs, passed: result.passed === true });
      }
    }
  }
  const passedCount = [...latest.values()].filter((entry) => entry.passed).length;
  return {
    testCaseCount: wanted.size,
    executedCount: latest.size,
    passedCount,
    passRate: ratio(passedCount, latest.size),
  };
};

/** Total characters a chat request sends, used as the prompt-length metric. */
export const promptCharsOf = (messages: ReadonlyArray<{ content?: string }>): number =>
  messages.reduce((total, message) => total + (message.content?.length ?? 0), 0);
