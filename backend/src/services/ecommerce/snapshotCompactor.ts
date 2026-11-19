/**
 * Phase 1 — turns a Playwright MCP snapshot into an ElementInventory (E1, E2, ...) and a compact prompt text.
 *
 * Compacting only changes what the LLM sees: the full snapshot stays stored, and every element keeps
 * `sourceLine` so an answer such as "E5" maps back to the full snapshot for locators.
 * Pure functions only (no browser, Firestore or Ollama).
 */
import { DYNAMIC_HEADER_TERMS, IMPORTANT_TEXT_TERMS, MONEY_PATTERN, matchesAnyTerm } from "./keywords.js";
import type { ElementAttributeEntry } from "../snapshotService.js";
import type { ElementInventory, InventoryElement, InventoryGroup, PageType, Region, StructuredStep } from "./types.js";

export interface ParsedNode {
  index: number;
  /** 1-based line in the full snapshot text. */
  line: number;
  depth: number;
  role: string;
  name: string;
  attrs: Record<string, string | true>;
  ref?: string;
  /** Inline text after the colon (`- generic [ref=e1]: "1"`). */
  text?: string;
  url?: string;
  placeholder?: string;
  parent?: number;
  children: number[];
}

export interface TestIdEntryLine {
  attr: string;
  value: string;
  tag: string;
  count: number;
  text: string;
}

export interface ParsedSnapshot {
  pageUrl: string;
  pageTitle: string;
  nodes: ParsedNode[];
  testIds: TestIdEntryLine[];
  /** "### Element Attributes" (Phase 3a, ecommerce mode only), in DOM order. */
  elementAttributes: ElementAttributeEntry[];
}

/** Reads the JSON block after "### Element Attributes"; malformed or missing sections give []. */
export const parseElementAttributes = (snapshot: string): ElementAttributeEntry[] => {
  const match = snapshot.match(/### Element Attributes\s*```json\s*([\s\S]*?)```/);
  if (!match) return [];
  try {
    const value = JSON.parse(match[1]) as unknown;
    return Array.isArray(value)
      ? value.filter((entry): entry is ElementAttributeEntry =>
        typeof entry === "object" && entry !== null && typeof (entry as ElementAttributeEntry).role === "string"
        && typeof (entry as ElementAttributeEntry).name === "string")
      : [];
  } catch {
    return [];
  }
};

const attributeKey = (role: string, name: string): string =>
  `${role}|${name.replace(/\s+/g, " ").trim().toLocaleLowerCase()}`;

/**
 * Pairs snapshot nodes with DOM attribute entries: the k-th node with a given role + name is the k-th entry
 * with that role + name (both lists are in document order). Nodes whose name the DOM-side approximation does
 * not reproduce stay unmatched rather than being paired with the wrong element.
 */
export const matchElementAttributes = (nodes: ParsedNode[], entries: ElementAttributeEntry[]): Map<number, ElementAttributeEntry> => {
  const result = new Map<number, ElementAttributeEntry>();
  const usedEntries = new Set<ElementAttributeEntry>();
  const interactive = nodes.filter((node) => INTERACTIVE_ROLES.has(node.role));

  /** One pass: k-th unmatched node with a key <-> k-th unused entry with the same key. */
  const pass = (keyOf: (role: string, name: string) => string) => {
    const entriesByKey = new Map<string, ElementAttributeEntry[]>();
    for (const entry of entries) {
      if (usedEntries.has(entry)) continue;
      const key = keyOf(entry.role, entry.name);
      entriesByKey.set(key, [...(entriesByKey.get(key) ?? []), entry]);
    }
    const seen = new Map<string, number>();
    for (const node of interactive) {
      if (result.has(node.index)) continue;
      const key = keyOf(node.role, node.name || node.placeholder || "");
      const occurrence = seen.get(key) ?? 0;
      seen.set(key, occurrence + 1);
      const entry = entriesByKey.get(key)?.[occurrence];
      if (entry) {
        result.set(node.index, entry);
        usedEntries.add(entry);
      }
    }
  };
  pass(attributeKey);
  // Same name up to whitespace ("USB-C -11%" vs "USB-C-11%" from the DOM text approximation).
  pass((role, name) => `${role}|${name.replace(/\s+/g, "").toLocaleLowerCase()}`);

  // Last resort per role: when exactly as many nodes as entries are left (e.g. image buttons the snapshot
  // shows without a name), pair them in document order.
  const roles = new Set(interactive.filter((node) => !result.has(node.index)).map((node) => node.role));
  for (const role of roles) {
    const leftNodes = interactive.filter((node) => node.role === role && !result.has(node.index));
    const leftEntries = entries.filter((entry) => entry.role === role && !usedEntries.has(entry));
    if (leftNodes.length === leftEntries.length) {
      leftNodes.forEach((node, position) => {
        result.set(node.index, leftEntries[position]);
        usedEntries.add(leftEntries[position]);
      });
    }
  }
  return result;
};

const attrsFromEntry = (entry: ElementAttributeEntry): NonNullable<InventoryElement["attrs"]> => ({
  tag: entry.tag,
  ...(entry.type ? { type: entry.type } : {}),
  ...(entry.placeholder ? { placeholder: entry.placeholder } : {}),
  ...(entry.required ? { required: true } : {}),
  ...(entry.min !== undefined ? { min: entry.min } : {}),
  ...(entry.max !== undefined ? { max: entry.max } : {}),
  ...(entry.maxLength !== undefined ? { maxLength: entry.maxLength } : {}),
  ...(entry.pattern ? { pattern: entry.pattern } : {}),
  ...(entry.disabled ? { disabled: true } : {}),
  ...(entry.testId ? { testId: entry.testId } : {}),
  ...(entry.formRole ? { formRole: entry.formRole } : {}),
  ...(entry.htmlName ? { htmlName: entry.htmlName } : {}),
  ...(entry.autocomplete ? { autocomplete: entry.autocomplete } : {}),
  ...(entry.inputMode ? { inputMode: entry.inputMode } : {}),
  ...(entry.formButtons?.length ? { formButtons: entry.formButtons } : {}),
});

export const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "spinbutton", "combobox", "listbox", "checkbox", "radio",
  "switch", "slider", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "treeitem",
]);

