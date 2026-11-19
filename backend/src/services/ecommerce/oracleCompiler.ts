/**
 * Oracle -> Playwright assertion code (Phase 6 basic oracles, Phase 5 computed oracles).
 *
 * Computed oracles never contain numbers the model wrote: they read the shown values at run time and
 * compare them with code (helpers in oracleHelpers.ts are inlined into the spec). Values that change
 * asynchronously are checked with expect.poll, whose failure message says what was wrong.
 * An oracle that cannot be compiled faithfully throws UnsupportedOracleError instead of becoming a weaker
 * assertion.
 */
import { termsRegexLiteral, VALIDATION_ERROR_TERMS } from "./keywords.js";
import type { HelperName } from "./oracleHelpers.js";
import { EMPTY_STATE_TERMS } from "./templates/helpers.js";
import type { ElementInventory, InventoryElement, InventoryGroup, Oracle } from "./types.js";

export class UnsupportedOracleError extends Error {
  constructor(readonly oracleKind: Oracle["kind"], reason?: string) {
    super(`Oracle ${oracleKind} cannot be compiled${reason ? `: ${reason}` : ""}`);
    this.name = "UnsupportedOracleError";
  }
}

export interface OracleCompileContext {
  /** Locator expression for an inventory element ID (throws for unknown IDs). */
  locate: (elementId: string) => string;
  /** URL the test started from, for urlUnchanged. */
  startUrl: string;
  /** Lines that bring the page back to the tested state after a reload (SPA states need more than reload). */
  renavigate: () => string[];
  /** Inventory of the page, for computed oracles over groups and label/value pairs. */
  inventory?: ElementInventory;
}

export interface CompiledOracle {
  /** Lines that must run before the case steps (e.g. reading a value to compare against later). */
  before: string[];
  /** Assertion lines that run after the steps. */
  after: string[];
  /** Helper functions the lines call (emitted at the top of the spec). */
  helpers: HelperName[];
}

const quote = (value: string): string => JSON.stringify(value);

/** A JS regex literal matching `value` literally (for toHaveURL). */
export const literalRegex = (value: string, flags = ""): string =>
  `/${value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}/${flags}`;

const ROLE_CONTAINER_SELECTORS: Record<string, string> = { article: "article", listitem: "li", row: "tr" };
const INPUT_ROLES = new Set(["textbox", "spinbutton", "searchbox", "combobox"]);
const ROLE_LOCATABLE = new Set(["button", "link", "heading", "cell", "gridcell", "listitem"]);

const simple = (after: string[]): CompiledOracle => ({ before: [], after, helpers: [] });

/** Expression that reads the shown text/value of an element as a string. */
const readValueExpression = (element: InventoryElement | undefined, locator: string): { expression: string; helpers: HelperName[] } => {
  if (element && INPUT_ROLES.has(element.role)) return { expression: `await ${locator}.inputValue()`, helpers: [] };
  // A label/value pair is located by its label; the value is the text next to it.
  if (element && element.role === "text" && element.name && element.text) return { expression: `await readPairValue(${locator})`, helpers: ["readPairValue"] };
  return { expression: `await ${locator}.innerText()`, helpers: [] };
};

