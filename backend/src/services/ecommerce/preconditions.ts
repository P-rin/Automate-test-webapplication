/**
 * Phase 7 — precondition recipes: put a known number of products in the cart before a cart/checkout test
 * (and before the cart/checkout snapshots are taken), so cart and checkout states get test cases at all.
 *
 * A recipe is compiled once, at discovery, from the live listing and cart snapshots, into Playwright lines:
 *   1. open the cart and remove every row (each test starts from the same, empty cart — the account's cart
 *      is shared by all tests, REACT_CART_WEB_PROFILE.md §6.2);
 *   2. open the listing and click "add to cart" on N different products;
 *   3. open the cart and wait until it shows N rows (the recipe checks itself).
 * The lines are stored in the state snapshot ("### Precondition" section), so a case planned on that
 * snapshot compiles into a self-contained test without looking up other pages.
 *
 * Never part of a recipe: login (the runner's pre-login does it), order confirmation or payment.
 */
import { termsRegexLiteral } from "./keywords.js";
import { compileSteps, resolveLocator } from "./scriptCompiler.js";
import { EMPTY_STATE_TERMS, isFinalOrderButton, isLoginish } from "./templates/helpers.js";
import type { ElementInventory, InventoryElement, InventoryGroup } from "./types.js";

export type PreconditionId = "seed_cart_one_item" | "seed_cart_two_items";

export const PRECONDITION_ITEM_COUNTS: Record<PreconditionId, number> = {
  seed_cart_one_item: 1,
  seed_cart_two_items: 2,
};

export const PRECONDITION_SECTION_HEADER = "### Precondition";
export { SHARED_STATE_MARKER } from "./scriptCompiler.js";

/** Recipe as stored in a state snapshot. */
export interface PreconditionRecipe {
  id: PreconditionId;
  /** e.g. "cart_with_1_item", "checkout_with_1_item". */
  stateLabel: string;
  itemCount: number;
  /** Compiled Playwright lines (inside the test body). */
  lines: string[];
}

export interface PageSnapshot {
  inventory: ElementInventory;
  snapshot: string;
}

const quote = (value: string): string => JSON.stringify(value);
const ROLE_CONTAINER_SELECTORS: Record<string, string> = { article: "article", listitem: "li", row: "tr" };

const groupById = (inventory: ElementInventory, id: string | undefined): InventoryGroup | undefined =>
  id ? inventory.groups.find((group) => group.id === id) : undefined;

/** An enabled add-to-cart button a guest/login link or an order button can never be mistaken for. */
const isSafeAddButton = (element: InventoryElement): boolean =>
  element.purpose === "add_to_cart" && element.interactive && !element.attrs?.disabled
  && !isLoginish(element) && !isFinalOrderButton(element)
  && !/(sold out|out of stock|unavailable|สินค้าหมด|หมดแล้ว|หมดสต็อก)/i.test(element.name);

/**
 * Add buttons of `count` different products: one per card of a listing, or the page's own button on a
 * product page (only one product there). Null when the page does not have enough.
 */
export const addToCartTargets = (inventory: ElementInventory, count: number): InventoryElement[] | null => {
  const buttons = inventory.elements.filter(isSafeAddButton);
  const inCards = buttons.filter((button) => button.groupId);
  const perCard = [...new Map(inCards.map((button) => [button.groupId, button])).values()];
  if (perCard.length >= count) return perCard.slice(0, count);
  const own = buttons.filter((button) => !button.groupId);
  return count === 1 && own.length > 0 ? [own[0]] : null;
};

/**
 * Remove buttons of the cart rows (one per row). A single row is not a repeated group, so a remove button
 * in the page's main content counts too.
 */
export const cartRemoveButtons = (inventory: ElementInventory): InventoryElement[] =>
  inventory.elements.filter((element) => element.purpose === "remove_from_cart" && element.interactive
    && (Boolean(element.groupId) || element.region === "main") && !isFinalOrderButton(element));

/** Locator of every row's remove button: the rows' container plus the button's role and name. */
export const allRemoveButtonsLocator = (cart: ElementInventory): string | null => {
  const [first] = cartRemoveButtons(cart);
  if (!first?.name) return null;
  const hint = groupById(cart, first.groupId)?.containerHint;
  const selector = hint?.startsWith("[") ? hint : hint ? ROLE_CONTAINER_SELECTORS[hint] : undefined;
  const scope = selector ? `page.locator(${quote(selector)})` : "page";
  return `${scope}.getByRole(${quote(first.role)}, { name: ${quote(first.name)}, exact: true })`;
};