const LANDMARK_REGIONS: Record<string, Region> = {
  banner: "header",
  navigation: "nav",
  main: "main",
  contentinfo: "footer",
  dialog: "dialog",
  alertdialog: "dialog",
};

/** Roles whose own text is page content; normalized to role "text" in the inventory (status/alert keep their role). */
const TEXT_ROLES = new Set([
  "text", "paragraph", "generic", "strong", "emphasis", "cell", "gridcell", "rowheader", "columnheader",
  "listitem", "term", "definition", "caption", "blockquote", "code", "time", "mark", "status", "alert", "note",
]);

/** Descendants that describe a container's structure, used to detect repeated cards/rows. */
const SHAPE_ROLES = new Set([...INTERACTIVE_ROLES, "img", "heading"]);
const SINGLE_GROUP_ROLES = new Set(["article", "listitem", "row"]);

export const MAX_TEXT_CHARS = 60;
export const DEFAULT_MAX_GROUP_ITEMS = 3;

const NODE_PATTERN = /^([a-z][\w-]*)(?:\s+"((?:[^"\\]|\\.)*)")?((?:\s+\[[^\]]*\])*)(?::\s*(.*))?$/;

const unquote = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
};

const unescapeName = (value: string): string => value.replace(/\\(["\\])/g, "$1");

const parseTestIdLines = (lines: string[]): TestIdEntryLine[] => {
  const start = lines.findIndex((line) => line.trim() === "### Test IDs");
  if (start < 0) return [];
  const entries: TestIdEntryLine[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("### ")) break;
    const match = line.match(/^- \[([\w-]+)="([^"]*)"\] <(\w+)>(?: x(\d+))?(?: "(.*)")?$/);
    if (match) {
      entries.push({ attr: match[1], value: match[2], tag: match[3], count: Number(match[4] ?? 1), text: match[5] ?? "" });
    }
  }
  return entries;
};

/** Parses the YAML-like tree of a Playwright MCP snapshot; non-tree sections are read for URL, title and Test IDs. */
export const parseSnapshot = (snapshot: string): ParsedSnapshot => {
  const lines = snapshot.split(/\r?\n/);
  const pageUrl = snapshot.match(/Page URL:\s*(\S+)/i)?.[1] ?? "";
  const pageTitle = snapshot.match(/Page Title:\s*(.+)/i)?.[1]?.trim() ?? "";
  const nodes: ParsedNode[] = [];
  const stack: number[] = [];

  let inTree = false;
  lines.forEach((raw, lineIndex) => {
    if (/^```yaml\s*$/.test(raw.trim())) {
      inTree = true;
      return;
    }
    if (inTree && raw.trim().startsWith("```")) {
      inTree = false;
      return;
    }
    if (!inTree) return;

    const match = raw.match(/^(\s*)- (.*)$/);
    if (!match) return;
    const depth = Math.floor(match[1].length / 2);
    const content = match[2];
    while (stack.length > 0 && nodes[stack[stack.length - 1]].depth >= depth) stack.pop();
    const parentIndex = stack[stack.length - 1];

    if (content.startsWith("/")) {
      // Property line of the parent: "/url: /cart", "/placeholder: Search".
      const prop = content.match(/^\/([\w-]+):\s*(.*)$/);
      if (prop && parentIndex !== undefined) {
        const value = unquote(prop[2]);
        if (prop[1] === "url") nodes[parentIndex].url = value;
        if (prop[1] === "placeholder") nodes[parentIndex].placeholder = value;
      }
      return;
    }

    const nodeMatch = content.match(NODE_PATTERN);
    if (!nodeMatch) return;
    const attrs: Record<string, string | true> = {};
    let ref: string | undefined;
    for (const attr of nodeMatch[3].matchAll(/\[([^\]=]+)(?:=([^\]]*))?\]/g)) {
      if (attr[1] === "ref") ref = attr[2];
      else attrs[attr[1]] = attr[2] ?? true;
    }
    const inline = nodeMatch[4]?.trim();
    const node: ParsedNode = {
      index: nodes.length,
      line: lineIndex + 1,
      depth,
      role: nodeMatch[1],
      name: nodeMatch[2] !== undefined ? unescapeName(nodeMatch[2]) : "",
      attrs,
      ...(ref ? { ref } : {}),
      ...(inline ? { text: unquote(inline) } : {}),
      ...(parentIndex !== undefined ? { parent: parentIndex } : {}),
      children: [],
    };
    nodes.push(node);
    if (parentIndex !== undefined) nodes[parentIndex].children.push(node.index);
    stack.push(node.index);
  });

  return { pageUrl, pageTitle, nodes, testIds: parseTestIdLines(lines), elementAttributes: parseElementAttributes(snapshot) };
};

