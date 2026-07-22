import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
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

interface TestCaseResult {
  testCaseId: string;
  passed: boolean;
  errors: string[];
  duration: number;
  filePattern: string;
}

interface McpTraceEntry {
  timestamp: string;
  testCaseId: string;
  step: string;
  status: "ok" | "error";
  message: string;
  url?: string;
}

interface SnapshotElement {
  ref: string;
  role: string;
  name: string;
  label?: string;
}

type ParsedAction =
  | { kind: "goto"; url: string }
  | { kind: "fill"; label: string; value: string }
  | { kind: "fillTestId"; testId: string; value: string }
  | { kind: "fillLocator"; selector: string; value: string }
  | { kind: "fillLocatorNth"; selector: string; index: number; value: string }
  | { kind: "clickRole"; role: string; name: string }
  | { kind: "clickText"; text: string }
  | { kind: "clickTestId"; testId: string }
  | { kind: "clickLocator"; selector: string }
  | { kind: "clickLocatorNth"; selector: string; index: number }
  | { kind: "assertTitle"; expected: string; isRegex: boolean }
  | { kind: "assertUrl"; expected: string; isRegex: boolean }
  | { kind: "assertTextRole"; role: string; name: string; expected: string; isRegex: boolean }
  | { kind: "assertTextText"; text: string; expected: string; isRegex: boolean }
  | { kind: "assertTextTestId"; testId: string; expected: string; isRegex: boolean }
  | { kind: "assertTextLocator"; selector: string; expected: string; isRegex: boolean }
  | { kind: "assertTextLocatorNth"; selector: string; index: number; expected: string; isRegex: boolean }
  | { kind: "assertVisibleRole"; role: string; name: string }
  | { kind: "assertVisibleText"; text: string }
  | { kind: "assertVisibleTestId"; testId: string }
  | { kind: "assertVisibleLocator"; selector: string }
  | { kind: "unsupported"; detail: string };

type ExecutionEngine = "playwright" | "mcp";

interface StartExecutionOptions {
  requestedEngine?: ExecutionEngine;
}

interface StartExecutionResult {
  runId: string;
  engineRequested: ExecutionEngine;
  engineUsed: ExecutionEngine;
  fallbackReason?: string;
}

const asExecutionEngine = (value: string | undefined): ExecutionEngine => {
  return value === "mcp" ? "mcp" : "playwright";
};

const resolveExecutionEngine = (requested?: ExecutionEngine): {
  engineRequested: ExecutionEngine;
  engineUsed: ExecutionEngine;
  fallbackReason: string;
} => {
  const engineRequested = requested ?? asExecutionEngine(env.executionEngine);
  const engineUsed: ExecutionEngine = "playwright";
  return {
    engineRequested,
    engineUsed,
    fallbackReason: engineRequested === "mcp"
      ? "Execution now uses Playwright runtime. MCP remains enabled for generation only."
      : "",
  };
};

const normalizeCommand = (command: string): string => command.trim().toLowerCase();

const isNpxCommand = (command: string): boolean => {
  const normalized = normalizeCommand(command);
  return normalized === "npx" || normalized === "npx.cmd";
};

const buildDefaultMcpArgs = (): string[] => {
  const args: string[] = [];

  if (env.playwrightHeadless) {
    args.push("--headless");
  }

  if (env.playwrightMcpBrowser) {
    args.push(`--browser=${env.playwrightMcpBrowser}`);
  }

  if (env.playwrightMcpIsolated) {
    args.push("--isolated");
  }

  if (env.playwrightMcpUserDataDir) {
    args.push("--user-data-dir", env.playwrightMcpUserDataDir);
  }

  if (env.playwrightMcpStorageState) {
    args.push("--storage-state", env.playwrightMcpStorageState);
  }

  return args;
};

const resolveMcpCommand = (): { command: string; args: string[] } => {
  const command = env.playwrightMcpCommand?.trim() || "playwright-mcp";

  if (isNpxCommand(command)) {
    throw new Error("PLAYWRIGHT_MCP_COMMAND cannot be npx. Use a direct MCP binary (for example: playwright-mcp).");
  }

  const args = env.playwrightMcpArgs.length ? env.playwrightMcpArgs : buildDefaultMcpArgs();
  return { command, args };
};

