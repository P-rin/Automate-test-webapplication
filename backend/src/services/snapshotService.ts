import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "node:crypto";
import { env } from "../config/env.js";
import { findBestSnapshotForCriterion } from "./criterionMatching.js";
import type { AcceptanceCriterion, GenerationPage } from "../types.js";

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

export interface SnapshotStep {
  title: string;
  snapshot: string;
  pageId?: string;
}

export interface AccessibilityDiscoveryResult {
  snapshots: SnapshotStep[];
  complete: boolean;
  stopReason?: string;
}

export interface PageDiscoveryResult {
  pages: GenerationPage[];
  complete: boolean;
  stopReason?: string;
}

export interface AccessibilityDiscoveryLimits {
  maxSnapshots: number;
  maxCandidates: number;
  maxDepth: number;
}

export interface PageDiscoveryLimits {
  maxPages: number;
  maxDepth: number;
  maxNavigationActions: number;
}

export interface BrowserSessionState {
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

export const parseBrowserEvaluateResult = (result: unknown): unknown => {
  const rawText = getToolText(result);
  const resultText = rawText.match(/(?:^|\n)### Result\s*\n([\s\S]*?)(?=\n### Ran Playwright code\b|$)/i)?.[1]?.trim()
    ?? rawText.trim();

  if (!resultText) {
    throw new Error("Playwright MCP returned an empty browser_evaluate result");
  }

  try {
    const parsed: unknown = JSON.parse(resultText);
    if (typeof parsed === "string") {
      try {
        return JSON.parse(parsed) as unknown;
      } catch {
        return parsed;
      }
    }
    return parsed;
  } catch {
    throw new Error("Playwright MCP returned a non-JSON browser_evaluate result");
  }
};

export const parseBrowserSessionState = (result: unknown): BrowserSessionState => {
  const value = parseBrowserEvaluateResult(result);
  if (typeof value !== "object" || value == null || Array.isArray(value)) {
    throw new Error("Playwright MCP returned an invalid browser session state");
  }

  const sessionState = value as Record<string, unknown>;
  const isStringRecord = (record: unknown): record is Record<string, string> =>
    typeof record === "object"
    && record != null
    && !Array.isArray(record)
    && Object.values(record).every((item) => typeof item === "string");
  if (!isStringRecord(sessionState.localStorage)
    || !isStringRecord(sessionState.sessionStorage)
    || typeof sessionState.cookie !== "string") {
    throw new Error("Playwright MCP returned an incomplete browser session state");
  }

  return {
    localStorage: sessionState.localStorage,
    sessionStorage: sessionState.sessionStorage,
    cookie: sessionState.cookie,
  };
};

export const buildBrowserSessionRestoreFunction = (state: BrowserSessionState): string => {
  const serializedState = JSON.stringify(JSON.stringify(state));
  return `() => {
    const state = JSON.parse(${serializedState});
    Object.entries(state.localStorage || {}).forEach(([key, value]) => window.localStorage.setItem(key, value));
    Object.entries(state.sessionStorage || {}).forEach(([key, value]) => window.sessionStorage.setItem(key, value));
    if (state.cookie) {
      state.cookie.split(/;\\s*/).filter(Boolean).forEach(cookie => {
        document.cookie = cookie;
      });
    }
  }`;
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
      function: `() => JSON.stringify({
        localStorage: Object.fromEntries(Object.entries(window.localStorage)),
        sessionStorage: Object.fromEntries(Object.entries(window.sessionStorage)),
        cookie: document.cookie,
      })`,
    },
  });

  const state = parseBrowserSessionState(result);
  const content = typeof result === "object" && result != null
    ? (result as { content?: unknown }).content
    : undefined;
  console.info("captureBrowserSessionState browser_evaluate response:", {
    contentTypes: Array.isArray(content)
      ? content.flatMap((item) => typeof item === "object" && item != null && typeof (item as { type?: unknown }).type === "string"
        ? [(item as { type: string }).type]
        : [])
      : [],
    localStorageKeys: Object.keys(state.localStorage),
    sessionStorageKeys: Object.keys(state.sessionStorage),
    cookiePresent: Boolean(state.cookie),
  });
  return state;
};

