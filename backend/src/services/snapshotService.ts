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

interface BrowserSessionState {
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  cookie: string;
}

const defaultMcpCommand = process.platform === "win32" ? "npx.cmd" : "npx";

const buildDefaultMcpArgs = (): string[] => {
  const args = ["-y", "@playwright/mcp@latest"];

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
  const command = env.playwrightMcpCommand?.trim() || defaultMcpCommand;
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
): Promise<SnapshotStep[]> => {
  const snapshots: SnapshotStep[] = [];
  const visited = new Set<string>();
  const queue = [...new Set(startUrls.filter(Boolean))].map((url) => ({ url, depth: 1 }));

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

      if (current.depth < maxDepth) {
        const childLinks = await collectInternalLinks(client, currentUrl);
        for (const link of childLinks) {
          if (!visited.has(link) && !queue.some((item) => item.url === link)) {
            queue.push({ url: link, depth: current.depth + 1 });
          }
        }
      }
    } catch (error) {
      console.warn(`crawlInternalRoutes: skipped ${currentUrl} due to error:`, error instanceof Error ? error.message : error);
      continue;
    }
  }

  return snapshots;
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

const exploreClickableRoutes = async (
  client: Client,
  baseSnapshot: string,
  maxCandidates: number,
  remainingBudget: number,
): Promise<SnapshotStep[]> => {
  const steps: SnapshotStep[] = [];
  if (remainingBudget <= 0) return steps;

  const baseUrl = extractUrlFromSnapshot(baseSnapshot);
  const candidates = getExplorationCandidates(baseSnapshot).slice(0, maxCandidates);

  for (const candidate of candidates) {
    if (steps.length >= remainingBudget) break;

    try {
      await client.callTool({ name: "browser_click", arguments: { target: candidate.ref } });
      const snapshotStep = await collectSnapshot(client, `Explore: ${candidate.name}`);
      const nextUrl = extractUrlFromSnapshot(snapshotStep.snapshot);
      if (snapshotStep.snapshot !== baseSnapshot) {
        steps.push(snapshotStep);
      }
      if (nextUrl && baseUrl && nextUrl !== baseUrl) {
        await client.callTool({ name: "browser_navigate_back", arguments: {} });
        await collectSnapshot(client, `Returned from: ${candidate.name}`);
      }
    } catch {
      // Ignore non-interactable or unstable targets and keep exploring others.
    }
  }

  return steps;
};

export const fetchAccessibilitySnapshot = async (url: string, specification = ""): Promise<string> => {
  const { command, args } = resolveMcpCommand();
  const transport = new StdioClientTransport({ command, args });
  const client = new Client({ name: "autonomous-verification-backend", version: "1.0.0" });

  await client.connect(transport);

  try {
    const snapshots: SnapshotStep[] = [];
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
    const remainingBudget = Math.max(0, env.playwrightExploreMaxSnapshots - snapshots.length);

    if (routeUrls.length > 0 && remainingBudget > 0) {
      const routeSnapshots = await crawlInternalRoutes(
        client,
        routeUrls,
        remainingBudget,
        env.playwrightExploreMaxDepth,
        authState,
      );
      snapshots.push(...routeSnapshots);
    }

    const fallbackBudget = Math.max(0, env.playwrightExploreMaxSnapshots - snapshots.length);
    if (fallbackBudget > 0) {
      const explorationSteps = await exploreClickableRoutes(
        client,
        explorationBase,
        env.playwrightExploreMaxCandidates,
        fallbackBudget,
      );
      snapshots.push(...explorationSteps);
    }

    return snapshots.map(summarizeSnapshotStep).join("\n\n");
  } finally {
    try {
      await client.callTool({ name: "browser_close", arguments: {} });
    } catch {
      // Ignore close errors to avoid masking the root cause.
    }
    await transport.close();
  }
};