// ---------------------------------------------------------------------------------------------
// Helpers over the parsed tree

const descendants = (nodes: ParsedNode[], index: number): ParsedNode[] => {
  const result: ParsedNode[] = [];
  const visit = (current: number) => {
    for (const child of nodes[current].children) {
      result.push(nodes[child]);
      visit(child);
    }
  };
  visit(index);
  return result;
};

const shapeOf = (nodes: ParsedNode[], index: number): string[] =>
  descendants(nodes, index).filter((node) => SHAPE_ROLES.has(node.role)).map((node) => node.role);

const regionOf = (nodes: ParsedNode[], index: number): Region => {
  let current: number | undefined = index;
  while (current !== undefined) {
    const region = LANDMARK_REGIONS[nodes[current].role];
    if (region) return region;
    current = nodes[current].parent;
  }
  return "unknown";
};

const hasLetterOrDigit = (value: string): boolean => /[\p{L}\p{N}]/u.test(value);
const isNumericOnly = (value: string): boolean => /^[\s\d.,()+-]+$/.test(value) && /\d/.test(value);

/** Text an oracle is likely to check: money, bare numbers (badges/quantities), totals, stock, errors. */
export const isImportantText = (value: string): boolean =>
  MONEY_PATTERN.test(value) || isNumericOnly(value) || matchesAnyTerm(value, IMPORTANT_TEXT_TERMS);

const shorten = (value: string): { text: string; truncated: boolean } => {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > MAX_TEXT_CHARS
    ? { text: `${normalized.slice(0, MAX_TEXT_CHARS - 1).trimEnd()}…`, truncated: true }
    : { text: normalized, truncated: false };
};

/** All visible text inside a node: own inline text and text of non-interactive descendants. */
const textInside = (nodes: ParsedNode[], index: number): string[] => {
  const result: string[] = [];
  const visit = (current: number) => {
    for (const child of nodes[current].children) {
      const node = nodes[child];
      if (INTERACTIVE_ROLES.has(node.role)) continue;
      if (node.text && hasLetterOrDigit(node.text)) result.push(node.text);
      visit(child);
    }
  };
  visit(index);
  return result;
};

/** First text in a container that names it (product name): headings, image alt text, then plain text; never button/link names. */
const labelOfContainer = (nodes: ParsedNode[], index: number): string => {
  for (const node of descendants(nodes, index)) {
    if ((node.role === "heading" || node.role === "img") && node.name && hasLetterOrDigit(node.name)) return node.name;
    if (TEXT_ROLES.has(node.role) && node.text && hasLetterOrDigit(node.text)
      && !isNumericOnly(node.text) && !MONEY_PATTERN.test(node.text) && node.text.trim().length >= 3) {
      return node.text;
    }
  }
  return "";
};

/** Header/nav items that change with use (cart count, signed-in user, search box); footers never count. */
const isDynamicHeaderItem = (element: Pick<InventoryElement, "role" | "name" | "text" | "region">): boolean => {
  if (element.region === "footer") return false;
  if (["textbox", "searchbox", "combobox", "spinbutton"].includes(element.role)) return true;
  const content = `${element.name} ${element.text ?? ""}`;
  return /\d/.test(content) || matchesAnyTerm(content, DYNAMIC_HEADER_TERMS);
};

