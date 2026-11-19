import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "node:crypto";
import { env } from "../config/env.js";
import { findBestSnapshotForCriterion } from "./criterionMatching.js";
import type { AcceptanceCriterion, GenerationPage } from "../types.js";
import type { LoginCredentials } from "./credentialService.js";

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

/**
 * Adds --isolated unless the args already pick a browser profile. Without it Playwright MCP
 * reuses one persistent profile for every session, so cookies and localStorage (a site's
 * cart, a logged-in session) leak from one job or run into the next, and snapshots and
 * test results depend on whatever an earlier session left behind.
 */
export const withIsolatedBrowserProfile = (args: string[]): string[] => (
  args.some((arg) => arg === "--isolated" || arg === "--user-data-dir" || arg.startsWith("--user-data-dir="))
    ? args
    : [...args, "--isolated"]
);

export const resolvePlaywrightMcpLaunchConfig = (): { command: string; args: string[] } => {
  const command = env.playwrightMcpCommand?.trim() || defaultMcpCommand;

  if (isNpxCommand(command)) {
    throw new Error("PLAYWRIGHT_MCP_COMMAND cannot be npx. Use a direct MCP binary (for example: playwright-mcp).");
  }

  const args = withIsolatedBrowserProfile(env.playwrightMcpArgs.length ? env.playwrightMcpArgs : buildDefaultMcpArgs());

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
    // Start from exactly the saved state: keys added since (e.g. a cart filled by an
    // explored click) would otherwise leak into every later snapshot.
    window.localStorage.clear();
    window.sessionStorage.clear();
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

export const settlePage = async (client: Client, delayMs = 400): Promise<void> => {
  await client.callTool({
    name: "browser_evaluate",
    arguments: {
      function: `() => new Promise(resolve => setTimeout(() => resolve({ readyState: document.readyState, textLength: document.body ? document.body.innerText.length : 0 }), ${delayMs}))`,
    },
  });
};

export interface TestIdEntry {
  attr: string;
  value: string;
  tag: string;
  count: number;
  text: string;
}

const TEST_ID_ATTRIBUTES = ["data-test", "data-testid", "data-test-id", "data-qa", "data-cy", "id"];
const MAX_TEST_ID_ENTRIES = 60;
// Page wrappers (root, page_wrapper) contain most tagged elements and only add noise.
const MAX_TAGGED_DESCENDANTS = 30;

/**
 * Collects the visible elements' test attributes. The accessibility snapshot does not show
 * DOM attributes, so without this list the generator guesses names like `inventory_item`.
 */
export const COLLECT_TEST_IDS_FUNCTION = `() => {
  const attributes = ${JSON.stringify(TEST_ID_ATTRIBUTES)};
  const selector = attributes.map(attr => "[" + attr + "]").join(",");
  const groups = new Map();
  for (const element of document.querySelectorAll(selector)) {
    if (element.getClientRects().length === 0) continue;
    if (element.querySelectorAll(selector).length > ${MAX_TAGGED_DESCENDANTS}) continue;
    const attr = attributes.find(name => element.getAttribute(name));
    if (!attr) continue;
    const value = element.getAttribute(attr).trim();
    // Skip framework-generated ids (React :r1:, ember123, long numbers): they change between loads.
    if (!value || value.length > 80 || (attr === "id" && /^[:_]|^ember|^react|\\d{4,}/i.test(value))) continue;
    const key = attr + "=" + value;
    const group = groups.get(key);
    if (group) { group.count += 1; continue; }
    const text = String(element.innerText || element.getAttribute("value") || element.getAttribute("placeholder") || "")
      .replace(/\\s+/g, " ").trim().slice(0, 40);
    groups.set(key, { attr, value, tag: element.tagName.toLowerCase(), count: 1, text });
  }
  return JSON.stringify([...groups.values()].slice(0, ${MAX_TEST_ID_ENTRIES}));
}`;

/**
 * The section shares the generator's snapshot budget (~6.5k chars) with the YAML tree, so it
 * is capped. Repeated containers (for scoping same-name buttons) and form controls go first.
 */
export const TEST_ID_SECTION_MAX_CHARS = 1500;
const testIdPriority = (entry: TestIdEntry): number => {
  if (entry.count > 1) return 0;
  if (["input", "select", "textarea", "button"].includes(entry.tag)) return 1;
  if (entry.tag === "a") return 2;
  return entry.tag === "img" ? 4 : 3;
};

export const formatTestIdSection = (entries: TestIdEntry[], maxChars = TEST_ID_SECTION_MAX_CHARS): string => {
  if (entries.length === 0) return "";
  const header = [
    "### Test IDs",
    "DOM attributes (not in the tree below). Use only as written: page.locator('[data-test=\"value\"]').",
  ];
  const ranked = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => testIdPriority(a.entry) - testIdPriority(b.entry) || a.index - b.index);
  const lines: string[] = [];
  let length = header.join("\n").length;
  for (const { entry } of ranked) {
    const repeat = entry.count > 1 ? ` x${entry.count}` : "";
    const text = entry.text ? ` "${entry.text.slice(0, 30)}"` : "";
    const line = `- [${entry.attr}="${entry.value}"] <${entry.tag}>${repeat}${text}`;
    if (length + line.length + 1 > maxChars) {
      lines.push(`- (${ranked.length - lines.length} more omitted)`);
      break;
    }
    lines.push(line);
    length += line.length + 1;
  }
  return [...header, ...lines, ""].join("\n");
};

