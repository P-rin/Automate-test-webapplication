/**
 * Entry point of the GENERATION_MODE=ecommerce pipeline (see 0Context fot this project/ECOMMERCE_TESTGEN_CONTEXT.md §4.1).
 *
 * Per snapshot:
 *   1. compact_snapshot   (Phase 1) ElementInventory E1.. + compact text; nav seen earlier in the job is hidden.
 *   2. classify_elements  (Phase 3) element purposes by rules; ambiguous ones asked as multiple choice.
 *   3. classify_page      (Phase 4a) page type from URL, titles and composition.
 *   4. template_candidates(Phase 4b/c) code-built candidate cases with steps + oracle.
 *   5. llm_selection      (Phase 4d) keep/drop, AC mapping and Thai titles; mandatory always kept; fallback on failure.
 *   6. exploratory        (Phase 4e) up to 2 extra cases with element-ID-constrained steps.
 *   7. dedup              PlanCoverageRegistry, shared with the whole job.
 * Every stored case carries `structured` (steps + oracle), so scripts are compiled by code (Phase 6).
 * Snapshots the compactor cannot parse fall back to the legacy planner.
 */
import type { GenerationMode } from "../../config/env.js";
import type { TestPlan } from "../../types.js";
import type { Oracle, StructuredStep } from "./types.js";
import { createRunContext, processSnapshotTestPlans, type LlmGenerationOptions } from "../ollamaService.js";
import { PlanCoverageRegistry } from "../planDedup.js";
import { candidateToPlan, exploratoryToPlan, proposeExploratoryCases } from "./casePlan.js";
import { selectCandidates, type AskJson } from "./candidateSelector.js";
import { classifyInventory, resolveAmbiguousPurposes } from "./elementClassifier.js";
import { classifyPageType } from "./pageClassifier.js";
import { parsePreconditionSection } from "./preconditions.js";
import { checkCaseQuality } from "./qualityGate.js";
import { buildInventory, compactSnapshotBudget, navigationKeysOf, renderInventoryForPrompt } from "./snapshotCompactor.js";
import { generateCandidates } from "./templates/index.js";

/** Plans the cases of one snapshot; identical signature for both modes so the job loop stays mode-agnostic. */
export type SnapshotPlanner = typeof processSnapshotTestPlans;

export type EcommerceStage =
  | "compact_snapshot" | "classify_elements" | "classify_page" | "template_candidates" | "llm_selection" | "exploratory";

export const ECOMMERCE_STAGES: EcommerceStage[] = [
  "compact_snapshot", "classify_elements", "classify_page", "template_candidates", "llm_selection", "exploratory",
];

export interface SnapshotPlannerSelection {
  mode: GenerationMode;
  planner: SnapshotPlanner;
  /** E-commerce stages active in this planner ([] for legacy). */
  stages: EcommerceStage[];
}

export interface EcommercePlannerConfig {
  /** The job has login credentials (templates may log in with {{env.TEST_EMAIL}}). */
  hasLogin: boolean;
  /** Sample URLs of pages that page discovery marked as requiring login. */
  pagesRequiringLogin?: string[];
  /** Precondition recipes the job can run (Phase 7). */
  availablePreconditions?: string[];
  /** Overrides the LLM call (tests); defaults to the planner model with JSON-schema output. */
  ask?: AskJson;
}

const DEFAULT_MAX_PROMPT_CHARS = 14000;
const SYSTEM_INSTRUCTION = "You help plan UI tests for an online shop. Answer only with JSON that matches the given schema.";

const pathOf = (url: string): string => {
  try {
    const parsed = new URL(url);
    return parsed.pathname.replace(/\/$/, "") || "/";
  } catch {
    return url;
  }
};

const plannerAsk = (options: LlmGenerationOptions): AskJson => {
  const run = createRunContext({ ...options, usePlaywrightTools: false }, "planner");
  return (prompt, schema) => run(prompt, SYSTEM_INSTRUCTION, schema);
};

/**
 * One planner per job: it remembers which nav/footer elements earlier snapshots already showed the model.
 */
