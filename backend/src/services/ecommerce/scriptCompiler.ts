/**
 * Phase 6 — compiles structured steps + oracle into a Playwright `.spec.ts` deterministically.
 *
 * Rules that the legacy generator prompt asked the LLM to follow are enforced here instead:
 *  1. one import line and one test(...) per file;
 *  2. locators come from the snapshot: getByRole(role, { name, exact }) -> getByPlaceholder -> getByText;
 *  3. elements of repeated cards/rows are scoped by their container (`[data-test=..]`/article/li/tr)
 *     filtered by the card label; remaining duplicates get .nth(i) computed from the full snapshot;
 *  4. combobox options are chosen with selectOption({ label }), never by clicking an option;
 *  5. credentials come from process.env (`{{env.NAME}}` values), never literals;
 *  6. every string is emitted with JSON.stringify, so quotes in names cannot break the file;
 *  7. no waitForTimeout / $ / $$ / waitForSelector;
 *  8. precondition steps first, then the page's navigation path, then the case steps;
 *  9. assertions come from compileOracle.
 * Pure functions only.
 */
import { parsePlaywrightActions } from "../playwrightActionParser.js";
import { DYNAMIC_HEADER_TERMS, matchesAnyTerm } from "./keywords.js";
import { compileOracle, type CompiledOracle } from "./oracleCompiler.js";
import { parseSnapshot, type ParsedNode } from "./snapshotCompactor.js";
import type { ElementInventory, InventoryElement, InventoryGroup, Oracle, StructuredStep } from "./types.js";

export class LocatorResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocatorResolutionError";
  }
}

const quote = (value: string): string => JSON.stringify(value);

const ROLE_CONTAINER_SELECTORS: Record<string, string> = { article: "article", listitem: "li", row: "tr" };
const PLACEHOLDER_ROLES = new Set(["textbox", "searchbox", "spinbutton", "combobox"]);
const TEXT_ROLES = new Set(["text", "status", "alert"]);

/**
 * Header/nav names that change with use: counts ("Cart, 1 items" -> "Cart, 2 items") and cart/account
 * entries whose label changes with state ("Cart, empty" -> "Cart, 1 items"). They are matched by pattern.
 */
const isDynamicChromeName = (element: InventoryElement): boolean =>
  (element.region === "header" || element.region === "nav") && !element.groupId && Boolean(element.name)
  && (/\d/.test(element.name) || matchesAnyTerm(element.name, DYNAMIC_HEADER_TERMS));

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * Regex literal for a dynamic name: its stable leading words ("Cart" of "Cart, empty") when there are any,
 * otherwise the whole name with every number generalized.
 */
