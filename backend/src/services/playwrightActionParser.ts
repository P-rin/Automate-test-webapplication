/**
 * Line-based parser that translates a generated Playwright Test script into
 * simple actions the MCP execution engine can replay through browser_* tools.
 */

export type ParsedAction =
  | { kind: "goto"; url: string }
  | { kind: "fill"; label: string; labelIsRegex: boolean; role?: string; value: string }
  | { kind: "fillTestId"; testId: string; value: string }
  | { kind: "fillLocator"; selector: string; value: string }
  | { kind: "fillLocatorNth"; selector: string; index: number; value: string }
  | { kind: "clickRole"; role: string; name: string; nameIsRegex: boolean }
  | { kind: "clickText"; text: string; textIsRegex: boolean }
  | { kind: "clickTestId"; testId: string }
  | { kind: "clickLocator"; selector: string }
  | { kind: "clickLocatorNth"; selector: string; index: number }
  | { kind: "assertTitle"; expected: string; isRegex: boolean }
  | { kind: "assertUrl"; expected: string; isRegex: boolean }
  | { kind: "assertTextRole"; role: string; name: string; nameIsRegex: boolean; expected: string; isRegex: boolean }
  | { kind: "assertTextText"; text: string; textIsRegex: boolean; expected: string; isRegex: boolean }
  | { kind: "assertTextTestId"; testId: string; expected: string; isRegex: boolean }
  | { kind: "assertTextLocator"; selector: string; expected: string; isRegex: boolean }
  | { kind: "assertTextLocatorNth"; selector: string; index: number; expected: string; isRegex: boolean }
  | { kind: "assertVisibleRole"; role: string; name: string; nameIsRegex: boolean }
  | { kind: "assertVisibleText"; text: string; textIsRegex: boolean }
  | { kind: "assertVisibleTestId"; testId: string }
  | { kind: "assertVisibleLocator"; selector: string }
  | { kind: "unsupported"; detail: string };

type Env = Record<string, string | undefined>;

const STRING_LITERAL = String.raw`'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|` + "`(?:[^`\\\\]|\\\\.)*`";
const REGEX_LITERAL = String.raw`\/(?:[^/\\\n]|\\.)+\/[dgimsuy]*`;
const TEXT_ARG = `(?:${STRING_LITERAL}|${REGEX_LITERAL})`;

/** page.getByRole('<role>', { name: '<name>' | /<name>/i, ... }) — group 1: role, group 2: name (optional). */
const ROLE_LOCATOR = String.raw`page\.getByRole\(\s*(${STRING_LITERAL})\s*(?:,\s*\{(?:[^}]*?\bname\s*:\s*(${TEXT_ARG}))?[^}]*\}\s*)?\)`;

/** page.<method>('<text>' | /<text>/i, { ... }) — group 1: text. */
const textLocator = (method: string): string =>
  String.raw`page\.${method}\(\s*(${TEXT_ARG})\s*(?:,\s*\{[^}]*\}\s*)?\)`;

/** Captures the raw value expression of a trailing .fill(...) call. */
const FILL_VALUE = String.raw`\.fill\(\s*(.+?)\s*\)\s*;?\s*$`;

const TEXT_ASSERTION = String.raw`\.(?:toHaveText|toContainText)\((.+)\)\s*;?`;

const re = (source: string): RegExp => new RegExp(source, "i");

