/**
 * Phase 4 smoke test: runs the GENERATION_MODE=ecommerce snapshot planner with the real planner model on captured
 * fixtures and prints the selected cases, prompt sizes and timings. Needs Ollama; not part of `npm test`.
 *
 * Usage (from backend/): npx tsx scripts/smoke-ecommerce-planner.ts [fixture ...] [--model=qwen3.5:4b] [--out=runtime/smoke-planner.json]
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TestPlan } from "../src/types.js";
import { PlanCoverageRegistry } from "../src/services/planDedup.js";
import { selectSnapshotPlanner } from "../src/services/ecommerce/pipeline.js";
import type { LlmCallMetric, CandidateStageMetric } from "../src/services/generationMetrics.js";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const fixtures = args.filter((arg) => !arg.startsWith("--"));
const model = option("model", "qwen3.5:4b");
const out = path.resolve(process.cwd(), option("out", "runtime/smoke-planner.json"));
const names = fixtures.length ? fixtures : ["saucedemo/inventory", "react-cart-web/product-detail-in-stock", "react-cart-web/login"];

const planner = selectSnapshotPlanner("ecommerce", { hasLogin: true }).planner;
const coverage = new PlanCoverageRegistry();
const report: Array<Record<string, unknown>> = [];
for (const name of names) {
  const snapshot = await readFile(path.resolve(process.cwd(), "src/services/ecommerce/__fixtures__", `${name}.txt`), "utf8");
  const calls: LlmCallMetric[] = [];
  const stages: CandidateStageMetric[] = [];
  const plans: TestPlan[] = [];
  const started = Date.now();
  await planner(
    { projectName: "smoke", targetUrl: "", specification: "", accessibilitySnapshot: snapshot },
    snapshot,
    {
      plannerModel: model,
      numCtx: 8192,
      metricsHooks: { onLlmCall: (call) => calls.push(call), onCandidateStage: (stage) => stages.push(stage) },
    },
    async (plan) => {
      plans.push(plan);
      return true;
    },
    [],
    new Set(),
    false,
    coverage,
  );
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`\n=== ${name}: ${plans.length} cases in ${seconds}s, ${calls.length} LLM calls, prompt chars ${calls.map((call) => call.promptChars).join("/")}`);
  console.log(`    candidates ${JSON.stringify(stages[0])}`);
  for (const plan of plans) console.log(`  - [${plan.category}] ${plan.title}  (${String(plan.structured?.origin)})`);
  report.push({ name, seconds, calls, stage: stages[0], plans });
}
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(report, null, 2), "utf8");
console.log(`\nSaved ${out}`);