/** Key used to recognize the same nav/footer element on later pages. */
export const navigationKey = (element: Pick<InventoryElement, "role" | "name" | "text">): string =>
  `${element.role}|${element.name || element.text || ""}`;

const isChromeRegion = (region: Region): boolean => region === "nav" || region === "footer" || region === "header";

// ---------------------------------------------------------------------------------------------
// Repeated groups

/** Minimum structural similarity of containers in one repeated set (cards may differ by e.g. an old price). */
export const GROUP_STRUCTURE_SIMILARITY = 0.8;

/** 2·LCS / (|a| + |b|) over role sequences. */
export const sequenceSimilarity = (left: readonly string[], right: readonly string[]): number => {
  if (left.length === 0 && right.length === 0) return 1;
  const previous = new Array<number>(right.length + 1).fill(0);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= right.length; j += 1) {
      const above = previous[j];
      previous[j] = left[i - 1] === right[j - 1] ? diagonal + 1 : Math.max(previous[j], previous[j - 1]);
      diagonal = above;
    }
  }
  return (2 * previous[right.length]) / (left.length + right.length);
};

const CONTAINER_TAGS = new Set(["div", "li", "article", "tr", "section"]);

/** Approximates element.innerText from the snapshot: inline text of all descendants in order. */
const innerTextOf = (nodes: ParsedNode[], index: number): string =>
  descendants(nodes, index).map((node) => node.text ?? "").join("");

const compactText = (value: string): string => value.replace(/\s+/g, "").toLocaleLowerCase();

interface RepeatedSet {
  setId: string;
  members: number[];
  containerHint?: string;
}

const findRepeatedSets = (parsed: ParsedSnapshot): RepeatedSet[] => {
  const { nodes, testIds } = parsed;
  const sets: RepeatedSet[] = [];
  const insideSet = new Set<number>();

  /**
   * A "### Test IDs" container entry is evidence for a repeated set when it occurs as many times as the
   * members and its (30-char) innerText starts like the first member's text.
   */
  const matchingTestId = (members: number[]): TestIdEntryLine | undefined => {
    const memberText = compactText(innerTextOf(nodes, members[0]));
    return testIds.find((entry) => {
      const entryText = compactText(entry.text);
      // count >= 2: a single tagged element is as likely a page wrapper (root, cart-contents) as one row.
      return entry.count === members.length
        && entry.count >= 2
        && CONTAINER_TAGS.has(entry.tag)
        && entryText.length >= 5
        && memberText.startsWith(entryText.slice(0, 15));
    });
  };

  const containerHintFor = (members: number[], testId: TestIdEntryLine | undefined): string | undefined => {
    if (testId) return `[${testId.attr}="${testId.value}"]`;
    const role = nodes[members[0]].role;
    return SINGLE_GROUP_ROLES.has(role) ? role : undefined;
  };

  const visit = (index: number) => {
    const node = nodes[index];
    const buckets = new Map<string, number[]>();
    for (const child of node.children) {
      const shape = shapeOf(nodes, child);
      if (shape.length < 1) continue;
      const key = `${nodes[child].role}:${shape.join(",")}`;
      buckets.set(key, [...(buckets.get(key) ?? []), child]);
    }
    // Same controls are not enough (an item list and a totals box can both hold two buttons):
    // members must also share most of their full structure.
    const clusters: number[][] = [];
    for (const bucket of buckets.values()) {
      const pending = [...bucket];
      while (pending.length > 0) {
        const seed = pending.shift()!;
        const seedRoles = descendants(nodes, seed).map((descendant) => descendant.role);
        const cluster = [seed];
        for (let position = pending.length - 1; position >= 0; position -= 1) {
          const roles = descendants(nodes, pending[position]).map((descendant) => descendant.role);
          if (sequenceSimilarity(seedRoles, roles) >= GROUP_STRUCTURE_SIMILARITY) cluster.push(...pending.splice(position, 1));
        }
        clusters.push(cluster.sort((a, b) => a - b));
      }
    }
    for (const members of clusters) {
      const shapeLength = shapeOf(nodes, members[0]).length;
      const testId = matchingTestId(members);
      // Structural evidence needs at least two controls per container; a lone article/listitem/row still is
      // a card/row (a cart with one item); a repeated Test ID container also counts with a single control each.
      const structural = shapeLength >= 2 && (members.length >= 2 || SINGLE_GROUP_ROLES.has(nodes[members[0]].role));
      if (structural || testId) {
        sets.push({ setId: `S${sets.length + 1}`, members, containerHint: containerHintFor(members, testId) });
        for (const member of members) insideSet.add(member);
      }
    }
    for (const child of node.children) {
      if (!insideSet.has(child)) visit(child);
    }
  };
  nodes.filter((node) => node.parent === undefined).forEach((root) => visit(root.index));
  return sets.sort((a, b) => a.members[0] - b.members[0]).map((set, position) => ({ ...set, setId: `S${position + 1}` }));
};