const FILL_ROLE = re(String.raw`await\s+${ROLE_LOCATOR}${FILL_VALUE}`);
const FILL_LABEL = re(String.raw`await\s+${textLocator("getBy(?:Label|Placeholder)")}${FILL_VALUE}`);
const FILL_TEST_ID = re(String.raw`await\s+page\.getByTestId\(\s*['"\`]([^'"\`]+)['"\`][^)]*\)${FILL_VALUE}`);
const FILL_LOCATOR = re(String.raw`await\s+page\.locator\(\s*['"\`]([^'"\`]+)['"\`][^)]*\)${FILL_VALUE}`);
const FILL_LOCATOR_NTH = re(String.raw`await\s+page\.locator\(\s*['"\`]([^'"\`]+)['"\`][^)]*\)\.nth\(\s*(\d+)\s*\)${FILL_VALUE}`);
const CLICK_ROLE = re(String.raw`await\s+${ROLE_LOCATOR}\.click\(`);
const CLICK_TEXT = re(String.raw`await\s+${textLocator("getByText")}\.click\(`);
const ASSERT_VISIBLE_ROLE = re(String.raw`await\s+expect\(\s*${ROLE_LOCATOR}\s*\)\.toBeVisible\(\)\s*;?`);
const ASSERT_VISIBLE_TEXT = re(String.raw`await\s+expect\(\s*${textLocator("getByText")}\s*\)\.toBeVisible\(\)\s*;?`);
const ASSERT_TEXT_ROLE = re(String.raw`await\s+expect\(\s*${ROLE_LOCATOR}\s*\)${TEXT_ASSERTION}`);
const ASSERT_TEXT_TEXT = re(String.raw`await\s+expect\(\s*${textLocator("getByText")}\s*\)${TEXT_ASSERTION}`);

const unescapeQuoted = (body: string): string => body.replace(/\\(.)/g, "$1");

/** Parses a JS string or regex literal. Returns null for template literals with interpolation or other expressions. */
export const parseTextArgument = (raw: string): { text: string; isRegex: boolean } | null => {
  const trimmed = raw.trim();
  const regexMatch = trimmed.match(/^\/((?:[^/\\\n]|\\.)+)\/[dgimsuy]*$/);
  if (regexMatch?.[1] !== undefined) return { text: regexMatch[1], isRegex: true };

  const quote = trimmed[0];
  if ((quote === "'" || quote === "\"" || quote === "`") && trimmed.endsWith(quote) && trimmed.length >= 2) {
    const body = trimmed.slice(1, -1);
    if (quote === "`" && body.includes("${")) return null;
    return { text: unescapeQuoted(body), isRegex: false };
  }
  return null;
};

export const parseExpectedTextOrRegex = (rawValue: string): { expected: string; isRegex: boolean } | null => {
  const parsed = parseTextArgument(rawValue);
  if (!parsed) return null;
  if (!parsed.isRegex && !parsed.text) return null;
  return { expected: parsed.text, isRegex: parsed.isRegex };
};

const ENV_VALUE = new RegExp(
  String.raw`^process\.env\.([A-Za-z_][A-Za-z0-9_]*)\s*!?(?:\s+as\s+string)?\s*(?:(?:\?\?|\|\|)\s*(${STRING_LITERAL}))?$`,
);

/**
 * Resolves the argument of .fill(...): a string literal, or process.env.NAME with an
 * optional `?? 'fallback'` / `|| 'fallback'`, optionally wrapped in String(...).
 */
export const resolveFillValue = (
  raw: string,
  env: Env = process.env,
): { ok: true; value: string } | { ok: false; detail: string } => {
  let expression = raw.trim();
  const stringWrapper = expression.match(/^String\(\s*(.+)\s*\)$/);
  if (stringWrapper?.[1]) expression = stringWrapper[1].trim();

  const literal = parseTextArgument(expression);
  if (literal && !literal.isRegex) return { ok: true, value: literal.text };

  const envMatch = expression.match(ENV_VALUE);
  if (envMatch?.[1]) {
    const name = envMatch[1];
    const envValue = env[name];
    if (envValue !== undefined && (envValue !== "" || !envMatch[2])) return { ok: true, value: envValue };
    if (envMatch[2]) {
      const fallback = parseTextArgument(envMatch[2]);
      if (fallback && !fallback.isRegex) return { ok: true, value: fallback.text };
    }
    return { ok: false, detail: `Environment variable ${name} is not set` };
  }

  return { ok: false, detail: `Unsupported fill value expression: ${raw.trim()}` };
};

/** Case-insensitive substring match, or a case-insensitive regex test when isRegex is true. */
export const matchesName = (candidate: string, query: string, isRegex = false): boolean => {
  if (isRegex) {
    try {
      return new RegExp(query, "i").test(candidate);
    } catch {
      return false;
    }
  }
  return candidate.trim().toLowerCase().includes(query.trim().toLowerCase());
};