export const compileOracle = (oracle: Oracle, context: OracleCompileContext): CompiledOracle => {
  const elementOf = (id: string): InventoryElement | undefined => context.inventory?.elements.find((element) => element.id === id);
  const groupOf = (id: string): InventoryGroup => {
    const group = context.inventory?.groups.find((candidate) => candidate.id === id);
    if (!group) throw new UnsupportedOracleError(oracle.kind, `group ${id} is not in the inventory`);
    return group;
  };
  /** Every container of the group's repeated set (all cards/rows, not just the shown ones). */
  const itemsOf = (groupId: string): string => {
    const hint = groupOf(groupId).containerHint;
    const selector = hint?.startsWith("[") ? hint : hint ? ROLE_CONTAINER_SELECTORS[hint] : undefined;
    if (!selector) throw new UnsupportedOracleError(oracle.kind, `group ${groupId} has no container selector`);
    return `page.locator(${quote(selector)})`;
  };
  const read = (id: string) => readValueExpression(elementOf(id), context.locate(id));

  switch (oracle.kind) {
    case "textVisible":
      // .first(): the same text often appears more than once (a line total equal to the cart total).
      return simple([`await expect(page.getByText(${quote(oracle.text)}).first()).toBeVisible();`]);
    case "elementVisible":
      return simple([`await expect(${context.locate(oracle.elementId)}).toBeVisible();`]);
    case "elementHidden":
      return simple([`await expect(${context.locate(oracle.elementId)}).toBeHidden();`]);
    case "elementDisabled":
      return simple([`await expect(${context.locate(oracle.elementId)}).toBeDisabled();`]);
    case "elementEnabled":
      return simple([`await expect(${context.locate(oracle.elementId)}).toBeEnabled();`]);
    case "inputValueEquals":
      return simple([`await expect(${context.locate(oracle.elementId)}).toHaveValue(${quote(oracle.expected)});`]);
    case "urlContains":
      return simple([`await expect(page).toHaveURL(${literalRegex(oracle.fragment)});`]);
    case "urlUnchanged":
      return simple([`await expect(page).toHaveURL(${quote(context.startUrl)});`]);
    case "selectedOptionIs":
      return simple([`await expect(${context.locate(oracle.elementId)}.locator("option:checked")).toHaveText(${quote(oracle.label)});`]);
    case "countEquals":
      return simple([`await expect(${itemsOf(oracle.groupId)}).toHaveCount(${oracle.expected});`]);
    case "emptyStateShown":
      return simple([`await expect(page.getByText(${termsRegexLiteral(EMPTY_STATE_TERMS)}).filter({ visible: true }).first()).toBeVisible();`]);

    case "countChangedBy": {
      const locator = context.locate(oracle.elementId);
      return {
        before: [`const countBefore = await readCount(${locator});`],
        after: [`await expect.poll(() => readCount(${locator}), { message: ${quote(`count should change by ${oracle.delta}`)} }).toBe(countBefore + ${oracle.delta});`],
        helpers: ["readCount"],
      };
    }

    case "textUnchanged": {
      const value = read(oracle.elementId);
      return {
        before: [`const shownBefore = ${value.expression};`],
        after: [
          "await page.waitForLoadState(\"networkidle\").catch(() => undefined);",
          `await expect.poll(async () => ${value.expression}, { message: "value should not change" }).toBe(shownBefore);`,
        ],
        helpers: value.helpers,
      };
    }

    case "validationMessageShown": {
      const field = context.locate(oracle.elementId);
      const pattern = termsRegexLiteral(VALIDATION_ERROR_TERMS);
      return {
        before: [`const errorsBefore = await countMatchingTexts(page, ${pattern});`],
        after: [`await expect.poll(() => hasValidationError(${field}, page, errorsBefore, ${pattern}), { message: "the field should fail validation or an error message should appear" }).toBe(true);`],
        helpers: ["countMatchingTexts", "hasValidationError"],
      };
    }

    case "totalEqualsSum": {
      const total = read(oracle.totalElementId);
      const added = oracle.addElementIds.map(read);
      const subtracted = oracle.subtractElementIds.map(read);
      const all = [total, ...added, ...subtracted];
      return {
        before: [],
        after: [`await expect.poll(async () => checkTotal(${total.expression}, [${added.map((value) => value.expression).join(", ")}], [${subtracted.map((value) => value.expression).join(", ")}])).toBe("");`],
        helpers: ["checkTotal", ...all.flatMap((value) => value.helpers)],
      };
    }

    case "percentageOf": {
      const value = read(oracle.elementId);
      const base = read(oracle.baseElementId);
      return {
        before: [],
        after: [`await expect.poll(async () => checkPercentage(${value.expression}, ${base.expression}, ${oracle.percent})).toBe("");`],
        helpers: ["checkPercentage", ...value.helpers, ...base.helpers],
      };
    }

    case "lineTotalEquals": {
      const line = read(oracle.lineTotalElementId);
      const price = read(oracle.priceElementId);
      const quantity = read(oracle.qtyElementId);
      return {
        before: [],
        after: [`await expect.poll(async () => checkLineTotal(${line.expression}, ${price.expression}, ${quantity.expression})).toBe("");`],
        helpers: ["checkLineTotal", ...line.helpers, ...price.helpers, ...quantity.helpers],
      };
    }

    case "subtotalEqualsSumOfLines": {
      const subtotal = read(oracle.subtotalElementId);
      return {
        before: [],
        after: [`await expect.poll(async () => checkSubtotal(${subtotal.expression}, await ${itemsOf(oracle.groupId)}.allInnerTexts())).toBe("");`],
        helpers: ["checkSubtotal", ...subtotal.helpers],
      };
    }

    case "allItemsContain":
      return {
        before: [],
        after: [`await expect.poll(async () => checkAllContain(await ${itemsOf(oracle.groupId)}.allInnerTexts(), ${quote(oracle.text)})).toBe("");`],
        helpers: ["checkAllContain"],
      };

    case "sortedBy": {
      const items = itemsOf(oracle.groupId);
      if (oracle.field === "price") {
        return {
          before: [],
          after: [`await expect.poll(async () => checkSorted((await ${items}.allInnerTexts()).map(parseAmount), ${quote(oracle.direction)})).toBe("");`],
          helpers: ["checkSorted", "parseAmount"],
        };
      }
      return {
        before: [],
        after: [
          "await expect.poll(async () => {",
          "  const names = [];",
          `  for (const item of await ${items}.all()) names.push((await item.${nameLocatorInItem(oracle.groupId, context.inventory, oracle.kind)}.innerText()).trim());`,
          `  return checkSorted(names, ${quote(oracle.direction)});`,
          "}).toBe(\"\");",
        ],
        helpers: ["checkSorted"],
      };
    }

    case "persistsAfterReload": {
      const inner = compileOracle(oracle.inner, context);
      return {
        before: inner.before,
        after: [...inner.after, "await page.reload();", ...context.renavigate(), ...inner.after],
        helpers: inner.helpers,
      };
    }
  }
};

