/**
 * Runs one spec with Playwright the way test runs do (same pre-login globalSetup and env credentials),
 * for the Phase 8 validation run. Each run gets its own directory under runtime/validation/; the saved
 * login session is deleted after the run, screenshots/traces of failures are kept as evidence.
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { credentialsToTestEnv, redactSecret, type LoginCredentials } from "../credentialService.js";
import { PRE_LOGIN_ENV, PRE_LOGIN_SETUP_FILE, PRE_LOGIN_SETUP_SOURCE, shouldPreLogin } from "../preLoginSetup.js";
import type { SpecRunner, SpecRunResult } from "./validationRun.js";

const SPEC_FILE = "case.spec.ts";

const firstGotoUrl = (script: string): string | null => script.match(/page\.goto\(\s*['"`]([^'"`]+)['"`]/)?.[1] ?? null;

interface JsonError { message?: string; location?: { file?: string; line?: number } }
interface JsonResult { status?: string; error?: JsonError; errors?: JsonError[]; attachments?: Array<{ path?: string }> }
interface JsonSuite { specs?: Array<{ tests?: Array<{ results?: JsonResult[] }> }>; suites?: JsonSuite[] }
interface JsonReport { suites?: JsonSuite[]; errors?: JsonError[] }

/** The single spec's last result from a Playwright JSON report. */
export const readSpecResult = (report: JsonReport): SpecRunResult => {
  const results: JsonResult[] = [];
  const walk = (suite: JsonSuite) => {
    for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) results.push(...(test.results ?? []).slice(-1));
    (suite.suites ?? []).forEach(walk);
  };
  (report.suites ?? []).forEach(walk);
  const result = results[0];
  if (!result) {
    const setupError = report.errors?.[0]?.message;
    return { status: "error", message: setupError ?? "no test result in the report", evidence: [] };
  }
  if (result.status === "passed") return { status: "passed", evidence: [] };
  // On a test timeout, `error` only says "Test timeout ... exceeded"; the entry of `errors` that points into
  // the spec says which call was waiting for which locator.
  const inSpec = (result.errors ?? []).find((item) => item.location?.file?.endsWith(SPEC_FILE));
  const error = inSpec ?? result.error ?? result.errors?.[0];
  const location = [inSpec, result.error, ...(result.errors ?? [])].find((item) => item?.location?.file?.endsWith(SPEC_FILE))?.location;
  return {
    status: "failed",
    message: error?.message ?? `test ${result.status ?? "failed"}`,
    ...(location?.line ? { line: location.line } : {}),
    evidence: (result.attachments ?? []).flatMap((attachment) => (attachment.path ? [attachment.path] : [])),
  };
};

const runPlaywright = (cwd: string, extraEnv: Record<string, string>, timeoutMs: number): Promise<number | null> =>
  new Promise((resolve) => {
    const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["playwright", "test", "--config", "playwright.config.ts"], {
      cwd, shell: true, windowsHide: true, env: { ...process.env, ...extraEnv },
    });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

export const createPlaywrightSpecRunner = (options: {
  credentials?: LoginCredentials | null;
  rootDir?: string;
  testTimeoutMs?: number;
}): SpecRunner => async (script) => {
  const runDir = path.join(options.rootDir ?? path.resolve(process.cwd(), "runtime", "validation"), randomUUID());
  await fs.mkdir(path.join(runDir, "tests"), { recursive: true });
  await fs.writeFile(path.join(runDir, "tests", SPEC_FILE), script, "utf-8");
  const preLoginUrl = shouldPreLogin(script, options.credentials) ? firstGotoUrl(script) : null;
  const statePath = path.join(runDir, ".auth", "state.json");
  if (preLoginUrl) {
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(path.join(runDir, PRE_LOGIN_SETUP_FILE), PRE_LOGIN_SETUP_SOURCE, "utf-8");
  }
  const testTimeout = options.testTimeoutMs ?? 60_000;
  await fs.writeFile(path.join(runDir, "playwright.config.ts"), [
    "import { defineConfig } from '@playwright/test';",
    "export default defineConfig({",
    "  testDir: './tests',",
    `  timeout: ${testTimeout},`,
    "  retries: 0,",
    "  workers: 1,",
    ...(preLoginUrl ? [`  globalSetup: './${PRE_LOGIN_SETUP_FILE}',`] : []),
    "  use: {",
    // A locator that finds nothing fails in seconds, not at the test timeout: auto-repair reruns stay short.
    "    actionTimeout: 15_000,",
    "    screenshot: 'only-on-failure',",
    "    trace: 'retain-on-failure',",
    ...(preLoginUrl ? [`    storageState: process.env.${PRE_LOGIN_ENV.statePath},`] : []),
    "  },",
    "  reporter: [['json', { outputFile: './report.json' }]],",
    "  outputDir: './test-results',",
    "});",
    "",
  ].join("\n"), "utf-8");

  try {
    await runPlaywright(runDir, {
      ...credentialsToTestEnv(options.credentials),
      ...(preLoginUrl ? { [PRE_LOGIN_ENV.url]: preLoginUrl, [PRE_LOGIN_ENV.statePath]: statePath } : {}),
    }, testTimeout + 120_000);
    const raw = await fs.readFile(path.join(runDir, "report.json"), "utf-8").catch(() => "");
    if (!raw) return { status: "error", message: "Playwright wrote no report", evidence: [] };
    const result = readSpecResult(JSON.parse(raw) as JsonReport);
    return result.message ? { ...result, message: redactSecret(result.message, options.credentials) } : result;
  } finally {
    // The saved session is a live login; never leave it on disk.
    await fs.rm(path.join(runDir, ".auth"), { recursive: true, force: true });
  }
};