// ---------------------------------------------------------------------------------------------
// Inventory

export interface BuildInventoryOptions {
  /** navigationKey()s of nav/footer/header elements already sent on earlier pages of the job. */
  previouslySentNavigation?: ReadonlySet<string>;
  /** Containers per repeated set turned into elements (default 3). */
  maxGroupItems?: number;
  pageType?: PageType;
  stateLabel?: string;
  navigationPath?: StructuredStep[];
  urlIsStable?: boolean;
}

export const buildInventory = (snapshot: string, options: BuildInventoryOptions = {}): ElementInventory => {
  const parsed = parseSnapshot(snapshot);
  const { nodes } = parsed;
  const maxGroupItems = Math.max(1, options.maxGroupItems ?? DEFAULT_MAX_GROUP_ITEMS);
  const previouslySent = options.previouslySentNavigation ?? new Set<string>();
  const attributeMatches = matchElementAttributes(nodes, parsed.elementAttributes);

  const sets = findRepeatedSets(parsed);
  const groups: InventoryGroup[] = [];
  const omittedRepeatedGroups: ElementInventory["omittedRepeatedGroups"] = [];
  const groupOfNode = new Map<number, InventoryGroup>();
  const skippedContainers = new Set<number>();
  for (const set of sets) {
    set.members.forEach((member, position) => {
      if (position >= maxGroupItems) {
        skippedContainers.add(member);
        return;
      }
      const group: InventoryGroup = {
        id: `G${groups.length + 1}`,
        label: labelOfContainer(nodes, member),
        count: set.members.length,
        ...(set.containerHint ? { containerHint: set.containerHint } : {}),
        setId: set.setId,
        index: position + 1,
      };
      groups.push(group);
      groupOfNode.set(member, group);
    });
    if (set.members.length > maxGroupItems) {
      omittedRepeatedGroups.push({
        label: set.containerHint ?? nodes[set.members[0]].role,
        omittedCount: set.members.length - maxGroupItems,
        setId: set.setId,
      });
    }
  }

  const elements: InventoryElement[] = [];
  let sectionHeading: string | undefined;

  const push = (node: ParsedNode, element: Omit<InventoryElement, "id" | "region" | "sourceLine">, group?: InventoryGroup) => {
    const region = regionOf(nodes, node.index);
    const full: InventoryElement = {
      id: `E${elements.length + 1}`,
      ...element,
      region,
      ...(group ? { groupId: group.id, groupLabel: group.label } : {}),
      ...(sectionHeading && element.role !== "heading" ? { sectionHeading } : {}),
      sourceLine: node.line,
    };
    if (isChromeRegion(region) && !isDynamicHeaderItem(full) && previouslySent.has(navigationKey(full))) {
      full.hiddenFromPrompt = "seen_on_previous_page";
    }
    elements.push(full);
  };

  const siblingControlNames = (node: ParsedNode): Set<string> => {
    const parent = node.parent === undefined ? undefined : nodes[node.parent];
    return new Set((parent?.children ?? [])
      .map((child) => nodes[child])
      .filter((sibling) => INTERACTIVE_ROLES.has(sibling.role))
      .map((sibling) => sibling.name.trim()));
  };

  const visit = (index: number, group: InventoryGroup | undefined) => {
    if (skippedContainers.has(index)) return;
    const node = nodes[index];
    const currentGroup = groupOfNode.get(index) ?? group;

    if (node.role === "heading") {
      sectionHeading = node.name || node.text || sectionHeading;
      push(node, {
        role: "heading",
        name: node.name || node.text || "",
        interactive: false,
        ...(node.attrs.level ? { attrs: { level: Number(node.attrs.level) } } : {}),
      }, currentGroup);
      return;
    }

    if (INTERACTIVE_ROLES.has(node.role)) {
      const childText = textInside(nodes, index).filter((text) => text.trim() !== node.name.trim());
      const options = node.children.map((child) => nodes[child]).filter((child) => child.role === "option");
      const selected = options.find((option) => option.attrs.selected)?.name;
      const ownValue = ["textbox", "searchbox", "spinbutton", "slider"].includes(node.role) ? node.text : undefined;
      const shortened = childText.length > 0 && !ownValue ? shorten(childText.join(" ")) : undefined;
      const domEntry = attributeMatches.get(index);
      const attrs: InventoryElement["attrs"] = {
        ...(domEntry ? attrsFromEntry(domEntry) : {}),
        ...(node.placeholder ? { placeholder: node.placeholder } : {}),
        ...(node.attrs.disabled ? { disabled: true } : {}),
        ...(node.attrs.checked ? { checked: true } : {}),
        ...(node.attrs.selected ? { selected: true } : {}),
      };
      push(node, {
        role: node.role,
        name: node.name,
        interactive: true,
        ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
        ...(options.length > 0 ? { options: options.map((option) => option.name) } : {}),
        ...(ownValue !== undefined ? { value: ownValue } : selected !== undefined ? { value: selected } : {}),
        ...(shortened ? { text: shortened.text, ...(shortened.truncated ? { textTruncated: true } : {}) } : {}),
        ...(node.url ? { href: node.url } : {}),
      }, currentGroup);
      // Child text is merged into the control; nested controls (rare) are still listed.
      for (const descendant of descendants(nodes, index)) {
        if (INTERACTIVE_ROLES.has(descendant.role) && descendant.parent === index) visit(descendant.index, currentGroup);
      }
      return;
    }

    if (TEXT_ROLES.has(node.role)) {
      const childNodes = node.children.map((child) => nodes[child]);
      const hasControls = descendants(nodes, index).some((descendant) => INTERACTIVE_ROLES.has(descendant.role) || descendant.role === "heading");
      const role = node.role === "status" || node.role === "alert" ? node.role : "text";

      // Label/value pair: <p><span>ยอดรวม</span><span>฿7,990</span></p> -> one element. Separate paragraphs
      // (name / unit price / stock in a cart row) stay separate so each can be an oracle target.
      const pairLabel = childNodes[0]?.text ?? "";
      const pairValue = childNodes[1]?.text ?? "";
      if (!hasControls && !node.text && childNodes.length === 2
        && childNodes.every((child) => TEXT_ROLES.has(child.role) && child.role !== "paragraph" && child.children.length === 0 && child.text)
        && !isNumericOnly(pairLabel) && !MONEY_PATTERN.test(pairLabel)
        && (isImportantText(pairValue) || pairLabel.trim().endsWith(":"))) {
        const label = pairLabel.trim().replace(/:$/, "");
        const value = shorten(pairValue);
        push(node, {
          role,
          name: shorten(label).text,
          interactive: false,
          text: value.text,
          ...(value.truncated ? { textTruncated: true } : {}),
        }, currentGroup);
        return;
      }

      if (node.text && hasLetterOrDigit(node.text) && !siblingControlNames(node).has(node.text.trim())) {
        const value = shorten(node.text);
        push(node, {
          role,
          name: "",
          interactive: false,
          text: value.text,
          ...(value.truncated ? { textTruncated: true } : {}),
        }, currentGroup);
      }
    }

    for (const child of node.children) visit(child, currentGroup);
  };

  nodes.filter((node) => node.parent === undefined).forEach((root) => visit(root.index, undefined));

  return {
    pageUrl: parsed.pageUrl,
    pageTitle: parsed.pageTitle,
    ...(options.pageType ? { pageType: options.pageType } : {}),
    ...(options.stateLabel ? { stateLabel: options.stateLabel } : {}),
    navigationPath: options.navigationPath ?? (parsed.pageUrl ? [{ kind: "goto", url: parsed.pageUrl }] : []),
    urlIsStable: options.urlIsStable ?? true,
    elements,
    groups,
    omittedRepeatedGroups,
  };
};

