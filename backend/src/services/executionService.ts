import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { db, FieldValue } from "../lib/firestore.js";
import { env } from "../config/env.js";
import { getTestCasesByIds, updateTestCaseStatus } from "./testCaseService.js";
import type { ExecutionTestCase } from "./testCaseService.js";

const runtimeRoot = path.resolve(process.cwd(), "runtime");
const screenshotRoot = path.resolve(process.cwd(), "storage", "screenshots");

interface PlaywrightJsonReport {
  stats?: {
    duration?: number;
  };
  suites?: Array<{
    specs?: Array<{
      tests?: Array<{
        results?: Array<{
          status?: string;
          errors?: Array<{ message?: string; stack?: string }>;
        }>;
      }>;
    }>;
    suites?: Array<any>;
  }>;
}

const buildRunnerFiles = async (runId: string, scripts: string[]): Promise<{ runDir: string; reportPath: string; outputDir: string }> => {
  const runDir = path.join(runtimeRoot, runId);
  const testsDir = path.join(runDir, "tests");
  const reportPath = path.join(runDir, "report.json");
  const outputDir = path.join(runDir, "test-results");

  await fs.mkdir(testsDir, { recursive: true });

  for (let i = 0; i < scripts.length; i += 1) {
    await fs.writeFile(path.join(testsDir, `generated-${i + 1}.spec.ts`), scripts[i], "utf-8");
  }

  const config = [
    "import { defineConfig } from '@playwright/test';",
    "",
    "export default defineConfig({",
    "  testDir: './tests',",
    "  timeout: 60_000,",
    "  use: {",
    "    screenshot: 'only-on-failure',",
    "    trace: 'retain-on-failure',",
    "  },",
    "  reporter: [['json', { outputFile: './report.json' }]],",
    "  outputDir: './test-results',",
    "});",
    "",
  ].join("\n");

  await fs.writeFile(path.join(runDir, "playwright.config.ts"), config, "utf-8");

  return { runDir, reportPath, outputDir };
};

const countResultsRecursive = (suite: any): { passCount: number; failCount: number; errors: string[] } => {
  let passCount = 0;
  let failCount = 0;
  const errors: string[] = [];

  // Count results at current suite level
  if (suite.specs) {
    for (const spec of suite.specs) {
      for (const test of spec.tests ?? []) {
        for (const result of test.results ?? []) {
          if (result.status === "passed") passCount += 1;
          if (result.status === "failed" || result.status === "timedOut") {
            failCount += 1;
            for (const err of result.errors ?? []) {
              if (err.message) errors.push(err.message);
              else if (err.stack) errors.push(err.stack);
            }
          }
        }
      }
    }
  }

  // Recursively count results in nested suites
  if (suite.suites) {
    for (const nestedSuite of suite.suites) {
      const nested = countResultsRecursive(nestedSuite);
      passCount += nested.passCount;
      failCount += nested.failCount;
      errors.push(...nested.errors);
    }
  }

  return { passCount, failCount, errors };
};

const parseReport = (report: PlaywrightJsonReport): { passCount: number; failCount: number; errors: string[]; duration: number } => {
  let passCount = 0;
  let failCount = 0;
  const errors: string[] = [];

  for (const suite of report.suites ?? []) {
    const result = countResultsRecursive(suite);
    passCount += result.passCount;
    failCount += result.failCount;
    errors.push(...result.errors);
  }

  return {
    passCount,
    failCount,
    errors,
    duration: report.stats?.duration ?? 0,
  };
};

const collectPngFiles = async (dir: string): Promise<string[]> => {
  const found: string[] = [];
  const items = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);

  for (const item of items) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      found.push(...(await collectPngFiles(full)));
      continue;
    }
    if (item.isFile() && item.name.toLowerCase().endsWith(".png")) {
      found.push(full);
    }
  }

  return found;
};

const getScreenshotBaseUrl = (port: number): string => {
  return `http://${env.screenshotHost}:${port}/static/screenshots`;
};

const publishScreenshots = async (runId: string, outputDir: string, port: number): Promise<string[]> => {
  const pngPaths = await collectPngFiles(outputDir);
  if (!pngPaths.length) return [];

  const runShotDir = path.join(screenshotRoot, runId);
  await fs.mkdir(runShotDir, { recursive: true });

  const baseUrl = getScreenshotBaseUrl(port);
  const links: string[] = [];
  for (const source of pngPaths) {
    const fileName = `${uuidv4()}.png`;
    const destination = path.join(runShotDir, fileName);
    await fs.copyFile(source, destination);
    links.push(`${baseUrl}/${runId}/${fileName}`);
  }

  return links;
};

