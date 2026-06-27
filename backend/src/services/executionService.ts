import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { db, FieldValue } from "../lib/firestore.js";
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

const parseReport = (report: PlaywrightJsonReport): { passCount: number; failCount: number; errors: string[]; duration: number } => {
  let passCount = 0;
  let failCount = 0;
  const errors: string[] = [];

  for (const suite of report.suites ?? []) {
    for (const spec of suite.specs ?? []) {
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

const publishScreenshots = async (runId: string, outputDir: string): Promise<string[]> => {
  const pngPaths = await collectPngFiles(outputDir);
  if (!pngPaths.length) return [];

  const runShotDir = path.join(screenshotRoot, runId);
  await fs.mkdir(runShotDir, { recursive: true });

  const links: string[] = [];
  for (const source of pngPaths) {
    const fileName = `${uuidv4()}.png`;
    const destination = path.join(runShotDir, fileName);
    await fs.copyFile(source, destination);
    links.push(`http://localhost:4000/static/screenshots/${runId}/${fileName}`);
  }

  return links;
};

const runPlaywright = async (cwd: string): Promise<{ stdout: string; stderr: string; code: number | null }> => {
  return new Promise((resolve) => {
    const child = spawn(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["playwright", "test", "--config", "playwright.config.ts"],
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

  const projectName = String(cases[0].projectName ?? "Unknown Project");

  const runRef = await db.collection("testRuns").add({
    projectId: String(cases[0].projectId ?? ""),
    projectName,
    testCaseIds,
    status: "running",
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

const executeInBackground = async (runId: string, cases: ExecutionTestCase[]) => {
  try {
    const scripts = cases.map((item) => item.script);
    const testCaseIds = cases.map((item) => item.id);

    const { runDir, reportPath, outputDir } = await buildRunnerFiles(runId, scripts);
    const runResult = await runPlaywright(runDir);

    const rawReport = await fs.readFile(reportPath, "utf-8").catch(() => "{}");
    const parsed = parseReport(JSON.parse(rawReport) as PlaywrightJsonReport);

    const screenshotUrls = await publishScreenshots(runId, outputDir);
    const status = parsed.failCount > 0 || runResult.code !== 0 ? "failed" : "completed";

    const combinedLogs = [runResult.stdout, runResult.stderr].filter(Boolean).join("\n").slice(0, 100_000);

    await db.collection("testRuns").doc(runId).update({
      status,
      passCount: parsed.passCount,
      failCount: parsed.failCount,
      totalDuration: parsed.duration,
      logs: combinedLogs,
      screenshotUrls,
      errorDetails: parsed.errors.join("\n").slice(0, 40_000),
      completedAt: FieldValue.serverTimestamp(),
    });

    for (let i = 0; i < testCaseIds.length; i += 1) {
      const finalStatus = parsed.failCount > 0 ? "fail" : "pass";
      await updateTestCaseStatus(testCaseIds[i], finalStatus);
    }
  } catch (error) {
    const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
    await db.collection("testRuns").doc(runId).update({
      status: "failed",
      logs: message.slice(0, 100_000),
      errorDetails: message.slice(0, 40_000),
      completedAt: FieldValue.serverTimestamp(),
    });
  }
};
