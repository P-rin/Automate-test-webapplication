/**
 * Structured steps + oracle stored on a generation case (Firestore `generationJobs/{id}/cases/{caseId}.structured`),
 * so script generation compiles them with code instead of asking the script model, and auto-repair (Phase 8)
 * can recompile without the LLM. Element IDs refer to buildInventory(snapshot) of the case's stored snapshot,
 * which is deterministic for the same snapshot text.
 */
import { validateGeneratedScript } from "../ollamaService.js";
import { compileCase, type CompiledCase, type CompiledSteps } from "./scriptCompiler.js";
import { buildInventory } from "./snapshotCompactor.js";
import type { Oracle, StructuredStep } from "./types.js";

export const STRUCTURED_CASE_VERSION = 1;

export interface StoredStructuredCase {
  version: typeof STRUCTURED_CASE_VERSION;
  steps: StructuredStep[];
  oracle: Oracle;
  preconditionId?: string;
  loggedOut?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Returns the stored structure when present and well-formed; legacy cases have none. */
export const parseStoredStructuredCase = (value: unknown): StoredStructuredCase | undefined => {
  if (!isRecord(value) || value.version !== STRUCTURED_CASE_VERSION) return undefined;
  if (!Array.isArray(value.steps) || !value.steps.every((step) => isRecord(step) && typeof step.kind === "string")) return undefined;
  if (!isRecord(value.oracle) || typeof value.oracle.kind !== "string") return undefined;
  return {
    version: STRUCTURED_CASE_VERSION,
    steps: value.steps as StructuredStep[],
    oracle: value.oracle as Oracle,
    ...(typeof value.preconditionId === "string" ? { preconditionId: value.preconditionId } : {}),
    ...(value.loggedOut === true ? { loggedOut: true } : {}),
  };
};

/** Compiles a stored case against the snapshot it was planned on; the script is validated like an LLM script. */
export const compileStoredCase = (
  title: string,
  stored: StoredStructuredCase,
  snapshot: string,
  preconditions?: Record<string, CompiledSteps>,
): CompiledCase => {
  const inventory = buildInventory(snapshot);
  const compiled = compileCase(
    {
      titleTh: title,
      steps: stored.steps,
      oracle: stored.oracle,
      ...(stored.preconditionId ? { preconditionId: stored.preconditionId } : {}),
      ...(stored.loggedOut ? { loggedOut: true } : {}),
    },
    { inventory, fullSnapshot: snapshot, ...(preconditions ? { preconditions } : {}) },
  );
  validateGeneratedScript(compiled.script);
  return compiled;
};
