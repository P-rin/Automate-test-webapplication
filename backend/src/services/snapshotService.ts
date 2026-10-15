import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { env } from "../config/env.js";

interface SnapshotElement {
  ref: string;
  role: string;
  name: string;
  line: string;
  label?: string;
}

interface CredentialPair {
  identifier: string;
  password: string;
}

interface SnapshotStep {
  title: string;
  snapshot: string;
}

export interface AccessibilityDiscoveryResult {
  snapshots: SnapshotStep[];
  complete: boolean;
  stopReason?: string;
}

export interface AccessibilityDiscoveryLimits {
  maxSnapshots: number;
  maxCandidates: number;
  maxDepth: number;
}

interface BrowserSessionState {
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  cookie: string;
}

const defaultMcpCommand = "playwright-mcp";

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

export const resolvePlaywrightMcpLaunchConfig = (): { command: string; args: string[] } => {
  const command = env.playwrightMcpCommand?.trim() || defaultMcpCommand;

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

const hasMeaningfulSnapshotTree = (snapshot: string): boolean => {
  const yamlMatch = snapshot.match(/### Snapshot\s*```yaml\s*([\s\S]*?)```/i);
  const yamlContent = yamlMatch?.[1]?.trim() ?? "";
  return yamlContent.length > 0;
};

const settlePage = async (client: Client, delayMs = 400): Promise<void> => {
  await client.callTool({
    name: "browser_evaluate",
    arguments: {
      function: `() => new Promise(resolve => setTimeout(() => resolve({ readyState: document.readyState, textLength: document.body ? document.body.innerText.length : 0 }), ${delayMs}))`,
    },
  });
};

const collectSnapshot = async (client: Client, title: string): Promise<SnapshotStep> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await settlePage(client, 400 + (attempt * 200));
    const snapshotResult = await client.callTool({ name: "browser_snapshot", arguments: {} });
    const snapshotText = getToolText(snapshotResult);

    if (snapshotText && hasMeaningfulSnapshotTree(snapshotText)) {
      return { title, snapshot: snapshotText };
    }
  }

  throw new Error("Playwright MCP returned an empty accessibility snapshot");
};

const captureBrowserSessionState = async (client: Client): Promise<BrowserSessionState> => {
  const result = await client.callTool({
    name: "browser_evaluate",
    arguments: {
      function: `() => ({
        localStorage: Object.fromEntries(Object.entries(window.localStorage)),
        sessionStorage: Object.fromEntries(Object.entries(window.sessionStorage)),
        cookie: document.cookie,
      })`,
    },
  });

  if (typeof result !== "object" || result == null) {
    return { localStorage: {}, sessionStorage: {}, cookie: "" };
  }

  const cookieValue = (result as { cookie?: unknown }).cookie;
  return {
    localStorage: (result as { localStorage?: Record<string, string> }).localStorage ?? {},
    sessionStorage: (result as { sessionStorage?: Record<string, string> }).sessionStorage ?? {},
    cookie: typeof cookieValue === "string" ? cookieValue : "",
  };
};

const restoreBrowserSessionState = async (client: Client, state: BrowserSessionState): Promise<void> => {
  await client.callTool({
    name: "browser_evaluate",
    arguments: {
      function: `(state) => {
        Object.entries(state.localStorage || {}).forEach(([key, value]) => window.localStorage.setItem(key, value));
        Object.entries(state.sessionStorage || {}).forEach(([key, value]) => window.sessionStorage.setItem(key, value));
        if (state.cookie) {
          document.cookie = state.cookie;
        }
      }`,
      args: [state],
    },
  });
};

const extractUrlFromSnapshot = (snapshot: string): string => {
  const match = snapshot.match(/Page URL:\s*(.+)/i);
  return match?.[1]?.trim() ?? "";
};