export const createEcommerceSnapshotPlanner = (config: EcommercePlannerConfig = { hasLogin: false }): SnapshotPlanner => {
  const sentNavigation = new Set<string>();
  const loginPaths = new Set((config.pagesRequiringLogin ?? []).map(pathOf));
  /** Template cases are de-duplicated exactly (template + element label + variant) across the job's pages. */
  const templateKeys = new Set<string>();

  return async (
    payload,
    snapshot,
    options,
    persistCase,
    acceptanceCriteriaOrKnownAcIds = [],
    coveredAcIds = new Set(),
    allowMutatingTests = true,
    coverage = new PlanCoverageRegistry(),
    hooks = {},
  ) => {
    const recipe = parsePreconditionSection(snapshot);
    const builtRaw = buildInventory(snapshot, { previouslySentNavigation: sentNavigation });
    const built = recipe ? { ...builtRaw, stateLabel: recipe.stateLabel } : builtRaw;
    if (built.elements.length === 0) {
      return processSnapshotTestPlans(payload, snapshot, options, persistCase, acceptanceCriteriaOrKnownAcIds, coveredAcIds, allowMutatingTests, coverage, hooks);
    }
    const ask = config.ask ?? plannerAsk(options);
    const maxPromptChars = options.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS;
    const criteria = Array.isArray(acceptanceCriteriaOrKnownAcIds) ? acceptanceCriteriaOrKnownAcIds : [];

    // Purposes by rules -> page type -> purposes again with the page type -> LLM for what stays ambiguous.
    const firstPass = classifyInventory(built);
    const pageType = classifyPageType(firstPass.inventory).pageType;
    const secondPass = classifyInventory({ ...firstPass.inventory, pageType }, pageType);
    let inventory = secondPass.inventory;
    try {
      inventory = (await resolveAmbiguousPurposes(secondPass, ask, pageType)).inventory;
    } catch (error) {
      console.warn("[ecommerce] purpose fallback failed; keeping generic purposes", error instanceof Error ? error.message : error);
    }
    const pageText = renderInventoryForPrompt(inventory, compactSnapshotBudget(maxPromptChars));
    for (const key of navigationKeysOf(inventory)) sentNavigation.add(key);

    const generation = generateCandidates({
      inventory,
      pageType,
      allowMutatingTests,
      availablePreconditions: [...new Set([...(config.availablePreconditions ?? []), ...(recipe ? [recipe.id] : [])])],
      ...(recipe ? { statePreconditionId: recipe.id } : {}),
      credentials: { hasLogin: config.hasLogin },
      pageRequiresLogin: loginPaths.has(pathOf(inventory.pageUrl)),
    });
    for (const note of generation.notes) console.info(`[ecommerce] ${inventory.pageUrl}: ${note}`);

    let planCount = 0;
    let qualityRejected = 0;
    const persist = async (plan: TestPlan): Promise<boolean> => {
      const origin = String(plan.structured?.origin ?? "");
      // Phase 8a: drop cases that cannot tell a working site from a broken one, or are unsafe to run.
      const quality = checkCaseQuality({
        category: plan.category ?? "",
        expectedResult: plan.expectedResult ?? "",
        steps: Array.isArray(plan.structured?.steps) ? plan.structured.steps as StructuredStep[] : [],
        ...(plan.structured?.oracle ? { oracle: plan.structured.oracle as Oracle } : {}),
        inventory,
        allowMutatingTests,
      });
      if (!quality.accepted) {
        qualityRejected += 1;
        console.info(`[ecommerce] quality gate dropped "${plan.title}" (${origin}): ${quality.issues.join(", ")}`);
        return false;
      }
      // Template variants are exact ("sort=name_asc" vs "sort=name_desc" are different cases), so the fuzzy
      // registry check that suits free-text LLM cases is used only for exploratory ones.
      const templateKey = origin.startsWith("template:") ? `${origin}|${plan.targetElement ?? ""}|${plan.inputVariant ?? ""}` : undefined;
      const coversNewAc = (plan.requirementIds ?? []).some((id) => !coveredAcIds.has(id));
      const duplicateOf = templateKey
        ? (templateKeys.has(templateKey) ? templateKey : undefined)
        : coverage.findDuplicate(plan, { titleOnly: coversNewAc });
      if (duplicateOf !== undefined) {
        try {
          hooks.onDuplicate?.(plan, duplicateOf);
        } catch {
          // Metrics must never break planning.
        }
        return false;
      }
      if (!(await persistCase(plan, planCount + 1))) return false;
      if (templateKey) templateKeys.add(templateKey);
      coverage.add(plan);
      for (const id of plan.requirementIds ?? []) coveredAcIds.add(id);
      planCount += 1;
      return true;
    };

    const selection = generation.candidates.length > 0
      ? await selectCandidates({ candidates: generation.candidates, inventory, acceptanceCriteria: criteria, coveredAcIds, pageText, maxPromptChars: 6000 }, ask)
      : { selections: [], stats: { calls: 0, failedCalls: 0, fallbackCandidates: 0, forcedByMandatory: 0, issues: [] } };
    const candidateById = new Map(generation.candidates.map((candidate) => [candidate.id, candidate]));
    let kept = 0;
    for (const choice of selection.selections) {
      const candidate = candidateById.get(choice.candidateId);
      if (!candidate || !choice.keep) continue;
      kept += 1;
      await persist(candidateToPlan(candidate, choice, inventory, pageType));
    }

    const exploratory = await proposeExploratoryCases({
      inventory,
      pageText,
      acceptanceCriteria: criteria,
      coveredAcIds,
      coveredCases: () => coverage.coveredCases(),
      allowMutatingTests,
      maxPromptChars: 6000,
    }, ask);
    let exploratoryAccepted = 0;
    for (const [index, exploratoryCase] of exploratory.cases.entries()) {
      if (await persist(exploratoryToPlan(exploratoryCase, inventory, pageType, index + 1))) exploratoryAccepted += 1;
    }

    try {
      options.metricsHooks?.onCandidateStage?.({
        generated: generation.candidates.length,
        kept,
        forcedByMandatory: selection.stats.forcedByMandatory,
        byFallback: selection.stats.fallbackCandidates,
        exploratoryAccepted,
        exploratoryRejected: exploratory.rejected.length,
        qualityRejected,
      });
    } catch {
      // Metrics must never break planning.
    }
    return { status: "complete", planCount };
  };
};

/** Call once per job: the ecommerce planner keeps per-job state. */
export const selectSnapshotPlanner = (mode: GenerationMode, config?: EcommercePlannerConfig): SnapshotPlannerSelection =>
  mode === "ecommerce"
    ? { mode, planner: createEcommerceSnapshotPlanner(config), stages: [...ECOMMERCE_STAGES] }
    : { mode: "legacy", planner: processSnapshotTestPlans, stages: [] };