/** navigationKey()s of this page's nav/footer/header elements, to pass as previouslySentNavigation for later pages. */
export const navigationKeysOf = (inventory: ElementInventory): string[] =>
  inventory.elements
    .filter((element) => isChromeRegion(element.region) && !isDynamicHeaderItem(element))
    .map(navigationKey);

export const findElement = (inventory: ElementInventory, id: string): InventoryElement | undefined =>
  inventory.elements.find((element) => element.id === id);

// ---------------------------------------------------------------------------------------------
// Prompt rendering

const quote = (value: string): string => JSON.stringify(value);

const pathOf = (url: string): string => {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
};

export const renderElement = (element: InventoryElement): string => {
  const parts = [element.id, element.role];
  // Generic purposes say nothing the role does not already say; they would only cost prompt space.
  if (element.purpose && !element.purpose.startsWith("generic_") && element.purpose !== "unknown") parts.push(element.purpose);
  if (element.role === "text" || element.role === "status" || element.role === "alert") {
    parts.push(quote(element.name ? `${element.name}: ${element.text ?? ""}` : element.text ?? ""));
  } else {
    parts.push(quote(element.name));
  }
  if (element.attrs?.level) parts.push(`level=${element.attrs.level}`);
  if (element.attrs?.disabled) parts.push("[disabled]");
  if (element.attrs?.checked) parts.push("[checked]");
  if (element.value !== undefined) parts.push(`value=${quote(element.value)}`);
  if (element.attrs?.placeholder && element.attrs.placeholder !== element.name) parts.push(`placeholder=${quote(element.attrs.placeholder)}`);
  if (element.attrs?.type && !["text", "button", "submit"].includes(element.attrs.type)) parts.push(`type=${element.attrs.type}`);
  if (element.attrs?.tag === "textarea") parts.push("multiline");
  if (element.attrs?.min !== undefined) parts.push(`min=${element.attrs.min}`);
  if (element.attrs?.max !== undefined) parts.push(`max=${element.attrs.max}`);
  if (element.attrs?.maxLength !== undefined) parts.push(`maxLength=${element.attrs.maxLength}`);
  if (element.attrs?.required) parts.push("[required]");
  if (element.options) parts.push(`options=[${element.options.join(" | ")}]`);
  if (element.interactive && element.text) parts.push(`text=${quote(element.text)}`);
  if (element.href && !/^https?:/i.test(element.href)) parts.push(`-> ${element.href}`);
  return parts.join(" ");
};

