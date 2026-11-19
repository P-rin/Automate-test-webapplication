/**
 * Phase 7 smoke test, end to end on the real sites:
 *   1. discoverPreconditionSnapshots (Playwright MCP, isolated session) captures the filled cart/checkout states,
 *      starting from the captured fixtures as "discovered" pages;
 *   2. every template candidate of those states is compiled with its recipe (compileStoredCase);
 *   3. the specs run with Playwright through the runner's pre-login globalSetup, one at a time.
 * Specs that click an order confirmation/payment button are refused (none should exist).
 *
 * Usage (from backend/, credentials from env only):
 *   GENERATION_MODE=ecommerce TEST_EMAIL=... TEST_PASSWORD=... SAUCE_USERNAME=... SAUCE_PASSWORD=... \
 *     npx tsx scripts/smoke-preconditions.ts [--rcw=http://localhost:5173] [--site=rcw|sauce]
 * Output: runtime/smoke-preconditions/ (gitignored; snapshots may contain the account's profile data).
 */
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { matchesAnyTerm } from "../src/services/ecommerce/keywords.js";
import { classifySnapshot, discoverPreconditionSnapshots } from "../src/services/ecommerce/preconditionDiscovery.js";
import { parsePreconditionSection } from "../src/services/ecommerce/preconditions.js";
import { compileStoredCase } from "../src/services/ecommerce/storedCase.js";
import { FINAL_ORDER_TERMS } from "../src/services/ecommerce/templates/helpers.js";
import { generateCandidates } from "../src/services/ecommerce/templates/index.js";
import { PRE_LOGIN_ENV, PRE_LOGIN_SETUP_FILE, PRE_LOGIN_SETUP_SOURCE } from "../src/services/preLoginSetup.js";

const rcwBase = (process.argv.find((arg) => arg.startsWith("--rcw="))?.slice(6) ?? "http://localhost:5173").replace(/\/$/, "");
const onlySite = process.argv.find((arg) => arg.startsWith("--site="))?.slice(7);
const fixturesDir = path.resolve(process.cwd(), "src/services/ecommerce/__fixtures__");
const outDir = path.resolve(process.cwd(), "runtime/smoke-preconditions");

const SITES = [
  {
    key: "rcw",
    targetUrl: `${rcwBase}/`,
    fixtures: ["react-cart-web/login", "react-cart-web/catalog", "react-cart-web/cart-empty"],
    user: process.env.TEST_EMAIL ?? "",
    password: process.env.TEST_PASSWORD ?? "",
  },
  {
    key: "sauce",
    targetUrl: "https://www.saucedemo.com/",
    fixtures: ["saucedemo/login", "saucedemo/inventory", "saucedemo/cart-empty"],
    user: process.env.SAUCE_USERNAME ?? "",
    password: process.env.SAUCE_PASSWORD ?? "",
  },
].filter((site) => !onlySite || site.key === onlySite);