/** Lines that open the cart and remove every row, then check it is empty. */
export const clearCartLines = (cart: PageSnapshot): string[] | null => {
  const removeButtons = allRemoveButtonsLocator(cart.inventory);
  if (!removeButtons) return null;
  return [
    ...compileSteps(cart.inventory.navigationPath, { inventory: cart.inventory, fullSnapshot: cart.snapshot }),
    `const removeButtons = ${removeButtons};`,
    // Rows may load after the page (e.g. from a database): wait for a row or the empty-cart message.
    `await expect(removeButtons.first().or(page.getByText(${termsRegexLiteral(EMPTY_STATE_TERMS)}).first())).toBeVisible({ timeout: 10_000 }).catch(() => undefined);`,
    "for (let removed = 0; removed < 30 && (await removeButtons.count()) > 0; removed += 1) {",
    "  const rowsBefore = await removeButtons.count();",
    "  await removeButtons.first().click();",
    "  await expect(removeButtons).toHaveCount(rowsBefore - 1);",
    "}",
    "await expect(removeButtons).toHaveCount(0);",
  ];
};

/**
 * Builds a recipe from the live listing snapshot (where the products were added) and the cart snapshot taken
 * after adding them. Null when either page lacks what the recipe needs.
 */
export const buildRecipe = (
  id: PreconditionId,
  listing: PageSnapshot,
  cart: PageSnapshot,
  stateLabel: string,
): PreconditionRecipe | null => {
  const itemCount = PRECONDITION_ITEM_COUNTS[id];
  const targets = addToCartTargets(listing.inventory, itemCount);
  const clear = clearCartLines(cart);
  if (!targets || !clear) return null;
  const listingContext = { inventory: listing.inventory, fullSnapshot: listing.snapshot };
  const cartContext = { inventory: cart.inventory, fullSnapshot: cart.snapshot };
  // After each add, open the cart and wait for the new row before adding the next product: a second click
  // while the first add is still being saved can overwrite it, and a full page load right after the click
  // can drop it. The cart is opened through the page's own cart link when there is one (no page load).
  const cartLink = listing.inventory.elements.find((element) => element.purpose === "cart_badge" && element.interactive && ["link", "button"].includes(element.role));
  const addLines = targets.flatMap((button, index) => [
    ...compileSteps([...listing.inventory.navigationPath, { kind: "click", elementId: button.id }], listingContext),
    ...(cartLink ? compileSteps([{ kind: "click", elementId: cartLink.id }], listingContext) : compileSteps(cart.inventory.navigationPath, cartContext)),
    `await expect(removeButtons).toHaveCount(${index + 1}, { timeout: 15_000 });`,
  ]);
  return {
    id,
    stateLabel,
    itemCount,
    lines: [
      `// Precondition ${id}: empty the cart, then add ${itemCount} product(s)`,
      ...clear,
      ...addLines,
      // Reloaded, the cart must still show the products: they were saved, not only shown.
      ...compileSteps(cart.inventory.navigationPath, cartContext),
      `await expect(removeButtons).toHaveCount(${itemCount}, { timeout: 15_000 });`,
    ],
  };
};

/** Locator of an add button, for checks in tests and logs. */
export const addButtonLocator = (listing: PageSnapshot, element: InventoryElement): string =>
  resolveLocator(element.id, listing.inventory, listing.snapshot);

// ---------------------------------------------------------------------------------------------
// Snapshot section

export const appendPreconditionSection = (snapshot: string, recipe: PreconditionRecipe): string =>
  `${snapshot.trimEnd()}\n\n${PRECONDITION_SECTION_HEADER}\n\`\`\`json\n${JSON.stringify(recipe)}\n\`\`\`\n`;

const isPreconditionId = (value: unknown): value is PreconditionId =>
  typeof value === "string" && value in PRECONDITION_ITEM_COUNTS;

/** The recipe stored in a state snapshot; undefined for ordinary snapshots or a malformed section. */
export const parsePreconditionSection = (snapshot: string): PreconditionRecipe | undefined => {
  const match = snapshot.match(/### Precondition\s*```json\s*([\s\S]*?)```/);
  if (!match) return undefined;
  try {
    const value = JSON.parse(match[1]) as Record<string, unknown>;
    if (!isPreconditionId(value.id) || typeof value.stateLabel !== "string" || typeof value.itemCount !== "number"
      || !Array.isArray(value.lines) || !value.lines.every((line) => typeof line === "string")) return undefined;
    return { id: value.id, stateLabel: value.stateLabel, itemCount: value.itemCount, lines: value.lines as string[] };
  } catch {
    return undefined;
  }
};