/** Budget levels, applied in order until the text fits: least useful content goes first. */
interface RenderLevel {
  dropFooter: boolean;
  dropNavigation: boolean;
  dropLongText: boolean;
  groupsPerSet: number;
  dropPlainText: boolean;
  dropPlainTextInGroups: boolean;
}

const RENDER_LEVELS: RenderLevel[] = [
  { dropFooter: false, dropNavigation: false, dropLongText: false, groupsPerSet: Infinity, dropPlainText: false, dropPlainTextInGroups: false },
  { dropFooter: true, dropNavigation: false, dropLongText: false, groupsPerSet: Infinity, dropPlainText: false, dropPlainTextInGroups: false },
  { dropFooter: true, dropNavigation: true, dropLongText: false, groupsPerSet: Infinity, dropPlainText: false, dropPlainTextInGroups: false },
  { dropFooter: true, dropNavigation: true, dropLongText: true, groupsPerSet: Infinity, dropPlainText: false, dropPlainTextInGroups: false },
  { dropFooter: true, dropNavigation: true, dropLongText: true, groupsPerSet: 1, dropPlainText: false, dropPlainTextInGroups: false },
  { dropFooter: true, dropNavigation: true, dropLongText: true, groupsPerSet: 1, dropPlainText: true, dropPlainTextInGroups: false },
  { dropFooter: true, dropNavigation: true, dropLongText: true, groupsPerSet: 1, dropPlainText: true, dropPlainTextInGroups: true },
];

const isPlainText = (element: InventoryElement): boolean =>
  element.role === "text" && !isImportantText(`${element.name} ${element.text ?? ""}`);

const renderAtLevel = (inventory: ElementInventory, level: RenderLevel): string[] => {
  const header = [
    `PAGE ${inventory.pageUrl ? pathOf(inventory.pageUrl) : "(unknown URL)"}`,
    inventory.pageTitle ? `title: ${quote(inventory.pageTitle)}` : "",
    inventory.pageType ? `type: ${inventory.pageType}` : "",
    inventory.stateLabel ? `state: ${inventory.stateLabel}` : "",
  ].filter(Boolean).join(" | ");
  const lines = [header];
  const groupsById = new Map(inventory.groups.map((group) => [group.id, group]));
  let hiddenChrome = 0;
  let currentRegion: Region | undefined;
  let currentGroupId: string | undefined;

  const omittedAfter = new Map<string, number>();
  for (const omitted of inventory.omittedRepeatedGroups) omittedAfter.set(omitted.setId, omitted.omittedCount);
  const groupsInSet = (setId: string) => inventory.groups.filter((candidate) => candidate.setId === setId);

  /** After the last group of a set shown at this level: "(อีก N ชิ้น...)" for omitted + level-hidden containers. */
  const flushSetSummary = (group: InventoryGroup | undefined) => {
    if (!group) return;
    const members = groupsInSet(group.setId);
    const lastVisibleIndex = Math.min(level.groupsPerSet, members.length);
    if (group.index !== lastVisibleIndex) return;
    const more = (omittedAfter.get(group.setId) ?? 0) + (members.length - lastVisibleIndex);
    if (more > 0) lines.push(`(อีก ${more} ชิ้นรูปแบบเดียวกับ ${members[0].id})`);
  };

  for (const element of inventory.elements) {
    if (element.hiddenFromPrompt) {
      hiddenChrome += 1;
      continue;
    }
    const dynamic = isDynamicHeaderItem(element);
    if (level.dropFooter && element.region === "footer" && !dynamic) continue;
    if (level.dropNavigation && (element.region === "nav" || element.region === "header") && !dynamic) continue;

    const group = element.groupId ? groupsById.get(element.groupId) : undefined;
    if (group && group.index > level.groupsPerSet) continue;
    if (element.textTruncated && level.dropLongText && !element.interactive && isPlainText(element)) continue;
    if (isPlainText(element) && (group ? level.dropPlainTextInGroups : level.dropPlainText)) continue;

    if (currentGroupId && currentGroupId !== element.groupId) {
      flushSetSummary(groupsById.get(currentGroupId));
      currentGroupId = undefined;
    }
    if (element.region !== currentRegion) {
      lines.push(`[${element.region}]`);
      currentRegion = element.region;
    }
    if (group && currentGroupId !== group.id) {
      lines.push(`${group.id} item ${quote(group.label)} (${group.index}/${group.count}):`);
      currentGroupId = group.id;
    }
    lines.push(`${group ? "  " : ""}${renderElement(element)}`);
  }
  if (currentGroupId) flushSetSummary(groupsById.get(currentGroupId));
  // Repeated sets whose shown groups were all filtered out still report their size.
  for (const omitted of inventory.omittedRepeatedGroups) {
    const anyShown = inventory.groups.some((group) => group.setId === omitted.setId && lines.some((line) => line.startsWith(`${group.id} item `)));
    if (!anyShown) lines.push(`(อีก ${omitted.omittedCount} ชิ้นรูปแบบเดียวกัน)`);
  }
  if (hiddenChrome > 0) lines.push(`(ซ่อนเมนู/ส่วนท้ายที่ส่งไปแล้วในหน้าก่อน ${hiddenChrome} รายการ)`);
  return lines;
};