const normalizeUrl = (base: string, href: string): string | null => {
  try {
    return new URL(href, base).toString().replace(/#.*$/, "");
  } catch {
    return null;
  }
};

const isSameOrigin = (baseUrl: string, href: string): boolean => {
  try {
    const base = new URL(baseUrl);
    const candidate = new URL(href, base);
    return base.origin === candidate.origin;
  } catch {
    return false;
  }
};

const collectInternalLinks = async (client: Client, baseUrl: string): Promise<string[]> => {
  const result = await client.callTool({
    name: "browser_evaluate",
    arguments: {
      function: `() => Array.from(document.querySelectorAll('a[href], area[href], form[action]'))
        .map((element) => {
          const tag = element.tagName.toLowerCase();
          if (tag === 'form') {
            return element.getAttribute('action');
          }
          return element.href;
        })
        .filter(Boolean)`,
    },
  });

  if (!Array.isArray(result)) return [];

  return result
    .filter((item): item is string => typeof item === "string")
    .map((href) => normalizeUrl(baseUrl, href))
    .filter((href): href is string => {
      if (!href) return false;
      return isSameOrigin(baseUrl, href);
    });
};

const crawlInternalRoutes = async (
  client: Client,
  startUrls: string[],
  maxSnapshots: number,
  maxDepth: number,
  authState: BrowserSessionState | null,
): Promise<{ snapshots: SnapshotStep[]; incomplete: boolean }> => {
  const snapshots: SnapshotStep[] = [];
  const visited = new Set<string>();
  const queue = [...new Set(startUrls.filter(Boolean))].map((url) => ({ url, depth: 1 }));
  let incomplete = false;

  while (queue.length > 0 && snapshots.length < maxSnapshots) {
    const current = queue.shift()!;
    const currentUrl = current.url;
    if (visited.has(currentUrl)) continue;
    visited.add(currentUrl);

    try {
      if (authState) {
        try {
          await restoreBrowserSessionState(client, authState);
        } catch (authError) {
          console.error(`crawlInternalRoutes: failed to restore auth state for ${currentUrl}:`, authError instanceof Error ? authError.message : authError);
          throw authError;
        }
      }

      await client.callTool({ name: "browser_navigate", arguments: { url: currentUrl } });
      const snapshotStep = await collectSnapshot(client, `Route: ${currentUrl}`);
      snapshots.push(snapshotStep);

      if (snapshots.length >= maxSnapshots) break;

      const childLinks = await collectInternalLinks(client, currentUrl);
      if (current.depth < maxDepth) {
        for (const link of childLinks) {
          if (!visited.has(link) && !queue.some((item) => item.url === link)) {
            queue.push({ url: link, depth: current.depth + 1 });
          }
        }
      } else if (childLinks.some((link) => !visited.has(link))) {
        incomplete = true;
      }
    } catch (error) {
      console.warn(`crawlInternalRoutes: skipped ${currentUrl} due to error:`, error instanceof Error ? error.message : error);
      incomplete = true;
      continue;
    }
  }

  if (queue.some((item) => !visited.has(item.url))) {
    incomplete = true;
  }

  return { snapshots, incomplete };
};

const parseSnapshotElements = (snapshot: string): SnapshotElement[] => {
  const lines = snapshot.split(/\r?\n/);
  const elements: SnapshotElement[] = [];
  let lastTextLabel = "";

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith("- ")) continue;

    const refMatch = line.match(/\[ref=([^\]]+)\]/);
    if (!refMatch) continue;

    const ref = refMatch[1];
    const roleMatch = line.match(/^-\s*([a-zA-Z]+(?:\s+[a-zA-Z]+)*)/);
    const role = roleMatch?.[1]?.trim().toLowerCase() ?? "generic";

    const quotedName = line.match(/"([^"]+)"/);
    const trailingName = !quotedName ? line.match(/:\s*([^\[]+)\s*\[ref=/) : null;
    const name = (quotedName?.[1] ?? trailingName?.[1] ?? "").trim();

    const element: SnapshotElement = {
      ref,
      role,
      name,
      line,
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

    if (role === "paragraph" || role === "heading" || role === "label" || role === "text") {
      lastTextLabel = name;
      continue;
    }

    if (role !== "textbox") {
      lastTextLabel = "";
    }
  }

  return elements;
};

const normalizeText = (value: string): string => value.trim().toLowerCase();

const isPasswordLike = (value: string): boolean => {
  const lower = normalizeText(value);
  return lower.includes("password") || lower.includes("pass") || lower.includes("รหัสผ่าน");
};

const isEmailLike = (value: string): boolean => {
  const lower = normalizeText(value);
  return lower.includes("email") || lower.includes("e-mail") || lower.includes("อีเมล");
};

const isUserLike = (value: string): boolean => {
  const lower = normalizeText(value);
  return lower.includes("username") || lower.includes("user") || lower.includes("ชื่อผู้ใช้");
};

const extractValueFromLine = (line: string): string => {
  const pairMatch = line.match(/[:=|]\s*([^|\r\n]+)/);
  if (pairMatch?.[1]) {
    return pairMatch[1].trim();
  }

  const looseMatch = line.match(/(?:email|e-mail|username|user|อีเมล|ชื่อผู้ใช้|password|pass|รหัสผ่าน)\s+(.+)/i);
  return looseMatch?.[1]?.trim() ?? "";
};

const parseCredentials = (specification: string): CredentialPair | null => {
  if (!specification.trim()) return null;

  const emailMatch = specification.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  let identifier = emailMatch?.[0]?.trim() ?? "";

  const lines = specification.split(/\r?\n/);
  let password = "";

  for (const line of lines) {
    if (!identifier && (isEmailLike(line) || isUserLike(line))) {
      identifier = extractValueFromLine(line);
    }

    if (!isPasswordLike(line)) continue;
    password = extractValueFromLine(line);
    if (password) {
      break;
    }
  }

  if (!password) {
    const flatMatch = specification.match(/(?:password|pass|รหัสผ่าน)\s*[:=]\s*([^\s]+)/i);
    if (flatMatch?.[1]) {
      password = flatMatch[1].trim();
    }
  }

  if (!identifier || !password) return null;

  return {
    identifier,
    password,
  };
};

const findTextboxTarget = (elements: SnapshotElement[], matcher: (element: SnapshotElement) => boolean): string | null => {
  const match = elements.find((element) => element.role === "textbox" && matcher(element));
  return match?.ref ?? null;
};

const findLoginButtonTarget = (elements: SnapshotElement[]): string | null => {
  const loginTerms = ["เข้าสู่ระบบ", "login", "log in", "sign in", "submit"];
  const candidates = elements.filter((element) => element.role === "button");
  const match = candidates.find((element) => loginTerms.some((term) => normalizeText(element.name).includes(term)));
  return match?.ref ?? null;
};

const summarizeSnapshotStep = (step: SnapshotStep): string => {
  return [
    `## ${step.title}`,
    step.snapshot,
  ].join("\n");
};

const attemptLogin = async (
  client: Client,
  specification: string,
  initialSnapshot: string,
): Promise<SnapshotStep | null> => {
  const credentials = parseCredentials(specification);
  if (!credentials) return null;

  const elements = parseSnapshotElements(initialSnapshot);
  const emailTarget = findTextboxTarget(
    elements,
    (element) => isEmailLike(element.name) || isEmailLike(element.label ?? "") || element.name.includes("@"),
  ) ?? elements.filter((element) => element.role === "textbox")[0]?.ref;
  const passwordTarget = findTextboxTarget(
    elements,
    (element) => isPasswordLike(element.name) || isPasswordLike(element.label ?? ""),
  ) ?? elements.filter((element) => element.role === "textbox")[1]?.ref;
  const loginButtonTarget = findLoginButtonTarget(elements);

  if (!emailTarget || !passwordTarget || !loginButtonTarget) {
    return null;
  }

  await client.callTool({
    name: "browser_fill_form",
    arguments: {
      fields: [
        { target: emailTarget, name: "email", type: "textbox", value: credentials.identifier },
        { target: passwordTarget, name: "password", type: "textbox", value: credentials.password },
      ],
    },
  });
  await client.callTool({ name: "browser_click", arguments: { target: loginButtonTarget } });

  try {
    await client.callTool({ name: "browser_press_key", arguments: { key: "Tab" } });
  } catch {
    // Ignore action stabilization errors and continue with snapshot capture.
  }

  return collectSnapshot(client, "After login attempt");
};

const shouldExploreElement = (element: SnapshotElement): boolean => {
  if (!["button", "link", "tab", "menuitem", "menuitemcheckbox", "menuitemradio"].includes(element.role)) return false;

  const name = normalizeText(element.name);
  if (!name) return false;

  const blockedTerms = ["login", "log in", "sign in", "register", "เข้าสู่ระบบ", "สมัคร", "logout", "ออกจากระบบ", "back", "ย้อนกลับ", "close", "cancel"];
  if (blockedTerms.some((term) => name.includes(term))) return false;

  return true;
};

const getExplorationCandidates = (snapshot: string): SnapshotElement[] => {
  const seen = new Set<string>();
  const candidates: SnapshotElement[] = [];

  for (const element of parseSnapshotElements(snapshot)) {
    if (!shouldExploreElement(element)) continue;
    const key = `${element.role}:${normalizeText(element.name)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(element);
  }

  return candidates;
};

const snapshotFingerprint = (snapshot: string): string => {
  const url = extractUrlFromSnapshot(snapshot);
  const normalizedTree = snapshot
    .replace(/\[ref=[^\]]+\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return `${url}\n${normalizedTree}`;
};

const exploreClickableRoutes = async (
  client: Client,
  baseSnapshot: string,
  maxCandidates: number,
  remainingBudget: number,
  authState: BrowserSessionState | null,
  knownSnapshots: Set<string>,
): Promise<{ snapshots: SnapshotStep[]; incomplete: boolean; examinedCandidates: number }> => {
  const steps: SnapshotStep[] = [];
  const baseUrl = extractUrlFromSnapshot(baseSnapshot);
  const allCandidates = getExplorationCandidates(baseSnapshot);
  const candidates = allCandidates.slice(0, maxCandidates);
  let incomplete = allCandidates.length > candidates.length;
  if (remainingBudget <= 0) {
    return { snapshots: steps, incomplete: incomplete || allCandidates.length > 0, examinedCandidates: 0 };
  }

  let examinedCandidates = 0;
  for (const candidate of candidates) {
    if (steps.length >= remainingBudget) {
      incomplete = true;
      break;
    }

    try {
      await client.callTool({ name: "browser_navigate", arguments: { url: baseUrl } });
      if (authState) await restoreBrowserSessionState(client, authState);
      const freshSnapshot = await collectSnapshot(client, "Refresh interactive state");
      const candidateKey = `${candidate.role}:${normalizeText(candidate.name)}`;
      const freshCandidate = getExplorationCandidates(freshSnapshot.snapshot)
        .find((element) => `${element.role}:${normalizeText(element.name)}` === candidateKey);
      if (!freshCandidate) {
        examinedCandidates += 1;
        incomplete = true;
        continue;
      }

      await client.callTool({ name: "browser_click", arguments: { target: freshCandidate.ref } });
      const snapshotStep = await collectSnapshot(client, `Explore: ${candidate.name}`);
      examinedCandidates += 1;
      const fingerprint = snapshotFingerprint(snapshotStep.snapshot);
      if (!knownSnapshots.has(fingerprint)) {
        knownSnapshots.add(fingerprint);
        steps.push(snapshotStep);
      }
    } catch {
      examinedCandidates += 1;
      incomplete = true;
    }
  }

  return { snapshots: steps, incomplete, examinedCandidates };
};

export const discoverAccessibilitySnapshot = async (
  url: string,
  specification = "",
  limits: AccessibilityDiscoveryLimits = {
    maxSnapshots: env.generationJobMaxSnapshots,
    maxCandidates: env.generationJobMaxCandidates,
    maxDepth: env.generationJobMaxDepth,
  },
): Promise<AccessibilityDiscoveryResult> => {
  const { command, args } = resolvePlaywrightMcpLaunchConfig();
  const transport = new StdioClientTransport({ command, args });
  const client = new Client({ name: "autonomous-verification-backend", version: "1.0.0" });

  await client.connect(transport);

  try {
    const snapshots: SnapshotStep[] = [];
    let incomplete = false;
    await client.callTool({ name: "browser_navigate", arguments: { url } });
    const landingStep = await collectSnapshot(client, "Landing page");
    snapshots.push(landingStep);

    const loginStep = await attemptLogin(client, specification, landingStep.snapshot);
    const authState = loginStep ? await captureBrowserSessionState(client) : null;
    if (loginStep) {
      snapshots.push(loginStep);
    }

    const explorationBase = loginStep?.snapshot ?? landingStep.snapshot;
    const baseUrl = extractUrlFromSnapshot(explorationBase) || url;
    const routeUrls = await collectInternalLinks(client, baseUrl);
    const remainingBudget = Math.max(0, limits.maxSnapshots - snapshots.length);

    if (routeUrls.length > 0 && remainingBudget > 0) {
      const routeResult = await crawlInternalRoutes(
        client,
        routeUrls,
        remainingBudget,
        limits.maxDepth,
        authState,
      );
      snapshots.push(...routeResult.snapshots);
      incomplete ||= routeResult.incomplete;
    } else if (routeUrls.length > 0) {
      incomplete = true;
    }

    const knownSnapshots = new Set(snapshots.map((step) => snapshotFingerprint(step.snapshot)));
    let stateIndex = 0;
    let examinedCandidates = 0;
    while (stateIndex < snapshots.length) {
      const stateSnapshot = snapshots[stateIndex].snapshot;
      const availableCandidates = getExplorationCandidates(stateSnapshot).length;
      const remainingCandidateBudget = Math.max(0, limits.maxCandidates - examinedCandidates);
      const remainingSnapshotBudget = Math.max(0, limits.maxSnapshots - snapshots.length);
      if (remainingCandidateBudget === 0 || remainingSnapshotBudget === 0) {
        if (availableCandidates > 0) incomplete = true;
        if (incomplete) break;
        stateIndex += 1;
        continue;
      }

      const explorationResult = await exploreClickableRoutes(
        client,
        stateSnapshot,
        remainingCandidateBudget,
        remainingSnapshotBudget,
        authState,
        knownSnapshots,
      );
      examinedCandidates += explorationResult.examinedCandidates;
      snapshots.push(...explorationResult.snapshots);
      incomplete ||= explorationResult.incomplete;
      stateIndex += 1;
      if (incomplete && (examinedCandidates >= limits.maxCandidates || snapshots.length >= limits.maxSnapshots)) break;
    }

    return {
      snapshots,
      complete: !incomplete,
      ...(incomplete ? { stopReason: "Exploration safety budget reached or a discovered page/state could not be inspected" } : {}),
    };
  } finally {
    try {
      await client.callTool({ name: "browser_close", arguments: {} });
    } catch {
      // Ignore close errors to avoid masking the root cause.
    }
    await transport.close();
  }
};

export const fetchAccessibilitySnapshot = async (url: string, specification = ""): Promise<string> => {
  const result = await discoverAccessibilitySnapshot(url, specification, {
    maxSnapshots: env.playwrightExploreMaxSnapshots,
    maxCandidates: env.playwrightExploreMaxCandidates,
    maxDepth: env.playwrightExploreMaxDepth,
  });
  return result.snapshots.map(summarizeSnapshotStep).join("\n\n");
};
