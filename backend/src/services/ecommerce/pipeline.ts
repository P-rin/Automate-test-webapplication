/**
 * Entry point of the GENERATION_MODE=ecommerce pipeline (see 0Context fot this project/ECOMMERCE_TESTGEN_CONTEXT.md §4.1).
 *
 * Implemented stages:
 *   Phase 1 — compact_snapshot: each snapshot is compacted into an ElementInventory and the planner sees the
 *             compact text instead of the tail-truncated full snapshot. Nav/footer seen on an earlier page of
 *             the job is hidden on later pages.
 *   Phase 3 — classify_elements: rule-based element purposes (search, quantity, add_to_cart, ...) are shown in
 *             the compact text; DOM attributes come from snapshotService in ecommerce mode.
 * Planning itself still uses the legacy one-case-at-a-time planner until candidate selection (Phases 2–4).
 * The full snapshot is still what gets stored and what script generation uses.
 */
import type { GenerationMode } from "../../config/env.js";
import { processSnapshotTestPlans } from "../ollamaService.js";
import { classifyInventory } from "./elementClassifier.js";
import {
  buildInventory,
  compactSnapshotBudget,
  findPromptReferenceMisses,
  navigationKeysOf,
  referencedLabels,
  renderInventoryForPrompt,
} from "./snapshotCompactor.js";

/** Plans the cases of one snapshot; identical signature for both modes so the job loop stays mode-agnostic. */
export type SnapshotPlanner = typeof processSnapshotTestPlans;

export type EcommerceStage = "compact_snapshot" | "classify_elements";

export interface SnapshotPlannerSelection {
  mode: GenerationMode;
  planner: SnapshotPlanner;
  /** E-commerce stages active in this planner ([] for legacy). */
  stages: EcommerceStage[];
}

const DEFAULT_MAX_PROMPT_CHARS = 14000;

/**
 * One planner per job: it remembers which nav/footer elements earlier snapshots already showed the model.
 * Falls back to the full snapshot when the compactor finds nothing (e.g. a snapshot without a YAML tree).
 */
export const createEcommerceSnapshotPlanner = (): SnapshotPlanner => {
  const sentNavigation = new Set<string>();

  return async (payload, snapshot, options, persistCase, acceptanceCriteria, coveredAcIds, allowMutatingTests, coverage, hooks) => {
    const built = buildInventory(snapshot, { previouslySentNavigation: sentNavigation });
    if (built.elements.length === 0) {
      return processSnapshotTestPlans(payload, snapshot, options, persistCase, acceptanceCriteria, coveredAcIds, allowMutatingTests, coverage, hooks);
    }
    // Rules only here: the purposes label the prompt; the LLM fallback for ambiguous elements runs where
    // purposes drive templates (Phase 4), so planning does not pay for questions nobody consumes yet.
    const { inventory } = classifyInventory(built);
    const compact = renderInventoryForPrompt(inventory, compactSnapshotBudget(options.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS));
    for (const key of navigationKeysOf(inventory)) sentNavigation.add(key);

    const auditedPersist: typeof persistCase = async (plan, sequence) => {
      for (const miss of findPromptReferenceMisses(referencedLabels(plan), compact, snapshot)) {
        console.warn("[ecommerce compact_snapshot] plan references a label missing from the compact prompt", {
          page: inventory.pageUrl,
          planTitle: plan.title,
          label: miss.text,
          inFullSnapshot: miss.inFullSnapshot,
        });
        try {
          options.metricsHooks?.onPromptReferenceMiss?.(miss);
        } catch {
          // Metrics must never break planning.
        }
      }
      return persistCase(plan, sequence);
    };

    return processSnapshotTestPlans(
      { ...payload, accessibilitySnapshot: compact },
      compact,
      options,
      auditedPersist,
      acceptanceCriteria,
      coveredAcIds,
      allowMutatingTests,
      coverage,
      hooks,
    );
  };
};

/** Call once per job: the ecommerce planner keeps per-job state. */
export const selectSnapshotPlanner = (mode: GenerationMode): SnapshotPlannerSelection =>
  mode === "ecommerce"
    ? { mode, planner: createEcommerceSnapshotPlanner(), stages: ["compact_snapshot", "classify_elements"] }
    : { mode: "legacy", planner: processSnapshotTestPlans, stages: [] };