const pushFill = (
  actions: ParsedAction[],
  rawValue: string,
  build: (value: string) => ParsedAction,
  line: string,
  env: Env,
): void => {
  const resolved = resolveFillValue(rawValue, env);
  actions.push(resolved.ok ? build(resolved.value) : { kind: "unsupported", detail: `${resolved.detail} (${line})` });
};

const pushTextAssertion = (
  actions: ParsedAction[],
  rawExpected: string,
  build: (expected: { expected: string; isRegex: boolean }) => ParsedAction,
): void => {
  const parsed = parseExpectedTextOrRegex(rawExpected);
  actions.push(parsed ? build(parsed) : { kind: "unsupported", detail: `Unsupported toHaveText expression: ${rawExpected.trim()}` });
};

/** Parses an optional role-locator name group; a missing name matches any element of the role. */
const parseRoleName = (raw: string | undefined): { name: string; nameIsRegex: boolean } | null => {
  if (raw === undefined) return { name: "", nameIsRegex: false };
  const parsed = parseTextArgument(raw);
  return parsed ? { name: parsed.text, nameIsRegex: parsed.isRegex } : null;
};

const parseRole = (raw: string): string | null => parseTextArgument(raw)?.text.trim().toLowerCase() || null;

export const parsePlaywrightActions = (script: string, env: Env = process.env): ParsedAction[] => {
  const actions: ParsedAction[] = [];
  const lines = script.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  for (const line of lines) {
    const gotoMatch = line.match(/await\s+page\.goto\(\s*['"`]([^'"`]+)['"`]/i);
    if (gotoMatch?.[1]) {
      actions.push({ kind: "goto", url: gotoMatch[1].trim() });
      continue;
    }

    const fillRoleMatch = line.match(FILL_ROLE);
    if (fillRoleMatch?.[1] && fillRoleMatch[3] !== undefined) {
      const role = parseRole(fillRoleMatch[1]);
      const name = parseRoleName(fillRoleMatch[2]);
      if (role && name) {
        pushFill(actions, fillRoleMatch[3], (value) => ({
          kind: "fill", label: name.name, labelIsRegex: name.nameIsRegex, role, value,
        }), line, env);
        continue;
      }
    }

    const fillLabelMatch = line.match(FILL_LABEL);
    if (fillLabelMatch?.[1] && fillLabelMatch[2] !== undefined) {
      const label = parseTextArgument(fillLabelMatch[1]);
      if (label) {
        pushFill(actions, fillLabelMatch[2], (value) => ({
          kind: "fill", label: label.text.trim(), labelIsRegex: label.isRegex, value,
        }), line, env);
        continue;
      }
    }

    const fillTestIdMatch = line.match(FILL_TEST_ID);
    if (fillTestIdMatch?.[1] && fillTestIdMatch[2] !== undefined) {
      const testId = fillTestIdMatch[1].trim();
      pushFill(actions, fillTestIdMatch[2], (value) => ({ kind: "fillTestId", testId, value }), line, env);
      continue;
    }

    const fillLocatorMatch = line.match(FILL_LOCATOR);
    if (fillLocatorMatch?.[1] && fillLocatorMatch[2] !== undefined) {
      const selector = fillLocatorMatch[1].trim();
      pushFill(actions, fillLocatorMatch[2], (value) => ({ kind: "fillLocator", selector, value }), line, env);
      continue;
    }

    const fillLocatorNthMatch = line.match(FILL_LOCATOR_NTH);
    if (fillLocatorNthMatch?.[1] && fillLocatorNthMatch[2] && fillLocatorNthMatch[3] !== undefined) {
      const selector = fillLocatorNthMatch[1].trim();
      const index = Number(fillLocatorNthMatch[2]);
      pushFill(actions, fillLocatorNthMatch[3], (value) => ({ kind: "fillLocatorNth", selector, index, value }), line, env);
      continue;
    }

    const clickRoleMatch = line.match(CLICK_ROLE);
    if (clickRoleMatch?.[1]) {
      const role = parseRole(clickRoleMatch[1]);
      const name = parseRoleName(clickRoleMatch[2]);
      if (role && name) {
        actions.push({ kind: "clickRole", role, ...name });
        continue;
      }
    }

    const clickTextMatch = line.match(CLICK_TEXT);
    if (clickTextMatch?.[1]) {
      const text = parseTextArgument(clickTextMatch[1]);
      if (text) {
        actions.push({ kind: "clickText", text: text.text.trim(), textIsRegex: text.isRegex });
        continue;
      }
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

    const assertVisibleRoleMatch = line.match(ASSERT_VISIBLE_ROLE);
    if (assertVisibleRoleMatch?.[1]) {
      const role = parseRole(assertVisibleRoleMatch[1]);
      const name = parseRoleName(assertVisibleRoleMatch[2]);
      if (role && name) {
        actions.push({ kind: "assertVisibleRole", role, ...name });
        continue;
      }
    }

    const assertVisibleTextMatch = line.match(ASSERT_VISIBLE_TEXT);
    if (assertVisibleTextMatch?.[1]) {
      const text = parseTextArgument(assertVisibleTextMatch[1]);
      if (text) {
        actions.push({ kind: "assertVisibleText", text: text.text.trim(), textIsRegex: text.isRegex });
        continue;
      }
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

    const assertTextRoleMatch = line.match(ASSERT_TEXT_ROLE);
    if (assertTextRoleMatch?.[1] && assertTextRoleMatch[3]) {
      const role = parseRole(assertTextRoleMatch[1]);
      const name = parseRoleName(assertTextRoleMatch[2]);
      if (role && name) {
        pushTextAssertion(actions, assertTextRoleMatch[3], (parsed) => ({ kind: "assertTextRole", role, ...name, ...parsed }));
        continue;
      }
    }

    const assertTextTextMatch = line.match(ASSERT_TEXT_TEXT);
    if (assertTextTextMatch?.[1] && assertTextTextMatch[2]) {
      const text = parseTextArgument(assertTextTextMatch[1]);
      if (text) {
        pushTextAssertion(actions, assertTextTextMatch[2], (parsed) => ({
          kind: "assertTextText", text: text.text.trim(), textIsRegex: text.isRegex, ...parsed,
        }));
        continue;
      }
    }

    const assertTextTestIdMatch = line.match(/await\s+expect\(page\.getByTestId\(\s*['"`]([^'"`]+)['"`][^)]*\)\)\.(?:toHaveText|toContainText)\((.+)\)\s*;?/i);
    if (assertTextTestIdMatch?.[1] && assertTextTestIdMatch?.[2]) {
      const testId = assertTextTestIdMatch[1].trim();
      pushTextAssertion(actions, assertTextTestIdMatch[2], (parsed) => ({ kind: "assertTextTestId", testId, ...parsed }));
      continue;
    }

    const assertTextLocatorNthMatch = line.match(/await\s+expect\(page\.locator\(\s*['"`]([^'"`]+)['"`][^)]*\)\.nth\(\s*(\d+)\s*\)\)\.(?:toHaveText|toContainText)\((.+)\)\s*;?/i);
    if (assertTextLocatorNthMatch?.[1] && assertTextLocatorNthMatch?.[2] && assertTextLocatorNthMatch?.[3]) {
      const selector = assertTextLocatorNthMatch[1].trim();
      const index = Number(assertTextLocatorNthMatch[2]);
      pushTextAssertion(actions, assertTextLocatorNthMatch[3], (parsed) => ({ kind: "assertTextLocatorNth", selector, index, ...parsed }));
      continue;
    }

    const assertTextLocatorMatch = line.match(/await\s+expect\(page\.locator\(\s*['"`]([^'"`]+)['"`][^)]*\)\)\.(?:toHaveText|toContainText)\((.+)\)\s*;?/i);
    if (assertTextLocatorMatch?.[1] && assertTextLocatorMatch?.[2]) {
      const selector = assertTextLocatorMatch[1].trim();
      pushTextAssertion(actions, assertTextLocatorMatch[2], (parsed) => ({ kind: "assertTextLocator", selector, ...parsed }));
      continue;
    }

    if (/await\s+page\./i.test(line) || /await\s+expect\(/i.test(line)) {
      actions.push({ kind: "unsupported", detail: `Unsupported action: ${line}` });
    }
  }

  return actions;
};