export const dynamicNameRegex = (name: string): string => {
  const stem = name.split(/[,(:\d]/)[0].trim();
  if (stem.length >= 2) return `/^${escapeRegex(stem)}/`;
  return `/^${escapeRegex(name).replace(/\d+/g, "\\d+")}$/`;
};

/** Text locator target for a text element: the label of a label/value pair, else its text without "…". */
const textTarget = (element: InventoryElement): { text: string; exact: boolean } => {
  if (element.name) return { text: element.name, exact: true };
  const text = element.text ?? "";
  return element.textTruncated ? { text: text.replace(/…$/, "").trim(), exact: false } : { text, exact: true };
};

type Matcher = (node: ParsedNode) => boolean;

/** What a locator matches, so duplicates can be counted the way Playwright would match them. */
const matcherFor = (element: InventoryElement): Matcher => {
  if (TEXT_ROLES.has(element.role)) {
    const { text, exact } = textTarget(element);
    return (node) => (node.text ?? "").trim() === text || (!exact && (node.text ?? "").startsWith(text));
  }
  if (!element.name && element.attrs?.placeholder && PLACEHOLDER_ROLES.has(element.role)) {
    return (node) => node.placeholder === element.attrs?.placeholder;
  }
  // getByRole(role) without a name matches every element of the role.
  if (!element.name) return (node) => node.role === element.role;
  if (isDynamicChromeName(element)) {
    const pattern = new RegExp(dynamicNameRegex(element.name).slice(1, -1));
    return (node) => node.role === element.role && pattern.test(node.name);
  }
  return (node) => node.role === element.role && node.name === element.name;
};

/** Locator call relative to a scope ("page" or a container locator). */
const locatorCall = (element: InventoryElement): string => {
  if (TEXT_ROLES.has(element.role)) {
    const { text, exact } = textTarget(element);
    return `getByText(${quote(text)}${exact ? ", { exact: true }" : ""})`;
  }
  if (!element.name && element.attrs?.placeholder && PLACEHOLDER_ROLES.has(element.role)) {
    return `getByPlaceholder(${quote(element.attrs.placeholder)}, { exact: true })`;
  }
  if (!element.name) return `getByRole(${quote(element.role)})`;
  if (isDynamicChromeName(element)) return `getByRole(${quote(element.role)}, { name: ${dynamicNameRegex(element.name)} })`;
  return `getByRole(${quote(element.role)}, { name: ${quote(element.name)}, exact: true })`;
};

const containerScope = (group: InventoryGroup): string | undefined => {
  const hint = group.containerHint;
  const selector = hint?.startsWith("[") ? hint : hint ? ROLE_CONTAINER_SELECTORS[hint] : undefined;
  if (!selector) return undefined;
  return `page.locator(${quote(selector)}).filter({ hasText: ${quote(group.label)} })`;
};

/** Index of the element's own node among nodes that match the same locator (document order). */
const duplicateIndex = (nodes: ParsedNode[], element: InventoryElement, matches: Matcher): { index: number; count: number } => {
  const candidates = nodes.filter(matches);
  const index = candidates.findIndex((node) => node.line === element.sourceLine);
  return { index: Math.max(0, index), count: candidates.length };
};

/** Nodes inside the container that holds the element (the container is the group's first-level ancestor). */
const nodesInSameContainer = (inventory: ElementInventory, element: InventoryElement, nodes: ParsedNode[]): ParsedNode[] => {
  const groupLines = new Set(inventory.elements.filter((other) => other.groupId === element.groupId).map((other) => other.sourceLine));
  const first = Math.min(...groupLines);
  const last = Math.max(...groupLines);
  return nodes.filter((node) => node.line >= first && node.line <= last);
};

/**
 * Playwright locator expression for an inventory element. `fullSnapshot` is the stored full snapshot the
 * inventory was built from; it is used to count elements the inventory left out (omitted cards, hidden nav).
 */
export const resolveLocator = (elementId: string, inventory: ElementInventory, fullSnapshot: string): string => {
  const element = inventory.elements.find((candidate) => candidate.id === elementId);
  if (!element) throw new LocatorResolutionError(`Element ${elementId} is not in the inventory of ${inventory.pageUrl}`);
  const nodes = parseSnapshot(fullSnapshot).nodes;
  const matches = matcherFor(element);
  const group = element.groupId ? inventory.groups.find((candidate) => candidate.id === element.groupId) : undefined;
  const scope = group ? containerScope(group) : undefined;

  const pool = scope ? nodesInSameContainer(inventory, element, nodes) : nodes;
  const { index, count } = duplicateIndex(pool, element, matches);
  const nth = count > 1 ? `.nth(${index})` : "";
  return `${scope ?? "page"}.${locatorCall(element)}${nth}`;
};

/** `{{env.NAME}}` -> process.env.NAME ?? '' ; anything else -> a string literal. */
export const valueExpression = (value: string): string => {
  const env = value.match(/^\{\{env\.([A-Za-z_][A-Za-z0-9_]*)\}\}$/);
  return env ? `process.env.${env[1]} ?? ''` : quote(value);
};

export interface CompiledSteps {
  lines: string[];
}

export interface CompileContext {
  inventory: ElementInventory;
  /** Full snapshot the inventory was built from. */
  fullSnapshot: string;
  /** Compiled steps of precondition recipes by ID (Phase 7), compiled against their own page. */
  preconditions?: Record<string, CompiledSteps>;
}

/** Steps -> code lines. Precondition steps expand to the recipe's compiled lines. */
export const compileSteps = (steps: readonly StructuredStep[], context: CompileContext): string[] => {
  const locate = (elementId: string) => resolveLocator(elementId, context.inventory, context.fullSnapshot);
  return steps.flatMap((step): string[] => {
    switch (step.kind) {
      case "goto":
        return [`await page.goto(${quote(step.url)});`];
      case "reload":
        return ["await page.reload();"];
      case "fill":
        return [`await ${locate(step.elementId)}.fill(${valueExpression(step.value)});`];
      case "click":
        return [`await ${locate(step.elementId)}.click();`];
      case "selectOption":
        return [`await ${locate(step.elementId)}.selectOption({ label: ${quote(step.optionLabel)} });`];
      case "check":
        return [`await ${locate(step.elementId)}.check();`];
      case "uncheck":
        return [`await ${locate(step.elementId)}.uncheck();`];
      case "press":
        return [`await ${locate(step.elementId)}.press(${quote(step.key)});`];
      case "precondition": {
        const recipe = context.preconditions?.[step.recipeId];
        if (!recipe) throw new LocatorResolutionError(`Precondition ${step.recipeId} has no compiled steps`);
        return recipe.lines;
      }
    }
  });
};

/** What both template candidates and exploratory cases provide. */
export interface CompilableCase {
  titleTh: string;
  steps: StructuredStep[];
  oracle: Oracle;
  preconditionId?: string;
}

export interface CompiledCase {
  title: string;
  script: string;
  /** The MCP engine cannot replay every line (scoped locators, toBeDisabled, ...): run with the playwright engine. */
  requiresPlaywrightEngine: boolean;
  /** Lines the MCP action parser could not translate. */
  mcpUnsupported: string[];
}

const INDENT = "  ";

/** Steps in order: precondition(s), then navigation to the page/state, then the case's own steps. */
const orderedSteps = (testCase: CompilableCase, inventory: ElementInventory): StructuredStep[] => {
  const preconditions = testCase.steps.filter((step) => step.kind === "precondition");
  if (testCase.preconditionId && !preconditions.some((step) => step.kind === "precondition" && step.recipeId === testCase.preconditionId)) {
    preconditions.unshift({ kind: "precondition", recipeId: testCase.preconditionId });
  }
  const ownSteps = testCase.steps.filter((step) => step.kind !== "precondition");
  const startsWithGoto = ownSteps[0]?.kind === "goto";
  return [...preconditions, ...(startsWithGoto ? [] : inventory.navigationPath), ...ownSteps];
};

export const compileCase = (testCase: CompilableCase, context: CompileContext): CompiledCase => {
  const title = testCase.titleTh.replace(/\s+/g, " ").trim();
  if (!title) throw new LocatorResolutionError("Case has no title");
  const locate = (elementId: string) => resolveLocator(elementId, context.inventory, context.fullSnapshot);
  const oracle: CompiledOracle = compileOracle(testCase.oracle, {
    locate,
    startUrl: context.inventory.pageUrl,
    renavigate: () => (context.inventory.urlIsStable ? [] : compileSteps(context.inventory.navigationPath, context)),
  });

  const steps = orderedSteps(testCase, context.inventory);
  const firstOwnStep = steps.findIndex((step) => step.kind !== "precondition" && step.kind !== "goto");
  const setupSteps = firstOwnStep < 0 ? steps : steps.slice(0, firstOwnStep);
  const actionSteps = firstOwnStep < 0 ? [] : steps.slice(firstOwnStep);
  const body = [
    ...compileSteps(setupSteps, context),
    ...oracle.before,
    ...compileSteps(actionSteps, context),
    ...oracle.after,
  ];

  const script = [
    "import { test, expect } from '@playwright/test';",
    "",
    `test(${quote(title)}, async ({ page }) => {`,
    ...body.map((line) => `${INDENT}${line}`),
    "});",
    "",
  ].join("\n");

  // Placeholder env values: the check is about syntax the parser understands, not about real credentials.
  const envNames = [...script.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]);
  const parserEnv = Object.fromEntries(envNames.map((name) => [name, "x"]));
  const mcpUnsupported = parsePlaywrightActions(script, parserEnv)
    .filter((action) => action.kind === "unsupported")
    .map((action) => (action.kind === "unsupported" ? action.detail : ""));
  return { title, script, requiresPlaywrightEngine: mcpUnsupported.length > 0, mcpUnsupported };
};