const restoreBrowserSessionState = async (client: Client, state: BrowserSessionState): Promise<void> => {
  await client.callTool({
    name: "browser_evaluate",
    arguments: {
      function: buildBrowserSessionRestoreFunction(state),
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

export const normalizePageUrl = (href: string, base: string): string | null => {
  const normalized = normalizeUrl(base, href);
  if (!normalized) return null;

  try {
    const url = new URL(normalized);
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.+|fbclid|gclid|ref|source)$/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return null;
  }
};

export const pageUrlPattern = (href: string): string => {
  const url = new URL(href);
  url.searchParams.sort();
  const pathname = url.pathname
    .replace(/\/\d+(?=\/|$)/g, "/:id")
    .replace(/\/[A-Za-z0-9_-]{16,}(?=\/|$)/g, "/:id");
  return `${url.origin}${pathname}${url.search}`;
};

const pageIdForPattern = (urlPattern: string): string =>
  `page-${createHash("sha256").update(urlPattern).digest("hex").slice(0, 12)}`;

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
      function: `() => JSON.stringify(Array.from(document.querySelectorAll('a[href], area[href]'))
        .map((element) => {
          return element.href;
        })
        .filter(Boolean))`,
    },
  });

  const links = parseBrowserEvaluateResult(result);
  if (!Array.isArray(links) || !links.every((item) => typeof item === "string")) {
    throw new Error("Playwright MCP returned an invalid internal links result");
  }
  console.info("collectInternalLinks browser_evaluate response:", {
    contentTypes: typeof result === "object" && result != null && Array.isArray((result as { content?: unknown }).content)
      ? ((result as { content: Array<{ type?: unknown }> }).content)
        .flatMap((item) => typeof item.type === "string" ? [item.type] : [])
      : [],
    linkCount: links.length,
    sampleLinks: links.slice(0, 5).map((href) => {
      const normalized = normalizeUrl(baseUrl, href);
      if (!normalized) return "";
      const safeUrl = new URL(normalized);
      safeUrl.search = "";
      return safeUrl.toString();
    }).filter(Boolean),
  });

  return links
  .map((href) => normalizePageUrl(href, baseUrl))
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

  const blockedTerms = [
    "login", "log in", "sign in", "register", "เข้าสู่ระบบ", "สมัคร",
    "logout", "ออกจากระบบ", "back", "ย้อนกลับ", "close", "cancel",
    "delete", "remove", "purchase", "checkout", "payment", "pay", "submit",
    "ลบ", "ชำระ", "ซื้อ", "ยืนยัน",
  ];
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

interface PageMetadata {
  title: string;
  heading: string;
  url: string;
  hasPasswordField: boolean;
}

interface PageDiscoveryData {
  metadata: PageMetadata;
  links: string[];
  navigationActions: string[];
}

