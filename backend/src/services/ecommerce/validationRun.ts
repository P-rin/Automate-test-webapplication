/**
 * Phase 8b/8c — validation run and auto-repair. Each generated case runs once against the target site:
 *   pass                                  -> verified
 *   a locator found nothing               -> auto-repair: recompile with another locator for that element
 *                                            (no LLM), at most `maxRepairs` reruns, else needs_review
 *   the check failed, happy path          -> oracle_unreliable (the site is presumed right; review the check)
 *   the check failed, negative/boundary   -> possible_bug, with Playwright's screenshot/trace as evidence
 *   setup (precondition/navigation) fails -> needs_review
 * A validation run is information for the user, not proof that the site has no bugs.
 * Nothing that would place an order runs when the job does not allow mutating tests.
 */
import { matchesAnyTerm } from "./keywords.js";
import { CHECK_MARKER, compileCase, STEPS_MARKER, alternativeLocators, type CompiledCase } from "./scriptCompiler.js";
import { parsePreconditionSection } from "./preconditions.js";
import { buildInventory } from "./snapshotCompactor.js";
import type { StoredStructuredCase } from "./storedCase.js";
import { FINAL_ORDER_TERMS } from "./templates/helpers.js";

export type ValidationStatus = "verified" | "oracle_unreliable" | "possible_bug" | "needs_review";

/** Result of running one spec once. `line` is the failing line in the spec file, when Playwright reports it. */
export interface SpecRunResult {
  status: "passed" | "failed" | "error";
  message?: string;
  line?: number;
  /** Screenshot/trace/video files Playwright kept for a failure. */
  evidence: string[];
}

export type SpecRunner = (script: string) => Promise<SpecRunResult>;

export type FailurePart = "setup" | "steps" | "check";

export interface FailureClassification {
  part: FailurePart;
  /** A locator matched nothing (or too much) in time: something auto-repair can try to fix. */
  locatorProblem: boolean;
  failingLine?: string;
}

const LOCATOR_PROBLEM = [
  /\b(locator|page|frame)\.\w+: Timeout \d+ms exceeded/i,
  /strict mode violation/i,
  /Test timeout of \d+ms exceeded[\s\S]*waiting for (locator|getBy)/i,
];

const stripAnsi = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, "");