/** Puts the section before the YAML tree so prompt truncation, which cuts the tail, keeps it. */
export const insertTestIdSection = (snapshot: string, section: string): string => {
  if (!section) return snapshot;
  const index = snapshot.indexOf("### Snapshot");
  return index >= 0
    ? `${snapshot.slice(0, index)}${section}${snapshot.slice(index)}`
    : `${snapshot}\n${section}`;
};

/** One interactive element's DOM attributes (the accessibility snapshot does not show them). */
export interface ElementAttributeEntry {
  /** Explicit role, or the implicit role of the tag/type (searchbox, spinbutton, textbox, combobox, ...). */
  role: string;
  /** Approximate accessible name: aria-label, label text, content text with image alt, placeholder, title. */
  name: string;
  tag: string;
  type?: string;
  placeholder?: string;
  htmlName?: string;
  id?: string;
  autocomplete?: string;
  inputMode?: string;
  required?: boolean;
  disabled?: boolean;
  min?: string;
  max?: string;
  maxLength?: number;
  pattern?: string;
  testId?: string;
  /** "search" when inside role=search / a search form. */
  formRole?: string;
  /** Labels of up to 3 buttons in the same form (e.g. "Apply" next to a coupon field). */
  formButtons?: string[];
}

export const ELEMENT_ATTRIBUTES_MAX_ENTRIES = 150;

/**
 * Read-only: collects attributes of visible interactive elements in document order. Used by the e-commerce
 * element classifier (ECOMMERCE_TESTGEN_CONTEXT.md Phase 3a); never clicks or changes the page.
 */
