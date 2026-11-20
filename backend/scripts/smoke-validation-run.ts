/**
 * Phase 8 smoke test: the validation run (with auto-repair) on real sites, for
 *   - the cases the real model planned in the Phase 4 smoke (runtime/smoke-planner.json, incl. exploratory), and
 *   - template cases of the cart/checkout states captured by the Phase 7 smoke (runtime/smoke-preconditions/).
 * Prints each case's verdict (verified / oracle_unreliable / possible_bug / needs_review) and reason.
 * Cases that click a wishlist button are skipped (they would change the account's wishlist).
 *
 * Usage (from backend/, after smoke-ecommerce-planner.ts and smoke-preconditions.ts; credentials from env only):
 *   TEST_EMAIL=... TEST_PASSWORD=... SAUCE_USERNAME=... SAUCE_PASSWORD=... npx tsx scripts/smoke-validation-run.ts [--per-state=3] [--only=source-substring]
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LoginCredentials } from "../src/services/credentialService.js";
import { matchesAnyTerm, WISHLIST_TERMS } from "../src/services/ecommerce/keywords.js";
import { classifySnapshot } from "../src/services/ecommerce/preconditionDiscovery.js";
import { parsePreconditionSection } from "../src/services/ecommerce/preconditions.js";
import { createPlaywrightSpecRunner } from "../src/services/ecommerce/specRunner.js";
import { parseStoredStructuredCase, type StoredStructuredCase } from "../src/services/ecommerce/storedCase.js";
import { generateCandidates } from "../src/services/ecommerce/templates/index.js";
import { buildInventory } from "../src/services/ecommerce/snapshotCompactor.js";
import { validateCase } from "../src/services/ecommerce/validationRun.js";

const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice(7);
const perState = Number(process.argv.find((arg) => arg.startsWith("--per-state="))?.slice(12) ?? 3);
const fixturesDir = path.resolve(process.cwd(), "src/services/ecommerce/__fixtures__");
const runtime = path.resolve(process.cwd(), "runtime");

const credentials: Record<string, LoginCredentials> = {
  rcw: { username: process.env.TEST_EMAIL ?? "", password: process.env.TEST_PASSWORD ?? "" },
  sauce: { username: process.env.SAUCE_USERNAME ?? "", password: process.env.SAUCE_PASSWORD ?? "" },
};
const siteOf = (name: string) => (name.startsWith("saucedemo") || name.startsWith("sauce") ? "sauce" : "rcw");

interface Job { site: string; source: string; title: string; category: string; stored: StoredStructuredCase; snapshot: string }
const jobs: Job[] = [];

const clicksWishlist = (stored: StoredStructuredCase, snapshot: string): boolean => {
  const inventory = buildInventory(snapshot);
  return stored.steps.some((step) => step.kind === "click"
    && matchesAnyTerm(inventory.elements.find((element) => element.id === step.elementId)?.name ?? "", WISHLIST_TERMS));
};

const planned = JSON.parse(await readFile(path.join(runtime, "smoke-planner.json"), "utf8")) as Array<{ name: string; plans: Array<{ title: string; category?: string; structured?: unknown }> }>;
for (const page of planned) {
  const snapshot = await readFile(path.join(fixturesDir, `${page.name}.txt`), "utf8");
  for (const plan of page.plans) {
    const stored = parseStoredStructuredCase(plan.structured);
    if (!stored) continue;
    if (clicksWishlist(stored, snapshot)) {
      console.log(`skip (wishlist): ${plan.title}`);
      continue;
    }
    const origin = String((plan.structured as Record<string, unknown>).origin ?? "");
    jobs.push({ site: siteOf(page.name), source: `${page.name} ${origin}`, title: plan.title, category: plan.category ?? "", stored, snapshot });
  }
}

for (const site of ["rcw", "sauce"]) {
  const dir = path.join(runtime, "smoke-preconditions", site);
  for (const file of (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith(".txt")).sort()) {
    const snapshot = await readFile(path.join(dir, file), "utf8");
    const recipe = parsePreconditionSection(snapshot);
    if (!recipe) continue;
    const page = classifySnapshot(snapshot);
    const { candidates } = generateCandidates({
      inventory: page.inventory, pageType: page.pageType, allowMutatingTests: false, availablePreconditions: [recipe.id],
      statePreconditionId: recipe.id, credentials: { hasLogin: true },
    });
    // One case per template first, so the sample covers different oracles.
    const byTemplate = [...new Map(candidates.map((candidate) => [candidate.templateId, candidate])).values()].slice(0, perState);
    for (const candidate of byTemplate) {
      jobs.push({
        site, source: `${site}/${recipe.stateLabel} template:${candidate.templateId}`, title: candidate.titleTh, category: candidate.category, snapshot,
        stored: { version: 1, steps: candidate.steps, oracle: candidate.oracle, ...(candidate.preconditionId ? { preconditionId: candidate.preconditionId } : {}) },
      });
    }
  }
}

if (only) jobs.splice(0, jobs.length, ...jobs.filter((job) => job.source.includes(only)));
console.log(`Validating ${jobs.length} cases...`);
const results: Array<Record<string, unknown>> = [];
for (const job of jobs) {
  const started = Date.now();
  const outcome = await validateCase({ title: job.title, category: job.category, stored: job.stored, snapshot: job.snapshot, allowMutatingTests: false },
    createPlaywrightSpecRunner({ credentials: credentials[job.site] }));
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`${outcome.status.padEnd(17)} ${job.source} | ${job.title} (${outcome.runs} run(s), ${seconds}s)\n${" ".repeat(18)}${outcome.reason.replace(/\s+/g, " ").slice(0, 260)}`);
  results.push({ source: job.source, title: job.title, category: job.category, status: outcome.status, reason: outcome.reason, runs: outcome.runs, repaired: outcome.repairedLocators, seconds });
}
const counts = results.reduce<Record<string, number>>((all, result) => ({ ...all, [String(result.status)]: (all[String(result.status)] ?? 0) + 1 }), {});
console.log(`\n${JSON.stringify(counts)}`);
await writeFile(path.join(runtime, "smoke-validation-run.json"), JSON.stringify(results, null, 2), "utf8");