const runPlaywright = async (cwd: string, pattern?: string): Promise<{ stdout: string; stderr: string; code: number | null }> => {
  return new Promise((resolve) => {
    const args = ["playwright", "test", "--config", "playwright.config.ts"];
    if (pattern) args.push(pattern);

    const child = spawn(
      process.platform === "win32" ? "npx.cmd" : "npx",
      args,
      {
        cwd,
        shell: true,
        windowsHide: true,
      },
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("close", (code) => {
      resolve({ stdout, stderr, code });
    });
  });
};

export const startExecution = async (testCaseIds: string[]): Promise<{ runId: string }> => {
  const cases = await getTestCasesByIds(testCaseIds);
  if (!cases.length) {
    throw new Error("No valid test cases found for execution");
  }

  // Check if there's already a running job
  const runningJobs = await db
    .collection("testRuns")
    .where("status", "==", "running")
    .where("testCaseIds", "array-contains-any", testCaseIds)
    .limit(1)
    .get();

  if (!runningJobs.empty) {
    throw new Error("A test run is already in progress for one or more of these test cases. Please wait for it to complete.");
  }

  const projectName = String(cases[0].projectName ?? "Unknown Project");

  const runRef = await db.collection("testRuns").add({
    projectId: String(cases[0].projectId ?? ""),
    projectName,
    testCaseIds,
    status: "running",
    isRunning: true,
    passCount: 0,
    failCount: 0,
    totalDuration: 0,
    logs: "Queued",
    screenshotUrls: [],
    errorDetails: "",
    startedAt: FieldValue.serverTimestamp(),
    completedAt: null,
  });

  for (const testCaseId of testCaseIds) {
    await updateTestCaseStatus(testCaseId, "running");
  }

  void executeInBackground(runRef.id, cases);

  return { runId: runRef.id };
};

interface TestCaseResult {
  testCaseId: string;
  passed: boolean;
  errors: string[];
  duration: number;
}

const executeInBackground = async (runId: string, cases: ExecutionTestCase[]) => {
  try {
    const testCaseIds = cases.map((item) => item.id);
    const scripts = cases.map((item) => item.script);

    const { runDir, outputDir } = await buildRunnerFiles(runId, scripts);

    // Run tests sequentially, one test file per case
    const results: TestCaseResult[] = [];
    let totalDuration = 0;
    const allErrors: string[] = [];
    const allLogs: string[] = [];

    for (let i = 0; i < testCaseIds.length; i += 1) {
      const testCaseId = testCaseIds[i];
      const filePattern = `generated-${i + 1}.spec.ts`;

      // Create individual report path for this test
      const individualReportPath = path.join(runDir, `report-${i + 1}.json`);
      const individualConfig = [
        "import { defineConfig } from '@playwright/test';",
        "",
        "export default defineConfig({",
        "  testDir: './tests',",
        "  timeout: 60_000,",
        "  use: {",
        "    screenshot: 'only-on-failure',",
        "    trace: 'retain-on-failure',",
        "  },",
        `  reporter: [['json', { outputFile: './report-${i + 1}.json' }]],`,
        "  outputDir: './test-results',",
        "});",
        "",
      ].join("\n");

      await fs.writeFile(path.join(runDir, "playwright.config.ts"), individualConfig, "utf-8");

      // Run this test file individually
      const runResult = await runPlaywright(runDir, filePattern);
      allLogs.push(`[${filePattern}]\n${runResult.stdout}`);
      if (runResult.stderr) allLogs.push(`STDERR: ${runResult.stderr}`);

      // Parse report for this test
      const rawReport = await fs.readFile(individualReportPath, "utf-8").catch(() => "{}");
      const parsed = parseReport(JSON.parse(rawReport) as PlaywrightJsonReport);

      totalDuration += parsed.duration;
      allErrors.push(...parsed.errors);

      const passed = parsed.failCount === 0 && runResult.code === 0;
      results.push({
        testCaseId,
        passed,
        errors: parsed.errors,
        duration: parsed.duration,
      });
    }

    // Collect all screenshots
    const screenshotUrls = await publishScreenshots(runId, outputDir, env.port);

    // Calculate aggregates
    const passCount = results.filter((r) => r.passed).length;
    const failCount = results.filter((r) => !r.passed).length;
    const status = failCount > 0 ? "failed" : "completed";

    const combinedLogs = allLogs.join("\n").slice(0, 100_000);

    await db.collection("testRuns").doc(runId).update({
      status,
      isRunning: false,
      passCount,
      failCount,
      totalDuration,
      logs: combinedLogs,
      screenshotUrls,
      errorDetails: allErrors.join("\n").slice(0, 40_000),
      completedAt: FieldValue.serverTimestamp(),
    });

    // Update each test case with its individual result
    for (const result of results) {
      const finalStatus = result.passed ? "pass" : "fail";
      await updateTestCaseStatus(result.testCaseId, finalStatus);
    }
  } catch (error) {
    const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
    await db.collection("testRuns").doc(runId).update({
      status: "failed",
      isRunning: false,
      logs: message.slice(0, 100_000),
      errorDetails: message.slice(0, 40_000),
      completedAt: FieldValue.serverTimestamp(),
    });
  }
};