export const COLLECT_ELEMENT_ATTRS_FUNCTION = `() => {
  const selector = "input:not([type=hidden]), select, textarea, button, a[href], [role=button], [role=link], [role=textbox], [role=searchbox], [role=combobox], [role=spinbutton], [role=checkbox], [role=radio], [role=switch], [contenteditable=true]";
  const clean = (value, max) => String(value || "").replace(/\\s+/g, " ").trim().slice(0, max || 80);
  const implicitRole = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.split(" ")[0];
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return el.multiple || el.size > 1 ? "listbox" : "combobox";
    if (tag === "input") {
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "number") return "spinbutton";
      if (type === "range") return "slider";
      if (type === "search") return el.getAttribute("list") ? "combobox" : "searchbox";
      return el.getAttribute("list") ? "combobox" : "textbox";
    }
    return el.isContentEditable ? "textbox" : tag;
  };
  const contentText = (node) => {
    let text = "";
    for (const child of node.childNodes) {
      if (child.nodeType === 3) text += " " + child.textContent;
      else if (child.nodeType === 1) {
        if (child.getAttribute("aria-hidden") === "true") continue;
        if (child.tagName === "IMG") text += " " + (child.getAttribute("alt") || "");
        else text += " " + contentText(child);
      }
    }
    return text;
  };
  const accessibleName = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy.split(/\\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((node) => node.textContent).join(" ");
      if (clean(text)) return clean(text);
    }
    if (el.labels && el.labels.length) {
      const text = Array.from(el.labels).map((label) => contentText(label)).join(" ");
      if (clean(text)) return clean(text);
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "input" && ["button", "submit", "reset"].includes((el.type || "").toLowerCase())) return clean(el.value);
    if (!["input", "select", "textarea"].includes(tag)) {
      const text = clean(contentText(el));
      if (text) return text;
    }
    return clean(el.getAttribute("placeholder") || el.getAttribute("title") || "");
  };
  const testIdOf = (el) => ["data-test", "data-testid", "data-test-id", "data-qa", "data-cy"].map((attr) => el.getAttribute(attr)).find(Boolean) || "";
  const entries = [];
  for (const el of document.querySelectorAll(selector)) {
    if (entries.length >= ${ELEMENT_ATTRIBUTES_MAX_ENTRIES}) break;
    if (el.getClientRects().length === 0) continue;
    const form = el.closest("form");
    const searchScope = el.closest("[role=search]") || (form && (form.getAttribute("role") === "search" || /search/i.test(form.getAttribute("action") || "")) ? form : null);
    const entry = { role: implicitRole(el), name: accessibleName(el), tag: el.tagName.toLowerCase() };
    const put = (key, value) => { if (value !== undefined && value !== null && value !== "" && value !== false) entry[key] = value; };
    put("type", (el.getAttribute("type") || "").toLowerCase());
    put("placeholder", clean(el.getAttribute("placeholder")));
    put("htmlName", clean(el.getAttribute("name"), 40));
    put("id", clean(el.id, 40));
    put("autocomplete", clean(el.getAttribute("autocomplete"), 40));
    put("inputMode", clean(el.getAttribute("inputmode"), 20));
    put("required", el.required === true || el.getAttribute("aria-required") === "true");
    put("disabled", el.disabled === true || el.getAttribute("aria-disabled") === "true");
    put("min", clean(el.getAttribute("min"), 20));
    put("max", clean(el.getAttribute("max"), 20));
    const maxLength = Number(el.getAttribute("maxlength"));
    if (maxLength > 0) entry.maxLength = maxLength;
    put("pattern", clean(el.getAttribute("pattern"), 80));
    put("testId", clean(testIdOf(el), 60));
    put("formRole", searchScope ? "search" : "");
    if (form && !["button", "a"].includes(entry.tag)) {
      const buttons = Array.from(form.querySelectorAll("button, input[type=submit], input[type=button]"))
        .filter((button) => button !== el).map((button) => accessibleName(button)).filter(Boolean).slice(0, 3);
      if (buttons.length) entry.formButtons = buttons;
    }
    entries.push(entry);
  }
  return JSON.stringify(entries);
}`;

export const ELEMENT_ATTRIBUTES_HEADER = "### Element Attributes";

/** Appended after the YAML tree so legacy prompt truncation (which keeps the head) never depends on it. */
export const appendElementAttributeSection = (snapshot: string, entries: ElementAttributeEntry[]): string =>
  entries.length === 0
    ? snapshot
    : `${snapshot.trimEnd()}\n${ELEMENT_ATTRIBUTES_HEADER}\n\`\`\`json\n${JSON.stringify(entries)}\n\`\`\`\n`;

const collectElementAttributes = async (client: Client): Promise<ElementAttributeEntry[]> => {
  try {
    const result = await client.callTool({ name: "browser_evaluate", arguments: { function: COLLECT_ELEMENT_ATTRS_FUNCTION } });
    const entries = parseBrowserEvaluateResult(result);
    return Array.isArray(entries) ? entries as ElementAttributeEntry[] : [];
  } catch (error) {
    console.warn("collectElementAttributes failed; continuing without element attributes:", error instanceof Error ? error.message : error);
    return [];
  }
};