const clicksFinalOrder = (script: string): boolean => script.split("\n").some((line) =>
  /\.click\(\)/.test(line) && [...line.matchAll(/name: "([^"]+)"/g)].some((match) => matchesAnyTerm(match[1], FINAL_ORDER_TERMS)));

await rm(outDir, { recursive: true, force: true });
for (const site of SITES) {
  const runDir = path.join(outDir, site.key);
  await mkdir(path.join(runDir, "tests"), { recursive: true });
  const discovered = await Promise.all(site.fixtures.map(async (name) => ({
    title: name,
    snapshot: (await readFile(path.join(fixturesDir, `${name}.txt`), "utf8")).replaceAll("http://localhost:5173", rcwBase),
  })));

  console.log(`\n=== ${site.key}: capturing precondition states...`);
  const started = Date.now();
  const result = await discoverPreconditionSnapshots(site.targetUrl, "", discovered, { username: site.user, password: site.password });
  console.log(`captured ${result.snapshots.length} state snapshot(s) in ${Math.round((Date.now() - started) / 1000)}s`);
  for (const note of result.notes) console.log(`  note: ${note}`);

  let specCount = 0;
  for (const [index, state] of result.snapshots.entries()) {
    const recipe = parsePreconditionSection(state.snapshot)!;
    const page = classifySnapshot(state.snapshot);
    await writeFile(path.join(runDir, `state-${index + 1}-${recipe.stateLabel}.txt`), state.snapshot, "utf8");
    const { candidates, notes } = generateCandidates({
      inventory: page.inventory, pageType: page.pageType, allowMutatingTests: false, availablePreconditions: [recipe.id],
      statePreconditionId: recipe.id, credentials: { hasLogin: true },
    });
    console.log(`  ${recipe.stateLabel} (${page.pageType}): ${candidates.length} candidates${notes.length ? ` — ${notes.join("; ")}` : ""}`);
    for (const candidate of candidates) {
      try {
        const compiled = compileStoredCase(candidate.titleTh, {
          version: 1, steps: candidate.steps, oracle: candidate.oracle,
          ...(candidate.preconditionId ? { preconditionId: candidate.preconditionId } : {}),
          ...(candidate.loggedOut ? { loggedOut: true } : {}),
        }, state.snapshot);
        if (clicksFinalOrder(compiled.script)) {
          console.log(`  REFUSED ${candidate.templateId}: clicks an order button`);
          continue;
        }
        specCount += 1;
        const file = `${recipe.stateLabel}__${candidate.id}_${candidate.templateId}.spec.ts`;
        await writeFile(path.join(runDir, "tests", file), compiled.script, "utf8");
      } catch (error) {
        console.log(`  COMPILE-FAIL ${candidate.templateId}: ${(error as Error).message.slice(0, 200)}`);
      }
    }
  }
  if (specCount === 0) continue;

  await writeFile(path.join(runDir, PRE_LOGIN_SETUP_FILE), PRE_LOGIN_SETUP_SOURCE, "utf8");
  await writeFile(path.join(runDir, "playwright.config.ts"), [
    "import { defineConfig } from '@playwright/test';",
    "export default defineConfig({",
    "  testDir: './tests',",
    "  timeout: 90_000,",
    "  workers: 1,",
    `  globalSetup: './${PRE_LOGIN_SETUP_FILE}',`,
    `  use: { storageState: process.env.${PRE_LOGIN_ENV.statePath} },`,
    "  reporter: [['json', { outputFile: './report.json' }]],",
    "  outputDir: './test-results',",
    "});",
    "",
  ].join("\n"), "utf8");
  const statePath = path.join(runDir, ".auth-state.json");
  console.log(`  running ${specCount} specs...`);
  spawnSync("npx", ["playwright", "test"], {
    cwd: runDir, stdio: "ignore", shell: true,
    env: { ...process.env, TEST_EMAIL: site.user, TEST_PASSWORD: site.password, [PRE_LOGIN_ENV.url]: site.targetUrl, [PRE_LOGIN_ENV.statePath]: statePath },
  });
  // The saved session is a live login; don't leave it on disk.
  await rm(statePath, { force: true });

  interface JsonSpec { file: string; tests: Array<{ results: Array<{ status: string; error?: { message?: string } }> }> }
  interface JsonSuite { specs?: JsonSpec[]; suites?: JsonSuite[] }
  const report = JSON.parse(await readFile(path.join(runDir, "report.json"), "utf8").catch(() => "{\"suites\":[]}")) as { suites: JsonSuite[] };
  const specs: JsonSpec[] = [];
  const walk = (suite: JsonSuite) => {
    specs.push(...(suite.specs ?? []));
    (suite.suites ?? []).forEach(walk);
  };
  report.suites.forEach(walk);
  let passed = 0;
  for (const spec of specs.sort((a, b) => a.file.localeCompare(b.file))) {
    const result = spec.tests[0]?.results.at(-1);
    if (result?.status === "passed") passed += 1;
    const message = (result?.error?.message ?? "").replace(/\u001b\[[0-9;]*m/g, "").split("\n").filter(Boolean).slice(0, 3).join(" | ");
    console.log(`  ${(result?.status ?? "missing").toUpperCase().padEnd(8)} ${spec.file}${message ? `\n           ${message.slice(0, 280)}` : ""}`);
  }
  console.log(`  ${site.key}: ${passed}/${specs.length} passed`);
}