/** Which part of the test failed (from the line markers the compiler writes) and whether a locator was the cause. */
export const classifyFailure = (script: string, run: SpecRunResult): FailureClassification => {
  const lines = script.split("\n");
  const message = stripAnsi(run.message ?? "");
  const testStart = lines.findIndex((line) => line.startsWith("test("));
  const stepsAt = lines.findIndex((line) => line.trim() === STEPS_MARKER);
  const checkAt = lines.findIndex((line) => line.trim() === CHECK_MARKER);
  const index = run.line !== undefined ? run.line - 1 : -1;
  // Helper functions above the test are only called by the check.
  const part: FailurePart = index < 0 ? "check"
    : index < testStart ? "check"
      : stepsAt >= 0 && index < stepsAt ? "setup"
        : checkAt >= 0 && index > checkAt ? "check"
          : "steps";
  const failingLine = index >= 0 ? lines[index]?.trim() : undefined;
  // An expect() on a missing element is the check's verdict, not a broken locator; reads inside a computed
  // check (innerText of a total) that time out are locator problems.
  const isExpectFailure = /^(Error: )?expect(\.poll)?\(/m.test(message) && !/\b(locator|page)\.\w+: Timeout/.test(message);
  return { part, locatorProblem: !isExpectFailure && LOCATOR_PROBLEM.some((pattern) => pattern.test(message)), ...(failingLine ? { failingLine } : {}) };
};

const normalizeQuotes = (text: string): string => text.replace(/"/g, "'");

/** The element whose locator is in the failing line, or in Playwright's "waiting for ..." message. */
export const failingElementId = (compiled: CompiledCase, classification: FailureClassification, message = ""): string | undefined => {
  const entries = Object.entries(compiled.locators).sort((a, b) => b[1].length - a[1].length);
  const inLine = entries.find(([, locator]) => classification.failingLine?.includes(locator));
  if (inLine) return inLine[0];
  // Playwright prints locators with single quotes and without the leading "page.".
  const printed = normalizeQuotes(stripAnsi(message));
  return entries.find(([, locator]) => printed.includes(normalizeQuotes(locator.replace(/^page\./, ""))))?.[0];
};

const NEGATIVE_LIKE = new Set(["negative", "validation", "boundary", "access_control"]);

export const verdictForCheckFailure = (category: string): ValidationStatus =>
  NEGATIVE_LIKE.has(category) ? "possible_bug" : "oracle_unreliable";

export interface ValidationInput {
  title: string;
  category: string;
  stored: StoredStructuredCase;
  /** The stored snapshot the case was planned on (with its precondition section, if any). */
  snapshot: string;
  allowMutatingTests: boolean;
  maxRepairs?: number;
}

export interface ValidationOutcome {
  status: ValidationStatus;
  reason: string;
  /** The script to save: repaired when auto-repair fixed a locator. */
  script: string;
  requiresPlaywrightEngine: boolean;
  /** Element ID -> locator that replaced the compiled one. */
  repairedLocators: Record<string, string>;
  runs: number;
  evidence: string[];
}

/** A click whose locator names an order/payment button. */
export const clicksFinalOrder = (script: string): boolean => script.split("\n").some((line) =>
  /\.click\(\)/.test(line) && [...line.matchAll(/name: "([^"]+)"/g)].some((match) => matchesAnyTerm(match[1], FINAL_ORDER_TERMS)));

export const validateCase = async (input: ValidationInput, runSpec: SpecRunner): Promise<ValidationOutcome> => {
  const inventory = buildInventory(input.snapshot);
  const recipe = parsePreconditionSection(input.snapshot);
  const overrides: Record<string, string> = {};
  const tried = new Map<string, Set<string>>();
  const compile = (): CompiledCase => compileCase({
    titleTh: input.title,
    steps: input.stored.steps,
    oracle: input.stored.oracle,
    ...(input.stored.preconditionId ? { preconditionId: input.stored.preconditionId } : {}),
    ...(input.stored.loggedOut ? { loggedOut: true } : {}),
  }, {
    inventory,
    fullSnapshot: input.snapshot,
    ...(recipe ? { preconditions: { [recipe.id]: { lines: recipe.lines } } } : {}),
    locatorOverrides: overrides,
  });

  let compiled = compile();
  const outcome = (status: ValidationStatus, reason: string, runs: number, evidence: string[] = []): ValidationOutcome => ({
    status, reason, script: compiled.script, requiresPlaywrightEngine: compiled.requiresPlaywrightEngine,
    repairedLocators: { ...overrides }, runs, evidence,
  });
  if (!input.allowMutatingTests && clicksFinalOrder(compiled.script)) {
    return outcome("needs_review", "not run: the case clicks an order confirmation/payment button and the job does not allow mutating tests", 0);
  }

  const maxRepairs = input.maxRepairs ?? 2;
  for (let run = 1; ; run += 1) {
    const result = await runSpec(compiled.script);
    if (result.status === "passed") {
      return outcome("verified", Object.keys(overrides).length > 0 ? `passed after auto-repair of ${Object.keys(overrides).join(", ")}` : "passed", run);
    }
    const message = stripAnsi(result.message ?? "").split("\n").slice(0, 4).join(" ").trim();
    if (result.status === "error") return outcome("needs_review", `could not run: ${message || "runner error"}`, run, result.evidence);

    const classification = classifyFailure(compiled.script, result);
    if (classification.locatorProblem) {
      const elementId = failingElementId(compiled, classification, result.message);
      const used = elementId ? (tried.get(elementId) ?? new Set([compiled.locators[elementId]])) : new Set<string>();
      const next = elementId ? alternativeLocators(elementId, inventory, input.snapshot).find((candidate) => !used.has(candidate)) : undefined;
      if (elementId && next && run <= maxRepairs) {
        used.add(next);
        tried.set(elementId, used);
        overrides[elementId] = next;
        compiled = compile();
        continue;
      }
      return outcome("needs_review", `locator not found${elementId ? ` (${elementId})` : ""}${run > 1 ? ` after ${run - 1} repair(s)` : ""}: ${message}`, run, result.evidence);
    }
    if (classification.part === "setup") {
      return outcome("needs_review", `${recipe ? "precondition or navigation" : "navigation"} failed: ${message}`, run, result.evidence);
    }
    if (classification.part === "steps") {
      return outcome("needs_review", `a step failed: ${message}`, run, result.evidence);
    }
    const status = verdictForCheckFailure(input.category);
    return outcome(status, status === "possible_bug"
      ? `the check failed on a ${input.category} case — the site may not handle it: ${message}`
      : `the check failed on a ${input.category} case the site is expected to pass — review the check: ${message}`, run, result.evidence);
  }
};