const collectTestIdSection = async (client: Client): Promise<string> => {
  try {
    const result = await client.callTool({ name: "browser_evaluate", arguments: { function: COLLECT_TEST_IDS_FUNCTION } });
    const entries = parseBrowserEvaluateResult(result);
    return Array.isArray(entries) ? formatTestIdSection(entries as TestIdEntry[]) : "";
  } catch (error) {
    console.warn("collectTestIdSection failed; continuing without test IDs:", error instanceof Error ? error.message : error);
    return "";
  }
};

export const collectSnapshot = async (client: Client, title: string): Promise<SnapshotStep> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await settlePage(client, 400 + (attempt * 200));
    const snapshotResult = await client.callTool({ name: "browser_snapshot", arguments: {} });
    const snapshotText = getToolText(snapshotResult);

    if (snapshotText && hasMeaningfulSnapshotTree(snapshotText)) {
      const withTestIds = insertTestIdSection(snapshotText, await collectTestIdSection(client));
      // E-commerce mode only: legacy snapshots (and therefore legacy prompts) stay unchanged.
      const snapshot = env.generationMode === "ecommerce"
        ? appendElementAttributeSection(withTestIds, await collectElementAttributes(client))
        : withTestIds;
      return { title, snapshot };
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
  // ?id=4 and ?id=5 are the same page template, just like /items/4 and /items/5.
  for (const [key, value] of [...url.searchParams.entries()]) {
    if (/^\d+$/.test(value) || /^[A-Za-z0-9_-]{16,}$/.test(value)) url.searchParams.set(key, ":id");
  }
  const pathname = url.pathname
    .replace(/\/\d+(?=\/|$)/g, "/:id")
    .replace(/\/[A-Za-z0-9_-]{16,}(?=\/|$)/g, "/:id");
  return `${url.origin}${pathname}${decodeURIComponent(url.search)}`;
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

/**
 * Credentials entered on the setup page win; otherwise fall back to credentials written
 * in the specification text (legacy behavior).
 */
export const resolveLoginCredentials = (
  specification: string,
  loginCredentials?: LoginCredentials | null,
): CredentialPair | null => loginCredentials
  ? { identifier: loginCredentials.username, password: loginCredentials.password }
  : parseCredentials(specification);

export const attemptLogin = async (
  client: Client,
  credentials: CredentialPair | null,
  initialSnapshot: string,
): Promise<SnapshotStep | null> => {
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

  const step = await collectSnapshot(client, "After login attempt");
  // A failed login leaves the typed values in the form; keep the password out of the
  // snapshot that is stored and sent to the LLM.
  return { ...step, snapshot: step.snapshot.split(credentials.password).join("********") };
};

/**
 * Controls discovery must never click: they log in/out, leave the page, or change data.
 * A data-changing click (e.g. "Add to cart") leaves the page in a modified state, and that
 * state then ends up in the snapshots that test plans and scripts are written from.
 * English terms match whole words ("add" blocks "Add to cart", not "Address book");
 * Thai has no word spacing, so Thai terms match anywhere in the name.
 */
export const DISCOVERY_BLOCKED_TERMS = [
  // session and navigation away
  "login", "log in", "sign in", "register", "sign up", "logout", "log out", "sign out",
  "back", "close", "cancel",
  // data-changing actions
  "add", "remove", "delete", "save", "update", "submit", "send", "post", "apply", "reset", "clear",
  "purchase", "checkout", "payment", "pay", "buy", "order", "book", "subscribe", "upload", "confirm",
  // No "ปิด" (close): it would also match "เปิด" (open).
  "เข้าสู่ระบบ", "สมัคร", "ออกจากระบบ", "ย้อนกลับ", "ยกเลิก",
  "เพิ่ม", "ลบ", "บันทึก", "ส่ง", "ยืนยัน", "ชำระ", "ซื้อ", "สั่ง", "จอง", "อัปโหลด", "รีเซ็ต", "ล้าง",
];

/** Browser-side and Node-side check for DISCOVERY_BLOCKED_TERMS (inlined into page scripts). */
const IS_BLOCKED_ACTION_NAME_JS = `(name => {
  const text = String(name).toLocaleLowerCase();
  return ${JSON.stringify(DISCOVERY_BLOCKED_TERMS)}.some(term => /^[a-z ]+$/.test(term)
    ? new RegExp("(^|[^a-z])" + term + "([^a-z]|$)").test(text)
    : text.includes(term));
})`;

export const isBlockedDiscoveryAction: (name: string) => boolean = new Function(
  `return ${IS_BLOCKED_ACTION_NAME_JS};`,
)() as (name: string) => boolean;

const shouldExploreElement = (element: SnapshotElement): boolean => {
  if (!["button", "link", "tab", "menuitem", "menuitemcheckbox", "menuitemradio"].includes(element.role)) return false;

  const name = normalizeText(element.name);
  if (!name) return false;

  return !isBlockedDiscoveryAction(name);
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

/**
 * Browser-side function that names a clickable element. Shared by the discovery scan and the
 * click step so both identify the same element. Falls back to title / data-test / id for
 * icon-only links such as a cart icon.
 */
const ELEMENT_ACTION_NAME_JS = `element => (
  element.getAttribute("aria-label")
  || element.textContent
  || element.getAttribute("title")
  || element.getAttribute("data-test")
  || element.getAttribute("data-testid")
  || element.id
  || ""
).replace(/\\s+/g, " ").trim()`;

const collectPageDiscoveryData = async (client: Client, baseUrl: string): Promise<PageDiscoveryData> => {
  const result = await client.callTool({
    name: "browser_evaluate",
    arguments: {
      function: `() => JSON.stringify((() => {
        const navigationTerms = ["menu", "dashboard", "home", "docs", "documentation", "เมนู", "หน้าแรก", "แดชบอร์ด"];
        const isBlockedActionName = ${IS_BLOCKED_ACTION_NAME_JS};
        // Links whose destination is decided by JavaScript (href="#", javascript:, no href,
        // or role="link") are invisible to the href crawl, so they are clicked instead.
        const isScriptLink = element => {
          if (element.tagName === "A") {
            const href = (element.getAttribute("href") || "").trim();
            return !href || href === "#" || href.toLowerCase().startsWith("javascript:");
          }
          return element.getAttribute("role") === "link";
        };
        const elementActionName = ${ELEMENT_ACTION_NAME_JS};
        // Repeated items (item-4-title-link, item-5-title-link, ...) usually lead to the same
        // page template; clicking one of them is enough and saves the click budget.
        const structuralKey = element => {
          const identity = element.getAttribute("data-test") || element.getAttribute("data-testid") || element.id || "";
          return identity ? element.tagName + ":" + identity.replace(/\\d+/g, "#") : "";
        };
        const seenStructures = new Set();
        const navigationActions = Array.from(document.querySelectorAll('button,a,[role="tab"],[role="menuitem"],[role="link"]'))
          .map(element => ({ element, name: elementActionName(element) }))
          .filter(({ element }) => {
            const key = structuralKey(element);
            if (!key) return true;
            if (seenStructures.has(key)) return false;
            seenStructures.add(key);
            return true;
          })
          .filter(({ element, name }) => {
            const text = name.toLocaleLowerCase();
            const rect = element.getBoundingClientRect();
            const isNavigationControl = element.getAttribute("role") === "tab"
              || element.getAttribute("role") === "menuitem"
              || Boolean(element.closest('nav,[role="navigation"]'));
            const isCandidate = isScriptLink(element)
              || (element.tagName !== "A" && isNavigationControl && navigationTerms.some(term => text.includes(term)));
            return Boolean(name)
              && rect.width > 0
              && rect.height > 0
              && isCandidate
              && !isBlockedActionName(text);
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

/**
 * Many sites use one <title> for every page; append the URL path to repeated titles so
 * the end user can tell the pages apart when selecting them.
 */
export const disambiguatePageTitles = (pages: GenerationPage[]): GenerationPage[] => {
  const titleCounts = new Map<string, number>();
  for (const page of pages) titleCounts.set(page.title, (titleCounts.get(page.title) ?? 0) + 1);
  return pages.map((page) => {
    if ((titleCounts.get(page.title) ?? 0) < 2) return page;
    try {
      const url = new URL(page.urlPattern);
      return { ...page, title: `${page.title} (${url.pathname}${decodeURIComponent(url.search)})` };
    } catch {
      return page;
    }
  });
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
  loginCredentials?: LoginCredentials | null,
): Promise<PageDiscoveryResult> => {
  const credentials = resolveLoginCredentials(specification, loginCredentials);
  const { command, args } = resolvePlaywrightMcpLaunchConfig();
  const transport = new StdioClientTransport({ command, args });
  const client = new Client({ name: "autonomous-verification-backend", version: "1.0.0" });
  await client.connect(transport);

  try {
    const landingUrl = normalizePageUrl(url, url) ?? url;
    await client.callTool({ name: "browser_navigate", arguments: { url: landingUrl } });
    let authState: BrowserSessionState | null = null;
    let postLoginUrl: string | null = null;
    let loginIssue = "";
    if (credentials) {
      const landingSnapshot = await collectSnapshot(client, "Page discovery login");
      const loginStep = await attemptLogin(client, credentials, landingSnapshot.snapshot);
      if (!loginStep) {
        loginIssue = "Could not find a login form (username, password, and login button) on the target URL";
      } else {
        const afterLogin = await collectPageDiscoveryData(client, landingUrl);
        if (afterLogin.metadata.hasPasswordField) {
          loginIssue = "Login with the provided credentials did not succeed (the login form is still shown)";
        } else {
          authState = await captureBrowserSessionState(client);
          postLoginUrl = normalizePageUrl(afterLogin.metadata.url, landingUrl);
        }
      }
      if (loginIssue) console.warn(`discoverPages: ${loginIssue}`);
    }

    // Start from the page the site shows after login. Revisiting the landing URL usually
    // shows the login form again, which would end discovery at the login page.
    const queue: Array<{ url: string; depth: number }> = [];
    if (postLoginUrl && isSameOrigin(landingUrl, postLoginUrl)) queue.push({ url: postLoginUrl, depth: 0 });
    queue.push({ url: landingUrl, depth: 0 });
    const loginPagePattern = postLoginUrl ? pageUrlPattern(landingUrl) : null;
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
        // The page we logged in on is the public login page itself, not a page behind login.
        const isLoginPage = pattern === loginPagePattern && metadata.hasPasswordField;
        const loginRequired = !isLoginPage && (metadata.hasPasswordField
          || (pageUrlPattern(actualUrl) !== pattern && loginRelatedText(`${title} ${metadata.heading} ${actualUrl}`)));
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

        if (loginRequired || isLoginPage) continue;
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
                  const elementActionName = ${ELEMENT_ACTION_NAME_JS};
                  const target = Array.from(document.querySelectorAll('button,a,[role="tab"],[role="menuitem"],[role="link"]'))
                    .find(element => elementActionName(element).toLocaleLowerCase() === targetName);
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

    const pages = disambiguatePageTitles([...pagesByPattern.values()]);
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

    const complete = !incomplete && queue.length === 0 && !loginIssue;
    const stopReasons = [
      loginIssue,
      !incomplete && queue.length === 0 ? "" : "Page discovery reached its page limit or could not inspect one or more pages",
    ].filter(Boolean);
    return {
      pages,
      complete,
      ...(stopReasons.length > 0 ? { stopReason: stopReasons.join("; ") } : {}),
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
  loginCredentials?: LoginCredentials | null,
): Promise<AccessibilityDiscoveryResult> => {
  const credentials = resolveLoginCredentials(specification, loginCredentials);
  const { command, args } = resolvePlaywrightMcpLaunchConfig();
  const transport = new StdioClientTransport({ command, args });
  const client = new Client({ name: "autonomous-verification-backend", version: "1.0.0" });
  await client.connect(transport);

  try {
    const snapshots: SnapshotStep[] = [];
    let incomplete = false;
    let authState: BrowserSessionState | null = null;
    if (credentials) {
      await client.callTool({ name: "browser_navigate", arguments: { url } });
      const landingSnapshot = await collectSnapshot(client, "Selected-page login");
      const loginStep = await attemptLogin(client, credentials, landingSnapshot.snapshot);
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
  loginCredentials?: LoginCredentials | null,
): Promise<AccessibilityDiscoveryResult> => {
  const credentials = resolveLoginCredentials(specification, loginCredentials);
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

    const loginStep = await attemptLogin(client, credentials, landingStep.snapshot);
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
