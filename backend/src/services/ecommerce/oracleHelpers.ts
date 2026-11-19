/**
 * Phase 5 — helper functions that computed oracles call. Specs must be self-contained, so the helpers a
 * case uses are emitted into its own file (top level, after the import line).
 *
 * The sources are plain JavaScript (also valid TypeScript, no type annotations) so unit tests can run them
 * with `new Function`. They avoid template literals so they can live in String.raw blocks here.
 */

export type HelperName =
  | "amountTokens" | "toAmount" | "parseAmount" | "lastAmount" | "decimalsIn" | "compareAmount"
  | "checkTotal" | "checkPercentage" | "checkLineTotal" | "checkSubtotal" | "checkSorted" | "checkAllContain"
  | "readCount" | "readPairValue" | "countMatchingTexts" | "hasValidationError";

interface HelperDefinition {
  deps: HelperName[];
  source: string;
}

export const HELPERS: Record<HelperName, HelperDefinition> = {
  amountTokens: {
    deps: [],
    source: String.raw`/** Amount tokens in a text: numbers next to a currency sign/word, else any plain numbers. */
function amountTokens(text) {
  const value = String(text ?? '').replace(/ /g, ' ');
  const pattern = /(-?)(?:[฿$€£¥]|THB|USD|EUR)\s?(-?\d[\d,]*(?:\.\d+)?)|(-?\d[\d,]*(?:\.\d+)?)\s?(?:บาท|THB|USD|EUR)/gi;
  const tokens = Array.from(value.matchAll(pattern), (match) => match[2] !== undefined ? match[1] + match[2] : match[3]);
  return tokens.length > 0 ? tokens : (value.match(/-?\d[\d,]*(?:\.\d+)?/g) ?? []);
}`,
  },
  toAmount: {
    deps: [],
    source: String.raw`function toAmount(token) {
  return token === undefined ? NaN : Number(String(token).replace(/,/g, '').replace(/^-+/, '-'));
}`,
  },
  parseAmount: {
    deps: ["amountTokens", "toAmount"],
    source: String.raw`/** First amount in a text ("฿1,290.50" -> 1290.5, "Total: $43.18" -> 43.18); NaN when there is none. */
function parseAmount(text) {
  return toAmount(amountTokens(text)[0]);
}`,
  },
  lastAmount: {
    deps: ["amountTokens", "toAmount"],
    source: String.raw`/** Last amount in a text (the line total at the end of a cart row). */
function lastAmount(text) {
  const tokens = amountTokens(text);
  return toAmount(tokens[tokens.length - 1]);
}`,
  },
  decimalsIn: {
    deps: ["amountTokens"],
    source: String.raw`function decimalsIn(text) {
  const match = String(amountTokens(text)[0] ?? '').match(/\.(\d+)$/);
  return match ? match[1].length : 0;
}`,
  },
  compareAmount: {
    deps: ["parseAmount", "decimalsIn"],
    source: String.raw`/** '' when the shown amount equals the expected one at the precision it is shown with, else why not. */
function compareAmount(what, shownText, expected) {
  const shown = parseAmount(shownText);
  if (Number.isNaN(shown)) return what + ': no amount in ' + JSON.stringify(shownText);
  if (Number.isNaN(expected)) return what + ': could not compute the expected amount';
  const tolerance = 0.5 * Math.pow(10, -decimalsIn(shownText)) + 1e-9;
  return Math.abs(shown - expected) <= tolerance ? '' : what + ': shown ' + shown + ', expected ' + Math.round(expected * 100) / 100;
}`,
  },
  checkTotal: {
    deps: ["compareAmount", "parseAmount"],
    source: String.raw`/** Total = sum of added amounts - sum of discounts (a discount may be shown with or without a minus). */
function checkTotal(totalText, addTexts, subtractTexts) {
  const added = addTexts.reduce((sum, text) => sum + parseAmount(text), 0);
  const subtracted = subtractTexts.reduce((sum, text) => sum + Math.abs(parseAmount(text)), 0);
  return compareAmount('total', totalText, added - subtracted);
}`,
  },
  checkPercentage: {
    deps: ["compareAmount", "parseAmount"],
    source: String.raw`function checkPercentage(valueText, baseText, percent) {
  return compareAmount(percent + '% of ' + parseAmount(baseText), valueText, parseAmount(baseText) * percent / 100);
}`,
  },
  checkLineTotal: {
    deps: ["compareAmount", "parseAmount"],
    source: String.raw`function checkLineTotal(lineTotalText, priceText, quantityText) {
  return compareAmount('line total (' + parseAmount(priceText) + ' x ' + parseAmount(quantityText) + ')', lineTotalText, parseAmount(priceText) * parseAmount(quantityText));
}`,
  },
  checkSubtotal: {
    deps: ["compareAmount", "lastAmount"],
    source: String.raw`/** Subtotal = sum of the rows' line totals (the last amount shown in each row). */
function checkSubtotal(subtotalText, rowTexts) {
  if (rowTexts.length === 0) return 'no rows found';
  return compareAmount('subtotal of ' + rowTexts.length + ' rows', subtotalText, rowTexts.reduce((sum, text) => sum + lastAmount(text), 0));
}`,
  },
  checkSorted: {
    deps: [],
    source: String.raw`/** '' when values are in order; numbers compare numerically, text case-insensitively. */
function checkSorted(values, direction) {
  if (values.length < 2) return 'need at least 2 items to check the order, found ' + values.length;
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (typeof previous === 'number' && (Number.isNaN(previous) || Number.isNaN(current))) return 'could not read the value of item ' + (Number.isNaN(previous) ? index : index + 1);
    const order = typeof previous === 'number' ? previous - current : String(previous).localeCompare(String(current), undefined, { sensitivity: 'base', numeric: true });
    if (direction === 'asc' ? order > 0 : order < 0) return 'items ' + index + ' and ' + (index + 1) + ' are not in ' + direction + ' order: ' + JSON.stringify(previous) + ' then ' + JSON.stringify(current);
  }
  return '';
}`,
  },
  checkAllContain: {
    deps: [],
    source: String.raw`function checkAllContain(itemTexts, expected) {
  if (itemTexts.length === 0) return 'no items shown';
  const missing = itemTexts.findIndex((text) => !text.toLowerCase().includes(expected.toLowerCase()));
  return missing < 0 ? '' : 'item ' + (missing + 1) + ' does not contain ' + JSON.stringify(expected) + ': ' + JSON.stringify(itemTexts[missing].slice(0, 80));
}`,
  },
  readCount: {
    deps: [],
    source: String.raw`/** Number shown by a counter (badge text or accessible label); a missing or hidden counter is 0. */
async function readCount(locator) {
  if ((await locator.count()) === 0 || !(await locator.first().isVisible())) return 0;
  const first = locator.first();
  const text = ((await first.textContent()) ?? '') + ' ' + ((await first.getAttribute('aria-label')) ?? '');
  const match = text.match(/\d+/);
  return match ? Number(match[0]) : 0;
}`,
  },
  readPairValue: {
    deps: [],
    source: String.raw`/** Value shown next to a label ("Subtotal" -> "฿1,290"): the text that follows the label in its container. */
async function readPairValue(label) {
  return label.evaluate((element) => {
    const own = (element.textContent ?? '').trim();
    let node = element;
    while (node.parentElement) {
      node = node.parentElement;
      const text = (node.innerText ?? node.textContent ?? '').trim();
      const at = text.indexOf(own);
      const rest = at < 0 ? '' : text.slice(at + own.length).trim();
      if (rest) return rest.split('\n')[0].trim();
    }
    return '';
  });
}`,
  },
  countMatchingTexts: {
    deps: [],
    source: String.raw`async function countMatchingTexts(page, pattern) {
  return page.getByText(pattern).filter({ visible: true }).count();
}`,
  },
  hasValidationError: {
    deps: ["countMatchingTexts"],
    source: String.raw`/** The field fails native/ARIA validation, or a new error message appeared on the page. */
async function hasValidationError(field, page, errorsBefore, pattern) {
  if ((await field.count()) > 0) {
    const invalid = await field.first().evaluate((element) =>
      (element.validity ? !element.validity.valid : false) || element.getAttribute('aria-invalid') === 'true').catch(() => false);
    if (invalid) return true;
  }
  return (await countMatchingTexts(page, pattern)) > errorsBefore;
}`,
  },
};

/** Helper sources for the given names plus their dependencies, in a stable order (dependencies first). */
export const helperSources = (names: Iterable<HelperName>): string[] => {
  const needed = new Set<HelperName>();
  const visit = (name: HelperName) => {
    if (needed.has(name)) return;
    for (const dependency of HELPERS[name].deps) visit(dependency);
    needed.add(name);
  };
  for (const name of names) visit(name);
  return [...needed].map((name) => HELPERS[name].source);
};