const collectPageDiscoveryData = async (client: Client, baseUrl: string): Promise<PageDiscoveryData> => {
  const result = await client.callTool({
    name: "browser_evaluate",
    arguments: {
      function: `() => JSON.stringify((() => {
        const navigationTerms = ["menu", "dashboard", "home", "docs", "documentation", "เมนู", "หน้าแรก", "แดชบอร์ด"];
        const blockedTerms = ["login", "log in", "sign in", "register", "logout", "log out", "sign out", "delete", "remove", "purchase", "checkout", "payment", "pay", "submit", "เข้าสู่ระบบ", "สมัคร", "ออกจากระบบ", "ลบ", "ชำระ", "ซื้อ", "ยืนยัน"];
        const navigationActions = Array.from(document.querySelectorAll('button,[role="tab"],[role="menuitem"]'))
          .map(element => ({ element, name: (element.getAttribute("aria-label") || element.textContent || "").trim() }))
          .filter(({ element, name }) => {
            const text = name.toLocaleLowerCase();
            const rect = element.getBoundingClientRect();
            const isNavigationControl = element.getAttribute("role") === "tab"
              || element.getAttribute("role") === "menuitem"
              || Boolean(element.closest('nav,[role="navigation"]'));
            return Boolean(name)
              && rect.width > 0
              && rect.height > 0
              && isNavigationControl
              && !blockedTerms.some(term => text.includes(term))
              && navigationTerms.some(term => text.includes(term));
          })
          .map(({ name }) => name);
        return {
          metadata: {
            title: document.title || "",
            heading: document.querySelector("h1")?.textContent?.trim() || "",
            url: window.location.href,
            hasPasswordField: Boolean(document.querySelector('input[type="password"]')),
          },
          links: Array.from(document.querySelectorAll('a[href], area[href]')).map(element => element.href).filter(Boolean),
          navigationActions: [...new Set(navigationActions)],
        };
      })())`,
    },
  });
  const value = parseBrowserEvaluateResult(result);
  if (typeof value !== "object" || value == null || Array.isArray(value)) {
    throw new Error("Playwright MCP returned invalid page discovery data");
  }
  const record = value as Record<string, unknown>;
  const metadataValue = record.metadata;
  if (typeof metadataValue !== "object" || metadataValue == null || Array.isArray(metadataValue)
    || !Array.isArray(record.links) || !record.links.every((link) => typeof link === "string")
    || !Array.isArray(record.navigationActions) || !record.navigationActions.every((action) => typeof action === "string")) {
    throw new Error("Playwright MCP returned incomplete page discovery data");
  }
  const metadata = metadataValue as Record<string, unknown>;
  if (typeof metadata.title !== "string"
    || typeof metadata.heading !== "string"
    || typeof metadata.url !== "string"
    || typeof metadata.hasPasswordField !== "boolean") {
    throw new Error("Playwright MCP returned incomplete page metadata");
  }
  const links = (record.links as string[])
    .map((href) => normalizePageUrl(href, baseUrl))
    .filter((href): href is string => href !== null && isSameOrigin(baseUrl, href));
  console.info("discoverPages browser_evaluate response:", {
    linkCount: links.length,
    sampleLinks: links.slice(0, 5).map((href) => {
      const safeUrl = new URL(href);
      safeUrl.search = "";
      return safeUrl.toString();
    }),
    navigationActionCount: record.navigationActions.length,
  });
  return {
    metadata: {
      title: metadata.title,
      heading: metadata.heading,
      url: metadata.url,
      hasPasswordField: metadata.hasPasswordField,
    },
    links,
    navigationActions: record.navigationActions as string[],
  };
};

const loginRelatedText = (value: string): boolean =>
  ["login", "log in", "sign in", "เข้าสู่ระบบ"].some((term) => normalizeText(value).includes(term));

