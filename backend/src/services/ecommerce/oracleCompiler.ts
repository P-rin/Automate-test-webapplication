/**
 * Oracle -> Playwright assertion code.
 *
 * Phase 6 covers the oracles that need only one locator or the URL. The computed oracles (counts, sorting,
 * totals, validation messages, empty states) are Phase 5 and throw UnsupportedOracleError until then, so a
 * case is never compiled with a silently weaker assertion.
 */
import type { Oracle } from "./types.js";

export class UnsupportedOracleError extends Error {
  constructor(readonly oracleKind: Oracle["kind"]) {
    super(`Oracle ${oracleKind} is not supported by the compiler yet (Phase 5)`);
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
}

export interface CompiledOracle {
  /** Lines that must run before the case steps (e.g. reading a value to compare against later). */
  before: string[];
  /** Assertion lines that run after the steps. */
  after: string[];
}

const quote = (value: string): string => JSON.stringify(value);

/** A JS regex literal matching `value` literally (for toHaveURL). */
export const literalRegex = (value: string, flags = ""): string =>
  `/${value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}/${flags}`;

export const compileOracle = (oracle: Oracle, context: OracleCompileContext): CompiledOracle => {
  switch (oracle.kind) {
    case "textVisible":
      // .first(): the same text often appears more than once (a line total equal to the cart total).
      return { before: [], after: [`await expect(page.getByText(${quote(oracle.text)}).first()).toBeVisible();`] };
    case "elementVisible":
      return { before: [], after: [`await expect(${context.locate(oracle.elementId)}).toBeVisible();`] };
    case "elementHidden":
      return { before: [], after: [`await expect(${context.locate(oracle.elementId)}).toBeHidden();`] };
    case "elementDisabled":
      return { before: [], after: [`await expect(${context.locate(oracle.elementId)}).toBeDisabled();`] };
    case "elementEnabled":
      return { before: [], after: [`await expect(${context.locate(oracle.elementId)}).toBeEnabled();`] };
    case "inputValueEquals":
      return { before: [], after: [`await expect(${context.locate(oracle.elementId)}).toHaveValue(${quote(oracle.expected)});`] };
    case "urlContains":
      return { before: [], after: [`await expect(page).toHaveURL(${literalRegex(oracle.fragment)});`] };
    case "urlUnchanged":
      return { before: [], after: [`await expect(page).toHaveURL(${quote(context.startUrl)});`] };
    case "persistsAfterReload": {
      const inner = compileOracle(oracle.inner, context);
      return {
        before: inner.before,
        after: [...inner.after, "await page.reload();", ...context.renavigate(), ...inner.after],
      };
    }
    default:
      throw new UnsupportedOracleError(oracle.kind);
  }
};