/**
 * Snapshot share of the legacy planner prompt: generateNextTestPlan gives the snapshot ~45% of what is left
 * after its instructions (~2.0–2.7k chars). Rendering within this keeps truncateText from cutting the tail.
 */
export const compactSnapshotBudget = (maxPromptChars: number): number =>
  Math.max(1000, Math.floor((maxPromptChars - 3000) * 0.45));

export interface PromptReferenceMiss {
  text: string;
  /** true: the compactor removed something the model needed; false: the model invented it. */
  inFullSnapshot: boolean;
}

/** UI labels a plan quotes ('Add to cart', "Checkout", “ตะกร้า”) plus its targetElement. */
export const referencedLabels = (plan: { targetElement?: string; testSteps?: string[]; expectedResult?: string }): string[] => {
  const labels = new Set<string>();
  if (plan.targetElement?.trim()) labels.add(plan.targetElement.trim());
  for (const text of [...(plan.testSteps ?? []), plan.expectedResult ?? ""]) {
    for (const match of text.matchAll(/'([^']{2,80})'|"([^"]{2,80})"|“([^”]{2,80})”/g)) {
      labels.add((match[1] ?? match[2] ?? match[3]).trim());
    }
  }
  return [...labels].filter(Boolean);
};

const normalizeForSearch = (value: string): string => value.replace(/\s+/g, " ").trim().toLocaleLowerCase();

/** Labels the model used that are not in the text it was shown (ECOMMERCE_TESTGEN_CONTEXT.md Phase 1 measurement). */
export const findPromptReferenceMisses = (labels: string[], promptText: string, fullSnapshot: string): PromptReferenceMiss[] => {
  const prompt = normalizeForSearch(promptText);
  const full = normalizeForSearch(fullSnapshot);
  return labels
    .filter((label) => !prompt.includes(normalizeForSearch(label)))
    .map((label) => ({ text: label, inFullSnapshot: full.includes(normalizeForSearch(label)) }));
};

/**
 * Renders the inventory for a prompt within `maxChars`. Content is removed by importance
 * (footer -> nav -> long text -> extra repeated groups -> plain text), never by cutting the tail first.
 */
export const renderInventoryForPrompt = (inventory: ElementInventory, maxChars: number): string => {
  let lines: string[] = [];
  for (const level of RENDER_LEVELS) {
    lines = renderAtLevel(inventory, level);
    const text = lines.join("\n");
    if (text.length <= maxChars) return text;
  }
  // Last resort: whole lines from the end, with a marker, still within maxChars.
  const marker = (count: number) => `(ตัดอีก ${count} บรรทัดเพราะเกินงบ)`;
  const kept: string[] = [];
  let length = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const remaining = lines.length - index - 1;
    const reserve = remaining > 0 ? marker(remaining).length + 1 : 0;
    const nextLength = length + (kept.length > 0 ? 1 : 0) + lines[index].length;
    if (nextLength + reserve > maxChars) {
      const omitted = lines.length - index;
      const tail = marker(omitted);
      const result = [...kept, tail].join("\n");
      return result.length <= maxChars ? result : result.slice(0, Math.max(0, maxChars));
    }
    kept.push(lines[index]);
    length = nextLength;
  }
  return kept.join("\n");
};