export const discoverPages = async (
  url: string,
  specification: string,
  acceptanceCriteria: AcceptanceCriterion[],
  limits: PageDiscoveryLimits = {
    maxPages: env.generationJobMaxPages,
    maxDepth: env.generationJobPageMaxDepth,
    maxNavigationActions: env.generationJobPageMaxNavigationActions,
  },
): Promise<PageDiscoveryResult> => {
  const { command, args } = resolvePlaywrightMcpLaunchConfig();
  const transport = new StdioClientTransport({ command, args });
  const client = new Client({ name: "autonomous-verification-backend", version: "1.0.0" });
  await client.connect(transport);

  try {
    const landingUrl = normalizePageUrl(url, url) ?? url;
    await client.callTool({ name: "browser_navigate", arguments: { url: landingUrl } });
    let authState: BrowserSessionState | null = null;
    if (parseCredentials(specification)) {
      const landingSnapshot = await collectSnapshot(client, "Page discovery login");
      const loginStep = await attemptLogin(client, specification, landingSnapshot.snapshot);
      if (loginStep) authState = await captureBrowserSessionState(client);
    }

    const queue = [{ url: landingUrl, depth: 0 }];
    const pagesByPattern = new Map<string, GenerationPage>();
    const headingsByPattern = new Map<string, string>();
    const visitedPatterns = new Set<string>();
    let incomplete = false;

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) break;
      const currentUrl = normalizePageUrl(current.url, landingUrl);
      if (!currentUrl || !isSameOrigin(landingUrl, currentUrl)) continue;
      const pattern = pageUrlPattern(currentUrl);
      if (visitedPatterns.has(pattern)) continue;
      visitedPatterns.add(pattern);

      if (pagesByPattern.size >= limits.maxPages) {
        incomplete = true;
        break;
      }

      try {
        if (authState) await restoreBrowserSessionState(client, authState);
        await client.callTool({ name: "browser_navigate", arguments: { url: currentUrl } });
        const pageData = await collectPageDiscoveryData(client, currentUrl);
        const metadata = pageData.metadata;
        const title = metadata.title || metadata.heading || currentUrl;
        const actualUrl = normalizePageUrl(metadata.url, currentUrl) ?? currentUrl;
        const loginRequired = metadata.hasPasswordField
          || (pageUrlPattern(actualUrl) !== pattern && loginRelatedText(`${title} ${metadata.heading} ${actualUrl}`));
        const page: GenerationPage = {
          pageId: pageIdForPattern(pattern),
          title,
          urlPattern: pattern,
          sampleUrl: currentUrl,
          depth: current.depth,
          requiresLogin: loginRequired,
          suggestedAcIds: [],
        };
        pagesByPattern.set(pattern, page);
        headingsByPattern.set(pattern, metadata.heading);

        if (loginRequired) continue;
        const childLinks = pageData.links.filter((childUrl) => pageUrlPattern(childUrl) !== pattern
          && !visitedPatterns.has(pageUrlPattern(childUrl)));
        if (current.depth >= limits.maxDepth) {
          if (childLinks.length > 0 || pageData.navigationActions.length > 0) incomplete = true;
          continue;
        }

        for (const childUrl of childLinks) {
          const childPattern = pageUrlPattern(childUrl);
          if (!visitedPatterns.has(childPattern)) {
            queue.push({ url: childUrl, depth: current.depth + 1 });
          }
        }

        if (limits.maxNavigationActions > 0) {
          const actions = pageData.navigationActions.slice(0, limits.maxNavigationActions);
          for (const action of actions) {
            await client.callTool({ name: "browser_navigate", arguments: { url: currentUrl } });
            if (authState) await restoreBrowserSessionState(client, authState);
            const clickResult = await client.callTool({
              name: "browser_evaluate",
              arguments: {
                function: `() => {
                  const targetName = ${JSON.stringify(action)}.replace(/\\s+/g, " ").trim().toLocaleLowerCase();
                  const target = Array.from(document.querySelectorAll('button,[role="tab"],[role="menuitem"]'))
                    .find(element => (element.getAttribute("aria-label") || element.textContent || "").replace(/\\s+/g, " ").trim().toLocaleLowerCase() === targetName);
                  if (target) target.click();
                  return new Promise(resolve => setTimeout(() => resolve(JSON.stringify(window.location.href)), 300));
                }`,
              },
            });
            const clickedUrl = parseBrowserEvaluateResult(clickResult);
            const destinationUrl = typeof clickedUrl === "string" ? normalizePageUrl(clickedUrl, currentUrl) : null;
            if (!destinationUrl || !isSameOrigin(landingUrl, destinationUrl)) continue;
            const destinationPattern = pageUrlPattern(destinationUrl);
            if (destinationPattern !== pattern && !visitedPatterns.has(destinationPattern)) {
              queue.push({ url: destinationUrl, depth: current.depth + 1 });
            }
          }
        }
      } catch (error) {
        incomplete = true;
        console.error(`discoverPages: failed to inspect ${currentUrl}:`, error instanceof Error ? error.message : error);
      }
    }

    const pages = [...pagesByPattern.values()];
    const matchesByAcId = new Map<string, string>();
    for (const criterion of acceptanceCriteria) {
      const match = findBestSnapshotForCriterion(criterion, pages.map((page) => ({
        ...page,
        snapshot: headingsByPattern.get(page.urlPattern) ?? "",
      })));
      if (match.snapshot && match.overlap > 0) matchesByAcId.set(criterion.id, match.snapshot.pageId);
    }
    for (const page of pages) {
      page.suggestedAcIds = [...matchesByAcId.entries()]
        .filter(([, suggestedPageId]) => suggestedPageId === page.pageId)
        .map(([acId]) => acId);
    }

    return {
      pages,
      complete: !incomplete && queue.length === 0,
      ...(!incomplete && queue.length === 0 ? {} : { stopReason: "Page discovery reached its page limit or could not inspect one or more pages" }),
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
  selectedPages?: GenerationPage[],
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
      if (selectedPages) {
        const clickedUrl = normalizePageUrl(extractUrlFromSnapshot(snapshotStep.snapshot), baseUrl);
        const selectedPage = clickedUrl
          ? selectedPages.find((page) => page.urlPattern === pageUrlPattern(clickedUrl))
          : undefined;
        if (!selectedPage) continue;
        snapshotStep.pageId = selectedPage.pageId;
      }
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

export const discoverSelectedPageSnapshots = async (
  url: string,
  specification: string,
  selectedPages: GenerationPage[],
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
    let authState: BrowserSessionState | null = null;
    if (parseCredentials(specification)) {
      await client.callTool({ name: "browser_navigate", arguments: { url } });
      const landingSnapshot = await collectSnapshot(client, "Selected-page login");
      const loginStep = await attemptLogin(client, specification, landingSnapshot.snapshot);
      if (loginStep) authState = await captureBrowserSessionState(client);
    }
    const knownSnapshots = new Set<string>();
    let examinedCandidates = 0;

    for (const page of selectedPages) {
      if (snapshots.length >= limits.maxSnapshots) {
        incomplete = true;
        break;
      }
      try {
        if (authState) await restoreBrowserSessionState(client, authState);
        await client.callTool({ name: "browser_navigate", arguments: { url: page.sampleUrl } });
        const baseSnapshot = await collectSnapshot(client, page.title);
        baseSnapshot.pageId = page.pageId;
        const baseFingerprint = snapshotFingerprint(baseSnapshot.snapshot);
        if (!knownSnapshots.has(baseFingerprint)) {
          snapshots.push(baseSnapshot);
          knownSnapshots.add(baseFingerprint);
        }

        const remainingCandidateBudget = Math.max(0, limits.maxCandidates - examinedCandidates);
        const remainingSnapshotBudget = Math.max(0, limits.maxSnapshots - snapshots.length);
        if (remainingCandidateBudget === 0 || remainingSnapshotBudget === 0) {
          if (getExplorationCandidates(baseSnapshot.snapshot).length > 0) incomplete = true;
          continue;
        }

        const exploration = await exploreClickableRoutes(
          client,
          baseSnapshot.snapshot,
          remainingCandidateBudget,
          remainingSnapshotBudget,
          authState,
          knownSnapshots,
          selectedPages,
        );
        examinedCandidates += exploration.examinedCandidates;
        snapshots.push(...exploration.snapshots);
        incomplete ||= exploration.incomplete;
      } catch (error) {
        incomplete = true;
        console.error(`discoverSelectedPageSnapshots: failed to inspect ${page.sampleUrl}:`, error instanceof Error ? error.message : error);
      }
    }

    return {
      snapshots,
      complete: !incomplete,
      ...(incomplete ? { stopReason: "Selected-page snapshot exploration reached a safety budget or a selected page could not be inspected" } : {}),
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