/**
 * Locator (relative to one container) of the product name in every card: the element showing the card's
 * label, found by its role and position among same-role elements of the card, or by a test ID shared by
 * all cards.
 */
const nameLocatorInItem = (groupId: string, inventory: ElementInventory | undefined, kind: Oracle["kind"]): string => {
  const group = inventory?.groups.find((candidate) => candidate.id === groupId);
  const members = inventory?.elements.filter((element) => element.groupId === groupId) ?? [];
  const label = group?.label ?? "";
  const shows = (element: InventoryElement) => (element.text ?? element.name).trim() === label;
  const nameElement = members.find((element) => shows(element) && ROLE_LOCATABLE.has(element.role))
    ?? members.find((element) => element.purpose === "product_name")
    ?? members.find(shows);
  if (!nameElement) throw new UnsupportedOracleError(kind, `no product name element in group ${groupId}`);

  const testId = nameElement.attrs?.testId;
  const sharedTestId = testId && inventory?.elements.some((other) => other.groupId && other.groupId !== groupId && other.attrs?.testId === testId);
  if (sharedTestId) {
    // The attribute name is not recorded; the collector reads these test ID attributes.
    const selector = ["data-test", "data-testid", "data-test-id", "data-qa", "data-cy"].map((attr) => `[${attr}=${quote(testId)}]`).join(", ");
    return `locator(${quote(selector)}).first()`;
  }
  if (!ROLE_LOCATABLE.has(nameElement.role)) throw new UnsupportedOracleError(kind, `the product name in group ${groupId} has no role or shared test ID to locate it by`);
  const position = members.filter((element) => element.role === nameElement.role).indexOf(nameElement);
  return `getByRole(${quote(nameElement.role)}).nth(${position})`;
};