const getToolText = (result: unknown): string => {
  if (typeof result !== "object" || result == null) return "";

  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";

  return content
    .map((item) => {
      if (typeof item !== "object" || item == null) return "";
      const text = (item as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("\n");
};

const normalizeText = (value: string): string => value.trim().toLowerCase();

const parseSnapshotElements = (snapshot: string): SnapshotElement[] => {
  const lines = snapshot.split(/\r?\n/);
  const elements: SnapshotElement[] = [];
  let lastTextLabel = "";

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith("- ")) continue;

    const refMatch = line.match(/\[ref=([^\]]+)\]/);
    if (!refMatch) continue;

    const roleMatch = line.match(/^-\s*([a-zA-Z]+(?:\s+[a-zA-Z]+)*)/);
    const role = roleMatch?.[1]?.trim().toLowerCase() ?? "generic";
    const quotedName = line.match(/"([^"]+)"/);
    const trailingName = !quotedName ? line.match(/:\s*([^\[]+)\s*\[ref=/) : null;
    const name = (quotedName?.[1] ?? trailingName?.[1] ?? "").trim();

    const element: SnapshotElement = {
      ref: refMatch[1],
      role,
      name,
      label: undefined,
    };

    if (role === "textbox" && lastTextLabel) {
      element.label = lastTextLabel;
    }

    elements.push(element);

    if (role === "generic" && name) {
      lastTextLabel = name;
      continue;
    }
    if (["paragraph", "heading", "label", "text"].includes(role)) {
      lastTextLabel = name;
      continue;
    }
    if (role !== "textbox") {
      lastTextLabel = "";
    }
  }

  return elements;
};

const parseExpectedTextOrRegex = (rawValue: string): { expected: string; isRegex: boolean } | null => {
  const trimmed = rawValue.trim();
  const regexMatch = trimmed.match(/^\/(.*)\/[gimsuy]*$/);
  if (regexMatch?.[1]) {
    return { expected: regexMatch[1], isRegex: true };
  }

  const quotedMatch = trimmed.match(/^["'`](.*)["'`]$/);
  if (quotedMatch?.[1]) {
    return { expected: quotedMatch[1], isRegex: false };
  }

  return null;
};

const parsePlaywrightActions = (script: string): ParsedAction[] => {
  const actions: ParsedAction[] = [];
  const lines = script.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  for (const line of lines) {
    const gotoMatch = line.match(/await\s+page\.goto\(\s*['"`]([^'"`]+)['"`]/i);
    if (gotoMatch?.[1]) {
      actions.push({ kind: "goto", url: gotoMatch[1].trim() });
      continue;
    }

    const fillLabelMatch = line.match(/await\s+page\.getBy(?:Label|Placeholder|Role)\(\s*['"`]([^'"`]+)['"`][^)]*\)\.fill\(\s*['"`]([^'"`]*)['"`]\s*\)/i);
    if (fillLabelMatch?.[1] !== undefined && fillLabelMatch?.[2] !== undefined) {
      actions.push({ kind: "fill", label: fillLabelMatch[1].trim(), value: fillLabelMatch[2] });
      continue;
    }

    const fillTestIdMatch = line.match(/await\s+page\.getByTestId\(\s*['"`]([^'"`]+)['"`][^)]*\)\.fill\(\s*['"`]([^'"`]*)['"`]\s*\)/i);
    if (fillTestIdMatch?.[1] !== undefined && fillTestIdMatch?.[2] !== undefined) {
      actions.push({ kind: "fillTestId", testId: fillTestIdMatch[1].trim(), value: fillTestIdMatch[2] });
      continue;
    }

    const fillLocatorMatch = line.match(/await\s+page\.locator\(\s*['"`]([^'"`]+)['"`][^)]*\)\.fill\(\s*['"`]([^'"`]*)['"`]\s*\)/i);
    if (fillLocatorMatch?.[1] !== undefined && fillLocatorMatch?.[2] !== undefined) {
      actions.push({ kind: "fillLocator", selector: fillLocatorMatch[1].trim(), value: fillLocatorMatch[2] });
      continue;
    }

    const fillLocatorNthMatch = line.match(/await\s+page\.locator\(\s*['"`]([^'"`]+)['"`][^)]*\)\.nth\(\s*(\d+)\s*\)\.fill\(\s*['"`]([^'"`]*)['"`]\s*\)/i);
    if (fillLocatorNthMatch?.[1] !== undefined && fillLocatorNthMatch?.[2] !== undefined && fillLocatorNthMatch?.[3] !== undefined) {
      actions.push({
        kind: "fillLocatorNth",
        selector: fillLocatorNthMatch[1].trim(),
        index: Number(fillLocatorNthMatch[2]),
        value: fillLocatorNthMatch[3],
      });
      continue;
    }

    const clickRoleMatch = line.match(/await\s+page\.getByRole\(\s*['"`]([^'"`]+)['"`]\s*,\s*\{\s*name:\s*['"`]([^'"`]+)['"`][^}]*\}\s*\)\.click\(/i);
    if (clickRoleMatch?.[1] && clickRoleMatch?.[2]) {
      actions.push({ kind: "clickRole", role: clickRoleMatch[1].trim().toLowerCase(), name: clickRoleMatch[2].trim() });
      continue;
    }

    const clickTextMatch = line.match(/await\s+page\.getByText\(\s*['"`]([^'"`]+)['"`][^)]*\)\.click\(/i);
    if (clickTextMatch?.[1]) {
      actions.push({ kind: "clickText", text: clickTextMatch[1].trim() });
      continue;
    }

    const clickTestIdMatch = line.match(/await\s+page\.getByTestId\(\s*['"`]([^'"`]+)['"`][^)]*\)\.click\(/i);
    if (clickTestIdMatch?.[1]) {
      actions.push({ kind: "clickTestId", testId: clickTestIdMatch[1].trim() });
      continue;
    }

    const clickLocatorMatch = line.match(/await\s+page\.locator\(\s*['"`]([^'"`]+)['"`][^)]*\)\.click\(/i);
    if (clickLocatorMatch?.[1]) {
      actions.push({ kind: "clickLocator", selector: clickLocatorMatch[1].trim() });
      continue;
    }

    const clickLocatorNthMatch = line.match(/await\s+page\.locator\(\s*['"`]([^'"`]+)['"`][^)]*\)\.nth\(\s*(\d+)\s*\)\.click\(/i);
    if (clickLocatorNthMatch?.[1] && clickLocatorNthMatch?.[2]) {
      actions.push({ kind: "clickLocatorNth", selector: clickLocatorNthMatch[1].trim(), index: Number(clickLocatorNthMatch[2]) });
      continue;
    }

    const assertTitleMatch = line.match(/await\s+expect\(page\)\.toHaveTitle\((.+)\)\s*;?/i);
    if (assertTitleMatch?.[1]) {
      const parsed = parseExpectedTextOrRegex(assertTitleMatch[1]);
      if (parsed) {
        actions.push({ kind: "assertTitle", expected: parsed.expected, isRegex: parsed.isRegex });
      } else {
        actions.push({ kind: "unsupported", detail: `Unsupported toHaveTitle expression: ${assertTitleMatch[1].trim()}` });
      }
      continue;
    }

    const assertUrlMatch = line.match(/await\s+expect\(page\)\.toHaveURL\((.+)\)\s*;?/i);
    if (assertUrlMatch?.[1]) {
      const parsed = parseExpectedTextOrRegex(assertUrlMatch[1]);
      if (parsed) {
        actions.push({ kind: "assertUrl", expected: parsed.expected, isRegex: parsed.isRegex });
      } else {
        actions.push({ kind: "unsupported", detail: `Unsupported toHaveURL expression: ${assertUrlMatch[1].trim()}` });
      }
      continue;
    }

    const assertVisibleRoleMatch = line.match(/await\s+expect\(page\.getByRole\(\s*['"`]([^'"`]+)['"`]\s*,\s*\{\s*name:\s*['"`]([^'"`]+)['"`][^}]*\}\s*\)\)\.toBeVisible\(\)\s*;?/i);
    if (assertVisibleRoleMatch?.[1] && assertVisibleRoleMatch?.[2]) {
      actions.push({ kind: "assertVisibleRole", role: assertVisibleRoleMatch[1].trim().toLowerCase(), name: assertVisibleRoleMatch[2].trim() });
      continue;
    }

    const assertVisibleTextMatch = line.match(/await\s+expect\(page\.getByText\(\s*['"`]([^'"`]+)['"`][^)]*\)\)\.toBeVisible\(\)\s*;?/i);
    if (assertVisibleTextMatch?.[1]) {
      actions.push({ kind: "assertVisibleText", text: assertVisibleTextMatch[1].trim() });
      continue;
    }

    const assertVisibleTestIdMatch = line.match(/await\s+expect\(page\.getByTestId\(\s*['"`]([^'"`]+)['"`][^)]*\)\)\.toBeVisible\(\)\s*;?/i);
    if (assertVisibleTestIdMatch?.[1]) {
      actions.push({ kind: "assertVisibleTestId", testId: assertVisibleTestIdMatch[1].trim() });
      continue;
    }

    const assertVisibleLocatorMatch = line.match(/await\s+expect\(page\.locator\(\s*['"`]([^'"`]+)['"`][^)]*\)\)\.toBeVisible\(\)\s*;?/i);
    if (assertVisibleLocatorMatch?.[1]) {
      actions.push({ kind: "assertVisibleLocator", selector: assertVisibleLocatorMatch[1].trim() });
      continue;
    }

    const assertTextRoleMatch = line.match(/await\s+expect\(page\.getByRole\(\s*['"`]([^'"`]+)['"`]\s*,\s*\{\s*name:\s*['"`]([^'"`]+)['"`][^}]*\}\s*\)\)\.toHaveText\((.+)\)\s*;?/i);
    if (assertTextRoleMatch?.[1] && assertTextRoleMatch?.[2] && assertTextRoleMatch?.[3]) {
      const parsed = parseExpectedTextOrRegex(assertTextRoleMatch[3]);
      if (parsed) {
        actions.push({ kind: "assertTextRole", role: assertTextRoleMatch[1].trim().toLowerCase(), name: assertTextRoleMatch[2].trim(), expected: parsed.expected, isRegex: parsed.isRegex });
      } else {
        actions.push({ kind: "unsupported", detail: `Unsupported toHaveText expression: ${assertTextRoleMatch[3].trim()}` });
      }
      continue;
    }

    const assertTextTextMatch = line.match(/await\s+expect\(page\.getByText\(\s*['"`]([^'"`]+)['"`][^)]*\)\)\.toHaveText\((.+)\)\s*;?/i);
    if (assertTextTextMatch?.[1] && assertTextTextMatch?.[2]) {
      const parsed = parseExpectedTextOrRegex(assertTextTextMatch[2]);
      if (parsed) {
        actions.push({ kind: "assertTextText", text: assertTextTextMatch[1].trim(), expected: parsed.expected, isRegex: parsed.isRegex });
      } else {
        actions.push({ kind: "unsupported", detail: `Unsupported toHaveText expression: ${assertTextTextMatch[2].trim()}` });
      }
      continue;
    }

    const assertTextTestIdMatch = line.match(/await\s+expect\(page\.getByTestId\(\s*['"`]([^'"`]+)['"`][^)]*\)\)\.toHaveText\((.+)\)\s*;?/i);
    if (assertTextTestIdMatch?.[1] && assertTextTestIdMatch?.[2]) {
      const parsed = parseExpectedTextOrRegex(assertTextTestIdMatch[2]);
      if (parsed) {
        actions.push({ kind: "assertTextTestId", testId: assertTextTestIdMatch[1].trim(), expected: parsed.expected, isRegex: parsed.isRegex });
      } else {
        actions.push({ kind: "unsupported", detail: `Unsupported toHaveText expression: ${assertTextTestIdMatch[2].trim()}` });
      }
      continue;
    }

    const assertTextLocatorNthMatch = line.match(/await\s+expect\(page\.locator\(\s*['"`]([^'"`]+)['"`][^)]*\)\.nth\(\s*(\d+)\s*\)\)\.toHaveText\((.+)\)\s*;?/i);
    if (assertTextLocatorNthMatch?.[1] && assertTextLocatorNthMatch?.[2] && assertTextLocatorNthMatch?.[3]) {
      const parsed = parseExpectedTextOrRegex(assertTextLocatorNthMatch[3]);
      if (parsed) {
        actions.push({ kind: "assertTextLocatorNth", selector: assertTextLocatorNthMatch[1].trim(), index: Number(assertTextLocatorNthMatch[2]), expected: parsed.expected, isRegex: parsed.isRegex });
      } else {
        actions.push({ kind: "unsupported", detail: `Unsupported toHaveText expression: ${assertTextLocatorNthMatch[3].trim()}` });
      }
      continue;
    }

    const assertTextLocatorMatch = line.match(/await\s+expect\(page\.locator\(\s*['"`]([^'"`]+)['"`][^)]*\)\)\.toHaveText\((.+)\)\s*;?/i);
    if (assertTextLocatorMatch?.[1] && assertTextLocatorMatch?.[2]) {
      const parsed = parseExpectedTextOrRegex(assertTextLocatorMatch[2]);
      if (parsed) {
        actions.push({ kind: "assertTextLocator", selector: assertTextLocatorMatch[1].trim(), expected: parsed.expected, isRegex: parsed.isRegex });
      } else {
        actions.push({ kind: "unsupported", detail: `Unsupported toHaveText expression: ${assertTextLocatorMatch[2].trim()}` });
      }
      continue;
    }

    if (/await\s+page\./i.test(line) || /await\s+expect\(/i.test(line)) {
      actions.push({ kind: "unsupported", detail: `Unsupported action: ${line}` });
    }
  }

  return actions;
};

const findTextboxRef = (elements: SnapshotElement[], query: string): string | null => {
  const normalizedQuery = normalizeText(query);
  const direct = elements.find((element) => {
    if (element.role !== "textbox") return false;
    return normalizeText(element.name).includes(normalizedQuery) || normalizeText(element.label ?? "").includes(normalizedQuery);
  });
  return direct?.ref ?? null;
};

const findClickableRefByRole = (elements: SnapshotElement[], role: string, name: string): string | null => {
  const normalizedRole = normalizeText(role);
  const normalizedName = normalizeText(name);
  const direct = elements.find((element) => {
    return normalizeText(element.role) === normalizedRole && normalizeText(element.name).includes(normalizedName);
  });

  return direct?.ref ?? null;
};

const findClickableRefByText = (elements: SnapshotElement[], text: string): string | null => {
  const normalizedText = normalizeText(text);
  const candidates = elements.filter((element) => ["button", "link", "tab", "menuitem"].includes(element.role));
  const direct = candidates.find((element) => normalizeText(element.name).includes(normalizedText));
  return direct?.ref ?? null;
};

const asPlainStringResult = (value: unknown): string => {
  if (typeof value === "string") return value;
  const fromToolText = getToolText(value);
  if (fromToolText) return fromToolText;
  if (typeof value === "object" && value != null) {
    const maybeContent = (value as { content?: unknown }).content;
    if (typeof maybeContent === "string") return maybeContent;
  }
  return "";
};

const asEvaluateObject = (value: unknown): Record<string, unknown> | null => {
  if (typeof value === "object" && value != null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  const text = asPlainStringResult(value).trim();
  if (!text) return null;

  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "object" && parsed != null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore parse errors and fallback to null
  }

  return null;
};

const asEvaluateString = (value: unknown): string => {
  if (typeof value === "string") return value;

  if (typeof value === "object" && value != null) {
    const record = value as Record<string, unknown>;
    if (typeof record.value === "string") return record.value;
  }

  return asPlainStringResult(value);
};

const evaluateSelectorClick = async (client: Client, selector: string): Promise<{ ok: boolean; message: string }> => {
  const result = await client.callTool({
    name: "browser_evaluate",
    arguments: {
      function: `(selector) => {
        const element = document.querySelector(selector);
        if (!element) {
          return { ok: false, message: 'Element not found for selector: ' + selector };
        }
        (element as HTMLElement).click();
        return { ok: true, message: 'Clicked selector: ' + selector };
      }`,
      args: [selector],
    },
  });

  const parsed = asEvaluateObject(result);
  if (!parsed) {
    return { ok: false, message: "Failed to parse browser_evaluate result for click" };
  }

  return {
    ok: Boolean(parsed.ok),
    message: typeof parsed.message === "string" ? parsed.message : "Unknown click evaluate result",
  };
};

const evaluateSelectorNthClick = async (client: Client, selector: string, index: number): Promise<{ ok: boolean; message: string }> => {
  const result = await client.callTool({
    name: "browser_evaluate",
    arguments: {
      function: `(selector, index) => {
        const elements = document.querySelectorAll(selector);
        const target = elements.item(Number(index));
        if (!target) {
          return {
            ok: false,
            message: 'Element not found for selector/index: ' + selector + ' @ ' + String(index),
          };
        }
        (target as HTMLElement).click();
        return { ok: true, message: 'Clicked selector/index: ' + selector + ' @ ' + String(index) };
      }`,
      args: [selector, index],
    },
  });

  const parsed = asEvaluateObject(result);
  if (!parsed) {
    return { ok: false, message: "Failed to parse browser_evaluate result for nth click" };
  }

  return {
    ok: Boolean(parsed.ok),
    message: typeof parsed.message === "string" ? parsed.message : "Unknown nth click evaluate result",
  };
};

const evaluateSelectorFill = async (client: Client, selector: string, value: string): Promise<{ ok: boolean; message: string }> => {
  const result = await client.callTool({
    name: "browser_evaluate",
    arguments: {
      function: `(selector, value) => {
        const element = document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null;
        if (!element) {
          return { ok: false, message: 'Element not found for selector: ' + selector };
        }

        element.focus();
        element.value = String(value ?? '');
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, message: 'Filled selector: ' + selector };
      }`,
      args: [selector, value],
    },
  });

  const parsed = asEvaluateObject(result);
  if (!parsed) {
    return { ok: false, message: "Failed to parse browser_evaluate result for fill" };
  }

  return {
    ok: Boolean(parsed.ok),
    message: typeof parsed.message === "string" ? parsed.message : "Unknown fill evaluate result",
  };
};

const evaluateSelectorNthFill = async (
  client: Client,
  selector: string,
  index: number,
  value: string,
): Promise<{ ok: boolean; message: string }> => {
  const result = await client.callTool({
    name: "browser_evaluate",
    arguments: {
      function: `(selector, index, value) => {
        const elements = document.querySelectorAll(selector);
        const target = elements.item(Number(index)) as HTMLInputElement | HTMLTextAreaElement | null;
        if (!target) {
          return {
            ok: false,
            message: 'Element not found for selector/index: ' + selector + ' @ ' + String(index),
          };
        }

        target.focus();
        target.value = String(value ?? '');
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, message: 'Filled selector/index: ' + selector + ' @ ' + String(index) };
      }`,
      args: [selector, index, value],
    },
  });

  const parsed = asEvaluateObject(result);
  if (!parsed) {
    return { ok: false, message: "Failed to parse browser_evaluate result for nth fill" };
  }

  return {
    ok: Boolean(parsed.ok),
    message: typeof parsed.message === "string" ? parsed.message : "Unknown nth fill evaluate result",
  };
};

const evaluateSelectorVisible = async (client: Client, selector: string): Promise<{ ok: boolean; message: string }> => {
  const result = await client.callTool({
    name: "browser_evaluate",
    arguments: {
      function: `(selector) => {
        const element = document.querySelector(selector) as HTMLElement | null;
        if (!element) {
          return { ok: false, message: 'Element not found for selector: ' + selector };
        }

        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const visible = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
        return {
          ok: visible,
          message: visible
            ? 'Element is visible for selector: ' + selector
            : 'Element is not visible for selector: ' + selector,
        };
      }`,
      args: [selector],
    },
  });

  const parsed = asEvaluateObject(result);
  if (!parsed) {
    return { ok: false, message: "Failed to parse browser_evaluate result for visibility assertion" };
  }

  return {
    ok: Boolean(parsed.ok),
    message: typeof parsed.message === "string" ? parsed.message : "Unknown visibility evaluate result",
  };
};

const evaluateSelectorText = async (
  client: Client,
  selector: string,
  index?: number,
): Promise<{ ok: boolean; message: string; text: string }> => {
  const result = await client.callTool({
    name: "browser_evaluate",
    arguments: {
      function: `(selector, index) => {
        const element = index === undefined || index === null
          ? document.querySelector(selector)
          : document.querySelectorAll(selector).item(Number(index));

        if (!element) {
          return {
            ok: false,
            message: 'Element not found for selector' + (index === undefined || index === null ? '' : '/index') + ': ' + selector + (index === undefined || index === null ? '' : ' @ ' + String(index)),
            text: '',
          };
        }

        const rawText = (element as HTMLElement).innerText ?? element.textContent ?? '';
        return {
          ok: true,
          message: 'Read text for selector' + (index === undefined || index === null ? '' : '/index') + ': ' + selector + (index === undefined || index === null ? '' : ' @ ' + String(index)),
          text: String(rawText),
        };
      }`,
      args: [selector, index],
    },
  });

  const parsed = asEvaluateObject(result);
  if (!parsed) {
    return { ok: false, message: "Failed to parse browser_evaluate result for text assertion", text: "" };
  }

  return {
    ok: Boolean(parsed.ok),
    message: typeof parsed.message === "string" ? parsed.message : "Unknown text evaluate result",
    text: typeof parsed.text === "string" ? parsed.text : "",
  };
};

const extractTargetUrlFromScript = (script: string): string | null => {
  const gotoMatch = script.match(/page\.goto\(\s*['"`]([^'"`]+)['"`]/i);
  if (gotoMatch?.[1]) return gotoMatch[1].trim();

  const urlMatch = script.match(/https?:\/\/[^\s'"`\)]+/i);
  if (urlMatch?.[0]) return urlMatch[0].trim();

  return null;
};

const hasMeaningfulSnapshotTree = (snapshot: string): boolean => {
  const yamlMatch = snapshot.match(/### Snapshot\s*```yaml\s*([\s\S]*?)```/i);
  const yamlContent = yamlMatch?.[1]?.trim() ?? "";
  return yamlContent.length > 0;
};

const executeWithMcp = async (
  runId: string,
  cases: ExecutionTestCase[],
): Promise<{
  results: TestCaseResult[];
  passCount: number;
  failCount: number;
  totalDuration: number;
  combinedLogs: string;
  allErrors: string[];
  mcpTrace: McpTraceEntry[];
}> => {
  const { command, args } = resolveMcpCommand();
  const transport = new StdioClientTransport({ command, args });
  const client = new Client({ name: "autonomous-verification-executor", version: "1.0.0" });
  await client.connect(transport);

  const mcpTrace: McpTraceEntry[] = [];
  const results: TestCaseResult[] = [];
  const allErrors: string[] = [];
  const logs: string[] = [];
  let totalDuration = 0;

  try {
    for (let index = 0; index < cases.length; index += 1) {
      const testCase = cases[index];
      const start = Date.now();
      const filePattern = `mcp-case-${index + 1}`;
      const targetUrl = extractTargetUrlFromScript(testCase.script);
      const parsedActions = parsePlaywrightActions(testCase.script);
      const actions: ParsedAction[] = [...parsedActions];
      const caseErrors: string[] = [];

      if (!targetUrl) {
        const message = "Cannot determine target URL from test script (missing page.goto or URL).";
        allErrors.push(message);
        results.push({
          testCaseId: testCase.id,
          passed: false,
          errors: [message],
          duration: Date.now() - start,
          filePattern,
        });

        mcpTrace.push({
          timestamp: new Date().toISOString(),
          testCaseId: testCase.id,
          step: "extract-target-url",
          status: "error",
          message,
        });
        continue;
      }

      const needsGoto = parsedActions.every((action) => action.kind !== "goto");
      if (needsGoto) {
        actions.unshift({ kind: "goto", url: targetUrl });
      }

      try {
        for (const action of actions) {
          if (action.kind === "unsupported") {
            const message = `UNSUPPORTED_STEP: ${action.detail}`;
            caseErrors.push(message);
            mcpTrace.push({
              timestamp: new Date().toISOString(),
              testCaseId: testCase.id,
              step: "unsupported-action",
              status: "error",
              message,
              url: targetUrl,
            });
            continue;
          }

          if (action.kind === "goto") {
            try {
              await client.callTool({ name: "browser_navigate", arguments: { url: action.url } });
              mcpTrace.push({
                timestamp: new Date().toISOString(),
                testCaseId: testCase.id,
                step: "browser_navigate",
                status: "ok",
                message: `Navigation completed (${action.url})`,
                url: action.url,
              });
            } catch (error) {
              const message = `Failed to navigate: ${error instanceof Error ? error.message : String(error)}`;
              caseErrors.push(message);
              mcpTrace.push({
                timestamp: new Date().toISOString(),
                testCaseId: testCase.id,
                step: "browser_navigate",
                status: "error",
                message,
                url: action.url,
              });
            }
            continue;
          }

          if (action.kind === "fill") {
            const snapshotResult = await client.callTool({ name: "browser_snapshot", arguments: {} });
            const snapshotText = getToolText(snapshotResult);
            const elements = parseSnapshotElements(snapshotText);
            const targetRef = findTextboxRef(elements, action.label);

            if (!targetRef) {
              const message = `UNSUPPORTED_STEP: could not resolve textbox for label '${action.label}'`;
              caseErrors.push(message);
              mcpTrace.push({
                timestamp: new Date().toISOString(),
                testCaseId: testCase.id,
                step: "browser_fill_form",
                status: "error",
                message,
                url: targetUrl,
              });
              continue;
            }

            try {
              await client.callTool({
                name: "browser_fill_form",
                arguments: {
                  fields: [{ target: targetRef, name: action.label, type: "textbox", value: action.value }],
                },
              });
              mcpTrace.push({
                timestamp: new Date().toISOString(),
                testCaseId: testCase.id,
                step: "browser_fill_form",
                status: "ok",
                message: `Filled '${action.label}'`,
                url: targetUrl,
              });
            } catch (error) {
              const message = `Failed to fill '${action.label}': ${error instanceof Error ? error.message : String(error)}`;
              caseErrors.push(message);
              mcpTrace.push({
                timestamp: new Date().toISOString(),
                testCaseId: testCase.id,
                step: "browser_fill_form",
                status: "error",
                message,
                url: targetUrl,
              });
            }
            continue;
          }

          if (action.kind === "fillTestId" || action.kind === "fillLocator" || action.kind === "fillLocatorNth") {
            const selector = action.kind === "fillTestId"
              ? `[data-testid="${action.testId}"]`
              : action.selector;

            try {
              const evalResult = action.kind === "fillLocatorNth"
                ? await evaluateSelectorNthFill(client, selector, action.index, action.value)
                : await evaluateSelectorFill(client, selector, action.value);
              if (!evalResult.ok) {
                const message = `UNSUPPORTED_STEP: ${evalResult.message}`;
                caseErrors.push(message);
                mcpTrace.push({
                  timestamp: new Date().toISOString(),
                  testCaseId: testCase.id,
                  step: "browser_evaluate_fill",
                  status: "error",
                  message,
                  url: targetUrl,
                });
              } else {
                mcpTrace.push({
                  timestamp: new Date().toISOString(),
                  testCaseId: testCase.id,
                  step: "browser_evaluate_fill",
                  status: "ok",
                  message: evalResult.message,
                  url: targetUrl,
                });
              }
            } catch (error) {
              const message = `Failed evaluate fill for selector '${selector}': ${error instanceof Error ? error.message : String(error)}`;
              caseErrors.push(message);
              mcpTrace.push({
                timestamp: new Date().toISOString(),
                testCaseId: testCase.id,
                step: "browser_evaluate_fill",
                status: "error",
                message,
                url: targetUrl,
              });
            }

            continue;
          }

          if (action.kind === "clickRole" || action.kind === "clickText") {
            const snapshotResult = await client.callTool({ name: "browser_snapshot", arguments: {} });
            const snapshotText = getToolText(snapshotResult);
            const elements = parseSnapshotElements(snapshotText);

            const targetRef = action.kind === "clickRole"
              ? findClickableRefByRole(elements, action.role, action.name)
              : findClickableRefByText(elements, action.text);

            if (!targetRef) {
              const detail = action.kind === "clickRole"
                ? `${action.role}/${action.name}`
                : action.text;
              const message = `UNSUPPORTED_STEP: could not resolve click target '${detail}'`;
              caseErrors.push(message);
              mcpTrace.push({
                timestamp: new Date().toISOString(),
                testCaseId: testCase.id,
                step: "browser_click",
                status: "error",
                message,
                url: targetUrl,
              });
              continue;
            }

            try {
              await client.callTool({ name: "browser_click", arguments: { target: targetRef } });
              const detail = action.kind === "clickRole"
                ? `${action.role}/${action.name}`
                : action.text;
              mcpTrace.push({
                timestamp: new Date().toISOString(),
                testCaseId: testCase.id,
                step: "browser_click",
                status: "ok",
                message: `Clicked '${detail}'`,
                url: targetUrl,
              });
            } catch (error) {
              const detail = action.kind === "clickRole"
                ? `${action.role}/${action.name}`
                : action.text;
              const message = `Failed to click '${detail}': ${error instanceof Error ? error.message : String(error)}`;
              caseErrors.push(message);
              mcpTrace.push({
                timestamp: new Date().toISOString(),
                testCaseId: testCase.id,
                step: "browser_click",
                status: "error",
                message,
                url: targetUrl,
              });
            }
            continue;
          }

          if (action.kind === "clickTestId" || action.kind === "clickLocator" || action.kind === "clickLocatorNth") {
            const selector = action.kind === "clickTestId"
              ? `[data-testid="${action.testId}"]`
              : action.selector;

            try {
              const evalResult = action.kind === "clickLocatorNth"
                ? await evaluateSelectorNthClick(client, selector, action.index)
                : await evaluateSelectorClick(client, selector);
              if (!evalResult.ok) {
                const message = `UNSUPPORTED_STEP: ${evalResult.message}`;
                caseErrors.push(message);
                mcpTrace.push({
                  timestamp: new Date().toISOString(),
                  testCaseId: testCase.id,
                  step: "browser_evaluate_click",
                  status: "error",
                  message,
                  url: targetUrl,
                });
              } else {
                mcpTrace.push({
                  timestamp: new Date().toISOString(),
                  testCaseId: testCase.id,
                  step: "browser_evaluate_click",
                  status: "ok",
                  message: evalResult.message,
                  url: targetUrl,
                });
              }
            } catch (error) {
              const message = `Failed evaluate click for selector '${selector}': ${error instanceof Error ? error.message : String(error)}`;
              caseErrors.push(message);
              mcpTrace.push({
                timestamp: new Date().toISOString(),
                testCaseId: testCase.id,
                step: "browser_evaluate_click",
                status: "error",
                message,
                url: targetUrl,
              });
            }

            continue;
          }

          if (action.kind === "assertTitle") {
            try {
              const result = await client.callTool({
                name: "browser_evaluate",
                arguments: {
                  function: "() => document.title",
                },
              });

              const title = asPlainStringResult(result);
              const passed = action.isRegex
                ? new RegExp(action.expected, "i").test(title)
                : normalizeText(title).includes(normalizeText(action.expected));

              if (!passed) {
                const message = `Title assertion failed. Expected '${action.expected}', got '${title}'`;
                caseErrors.push(message);
                mcpTrace.push({
                  timestamp: new Date().toISOString(),
                  testCaseId: testCase.id,
                  step: "assert-title",
                  status: "error",
                  message,
                  url: targetUrl,
                });
              } else {
                mcpTrace.push({
                  timestamp: new Date().toISOString(),
                  testCaseId: testCase.id,
                  step: "assert-title",
                  status: "ok",
                  message: `Title assertion passed (${title})`,
                  url: targetUrl,
                });
              }
            } catch (error) {
              const message = `Failed title assertion: ${error instanceof Error ? error.message : String(error)}`;
              caseErrors.push(message);
              mcpTrace.push({
                timestamp: new Date().toISOString(),
                testCaseId: testCase.id,
                step: "assert-title",
                status: "error",
                message,
                url: targetUrl,
              });
            }
            continue;
          }

          if (action.kind === "assertUrl") {
            try {
              const result = await client.callTool({
                name: "browser_evaluate",
                arguments: {
                  function: "() => window.location.href",
                },
              });

              const currentUrl = asEvaluateString(result).trim();
              const passed = action.isRegex
                ? new RegExp(action.expected, "i").test(currentUrl)
                : normalizeText(currentUrl).includes(normalizeText(action.expected));

              if (!passed) {
                const message = `URL assertion failed. Expected '${action.expected}', got '${currentUrl}'`;
                caseErrors.push(message);
                mcpTrace.push({
                  timestamp: new Date().toISOString(),
                  testCaseId: testCase.id,
                  step: "assert-url",
                  status: "error",
                  message,
                  url: targetUrl,
                });
              } else {
                mcpTrace.push({
                  timestamp: new Date().toISOString(),
                  testCaseId: testCase.id,
                  step: "assert-url",
                  status: "ok",
                  message: `URL assertion passed (${currentUrl})`,
                  url: targetUrl,
                });
              }
            } catch (error) {
              const message = `Failed URL assertion: ${error instanceof Error ? error.message : String(error)}`;
              caseErrors.push(message);
              mcpTrace.push({
                timestamp: new Date().toISOString(),
                testCaseId: testCase.id,
                step: "assert-url",
                status: "error",
                message,
                url: targetUrl,
              });
            }

            continue;
          }

          if (
            action.kind === "assertTextRole"
            || action.kind === "assertTextText"
            || action.kind === "assertTextTestId"
            || action.kind === "assertTextLocator"
            || action.kind === "assertTextLocatorNth"
          ) {
            try {
              if (action.kind === "assertTextRole" || action.kind === "assertTextText") {
                const snapshotResult = await client.callTool({ name: "browser_snapshot", arguments: {} });
                const snapshotText = getToolText(snapshotResult);
                const elements = parseSnapshotElements(snapshotText);

                const actualText = action.kind === "assertTextRole"
                  ? elements.find(
                    (element) => normalizeText(element.role) === normalizeText(action.role)
                      && normalizeText(element.name).includes(normalizeText(action.name)),
                  )?.name ?? ""
                  : elements.find((element) => normalizeText(element.name).includes(normalizeText(action.text)))?.name ?? "";

                const passed = action.isRegex
                  ? new RegExp(action.expected, "i").test(actualText)
                  : normalizeText(actualText).includes(normalizeText(action.expected));

                if (!passed) {
                  const message = action.kind === "assertTextRole"
                    ? `Text assertion failed for role/name '${action.role}/${action.name}'. Expected '${action.expected}', got '${actualText}'`
                    : `Text assertion failed for text target '${action.text}'. Expected '${action.expected}', got '${actualText}'`;
                  caseErrors.push(message);
                  mcpTrace.push({
                    timestamp: new Date().toISOString(),
                    testCaseId: testCase.id,
                    step: "assert-text",
                    status: "error",
                    message,
                    url: targetUrl,
                  });
                } else {
                  mcpTrace.push({
                    timestamp: new Date().toISOString(),
                    testCaseId: testCase.id,
                    step: "assert-text",
                    status: "ok",
                    message: `Text assertion passed (${actualText})`,
                    url: targetUrl,
                  });
                }

                continue;
              }

              const selector = action.kind === "assertTextTestId"
                ? `[data-testid="${action.testId}"]`
                : action.selector;

              const evalResult = action.kind === "assertTextLocatorNth"
                ? await evaluateSelectorText(client, selector, action.index)
                : await evaluateSelectorText(client, selector);

              if (!evalResult.ok) {
                const message = `Text assertion failed: ${evalResult.message}`;
                caseErrors.push(message);
                mcpTrace.push({
                  timestamp: new Date().toISOString(),
                  testCaseId: testCase.id,
                  step: "assert-text",
                  status: "error",
                  message,
                  url: targetUrl,
                });
                continue;
              }

              const actualText = evalResult.text;
              const passed = action.isRegex
                ? new RegExp(action.expected, "i").test(actualText)
                : normalizeText(actualText).includes(normalizeText(action.expected));

              if (!passed) {
                const message = `Text assertion failed. Expected '${action.expected}', got '${actualText}'`;
                caseErrors.push(message);
                mcpTrace.push({
                  timestamp: new Date().toISOString(),
                  testCaseId: testCase.id,
                  step: "assert-text",
                  status: "error",
                  message,
                  url: targetUrl,
                });
              } else {
                mcpTrace.push({
                  timestamp: new Date().toISOString(),
                  testCaseId: testCase.id,
                  step: "assert-text",
                  status: "ok",
                  message: `Text assertion passed (${actualText})`,
                  url: targetUrl,
                });
              }
            } catch (error) {
              const message = `Failed text assertion: ${error instanceof Error ? error.message : String(error)}`;
              caseErrors.push(message);
              mcpTrace.push({
                timestamp: new Date().toISOString(),
                testCaseId: testCase.id,
                step: "assert-text",
                status: "error",
                message,
                url: targetUrl,
              });
            }

            continue;
          }

          if (
            action.kind === "assertVisibleRole"
            || action.kind === "assertVisibleText"
            || action.kind === "assertVisibleTestId"
            || action.kind === "assertVisibleLocator"
          ) {
            try {
              if (action.kind === "assertVisibleRole" || action.kind === "assertVisibleText") {
                const snapshotResult = await client.callTool({ name: "browser_snapshot", arguments: {} });
                const snapshotText = getToolText(snapshotResult);
                const elements = parseSnapshotElements(snapshotText);

                const found = action.kind === "assertVisibleRole"
                  ? elements.some(
                    (element) => normalizeText(element.role) === normalizeText(action.role)
                      && normalizeText(element.name).includes(normalizeText(action.name)),
                  )
                  : elements.some((element) => normalizeText(element.name).includes(normalizeText(action.text)));

                if (!found) {
                  const expected = action.kind === "assertVisibleRole"
                    ? `${action.role}/${action.name}`
                    : action.text;
                  const message = `Visibility assertion failed. Element not found for '${expected}'`;
                  caseErrors.push(message);
                  mcpTrace.push({
                    timestamp: new Date().toISOString(),
                    testCaseId: testCase.id,
                    step: "assert-visible",
                    status: "error",
                    message,
                    url: targetUrl,
                  });
                } else {
                  mcpTrace.push({
                    timestamp: new Date().toISOString(),
                    testCaseId: testCase.id,
                    step: "assert-visible",
                    status: "ok",
                    message: "Visibility assertion passed via accessibility snapshot",
                    url: targetUrl,
                  });
                }

                continue;
              }

              const selector = action.kind === "assertVisibleTestId"
                ? `[data-testid="${action.testId}"]`
                : action.selector;
              const evalResult = await evaluateSelectorVisible(client, selector);

              if (!evalResult.ok) {
                const message = `Visibility assertion failed: ${evalResult.message}`;
                caseErrors.push(message);
                mcpTrace.push({
                  timestamp: new Date().toISOString(),
                  testCaseId: testCase.id,
                  step: "assert-visible",
                  status: "error",
                  message,
                  url: targetUrl,
                });
              } else {
                mcpTrace.push({
                  timestamp: new Date().toISOString(),
                  testCaseId: testCase.id,
                  step: "assert-visible",
                  status: "ok",
                  message: evalResult.message,
                  url: targetUrl,
                });
              }
            } catch (error) {
              const message = `Failed visibility assertion: ${error instanceof Error ? error.message : String(error)}`;
              caseErrors.push(message);
              mcpTrace.push({
                timestamp: new Date().toISOString(),
                testCaseId: testCase.id,
                step: "assert-visible",
                status: "error",
                message,
                url: targetUrl,
              });
            }

            continue;
          }
        }

        const snapshotResult = await client.callTool({ name: "browser_snapshot", arguments: {} });
        const snapshotText = getToolText(snapshotResult);
        const isValidSnapshot = snapshotText.length > 0 && hasMeaningfulSnapshotTree(snapshotText);

        if (!isValidSnapshot) {
          caseErrors.push("MCP snapshot was empty or invalid after action execution");
        }

        const caseDuration = Date.now() - start;
        totalDuration += caseDuration;

        allErrors.push(...caseErrors);

        const passed = caseErrors.length === 0;

        results.push({
          testCaseId: testCase.id,
          passed,
          errors: caseErrors,
          duration: caseDuration,
          filePattern,
        });

        logs.push(
          passed
            ? `[${filePattern}] MCP action execution passed (${targetUrl})`
            : `[${filePattern}] MCP action execution failed (${targetUrl})\n${caseErrors.join("\n")}`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const caseDuration = Date.now() - start;
        totalDuration += caseDuration;
        allErrors.push(message);

        mcpTrace.push({
          timestamp: new Date().toISOString(),
          testCaseId: testCase.id,
          step: "execute-case",
          status: "error",
          message,
          url: targetUrl,
        });

        results.push({
          testCaseId: testCase.id,
          passed: false,
          errors: [message],
          duration: caseDuration,
          filePattern,
        });

        logs.push(`[${filePattern}] ERROR: ${message}`);
      }
    }
  } finally {
    try {
      await client.callTool({ name: "browser_close", arguments: {} });
    } catch {
      // Ignore close errors.
    }
    await transport.close();
  }

  const passCount = results.filter((r) => r.passed).length;
  const failCount = results.filter((r) => !r.passed).length;

  return {
    results,
    passCount,
    failCount,
    totalDuration,
    combinedLogs: logs.join("\n").slice(0, 100_000),
    allErrors,
    mcpTrace,
  };
};

const executeInBackground = async (
  runId: string,
  cases: ExecutionTestCase[],
  engineUsed: ExecutionEngine,
) => {
  try {
    if (engineUsed === "mcp") {
      const mcpResult = await executeWithMcp(runId, cases);
      const status = mcpResult.failCount > 0 ? "failed" : "completed";

      await db.collection("testRuns").doc(runId).update({
        status,
        isRunning: false,
        passCount: mcpResult.passCount,
        failCount: mcpResult.failCount,
        totalDuration: mcpResult.totalDuration,
        logs: mcpResult.combinedLogs,
        screenshotUrls: [],
        caseResults: mcpResult.results,
        mcpTrace: mcpResult.mcpTrace,
        errorDetails: mcpResult.allErrors.join("\n").slice(0, 40_000),
        completedAt: FieldValue.serverTimestamp(),
      });

      for (const result of mcpResult.results) {
        await updateTestCaseStatus(result.testCaseId, result.passed ? "pass" : "fail");
      }

      return;
    }

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
        filePattern,
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
      caseResults: results,
      mcpTrace: [],
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
      caseResults: [],
      mcpTrace: [],
      errorDetails: message.slice(0, 40_000),
      completedAt: FieldValue.serverTimestamp(),
    });
  }
};

export const getTestRun = async (runId: string): Promise<Record<string, unknown> & { id: string }> => {
  const snap = await db.collection("testRuns").doc(runId).get();

  if (!snap.exists) {
    throw new Error("Test run not found");
  }

  return {
    id: snap.id,
    ...(snap.data() as Record<string, unknown>),
  };
};

export const startExecution = async (
  testCaseIds: string[],
  options: StartExecutionOptions = {},
): Promise<StartExecutionResult> => {
  const cases = await getTestCasesByIds(testCaseIds);
  if (!cases.length) {
    throw new Error("No valid test cases found for execution");
  }

  const resolution = resolveExecutionEngine(options.requestedEngine);

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
    caseResults: [],
    mcpTrace: [],
    engineRequested: resolution.engineRequested,
    engineUsed: resolution.engineUsed,
    fallbackReason: resolution.fallbackReason,
    errorDetails: "",
    startedAt: FieldValue.serverTimestamp(),
    completedAt: null,
  });

  for (const testCaseId of testCaseIds) {
    await updateTestCaseStatus(testCaseId, "running");
  }

  void executeInBackground(runRef.id, cases, resolution.engineUsed);

  return {
    runId: runRef.id,
    engineRequested: resolution.engineRequested,
    engineUsed: resolution.engineUsed,
    fallbackReason: resolution.fallbackReason || undefined,
  };
};
