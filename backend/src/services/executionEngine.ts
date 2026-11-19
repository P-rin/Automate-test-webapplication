/**
 * Choosing the execution engine for a run.
 *
 * Execution currently always uses the Playwright runner (MCP replay is kept for generation only). Cases
 * compiled with computed oracles (GENERATION_MODE=ecommerce, Phase 5) are flagged requiresPlaywrightEngine
 * because the MCP action parser would skip their assertions; if MCP execution is enabled again, a run
 * that contains such a case must still use Playwright.
 */
export type ExecutionEngine = "playwright" | "mcp";

export interface EngineCase {
  id: string;
  requiresPlaywrightEngine?: boolean;
}

export interface EngineResolution {
  engineRequested: ExecutionEngine;
  engineUsed: ExecutionEngine;
  fallbackReason: string;
}

export const asExecutionEngine = (value: string | undefined): ExecutionEngine => (value === "mcp" ? "mcp" : "playwright");

export const resolveExecutionEngine = (
  requested: ExecutionEngine | undefined,
  defaultEngine: string | undefined,
  cases: readonly EngineCase[] = [],
): EngineResolution => {
  const engineRequested = requested ?? asExecutionEngine(defaultEngine);
  const engineUsed: ExecutionEngine = "playwright";
  if (engineRequested !== "mcp") return { engineRequested, engineUsed, fallbackReason: "" };
  const needPlaywright = cases.filter((testCase) => testCase.requiresPlaywrightEngine).map((testCase) => testCase.id);
  const reasons = [
    ...(needPlaywright.length > 0 ? [`Cases ${needPlaywright.join(", ")} use computed assertions that only the Playwright engine runs.`] : []),
    "Execution now uses Playwright runtime. MCP remains enabled for generation only.",
  ];
  return { engineRequested, engineUsed, fallbackReason: reasons.join(" ") };
};
