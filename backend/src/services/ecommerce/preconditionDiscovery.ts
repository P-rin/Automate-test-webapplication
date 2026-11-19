/**
 * Phase 7 — captures cart/checkout snapshots in a filled state (ECOMMERCE_TESTGEN_CONTEXT.md Phase 7,
 * steps 1-6). Runs after normal discovery, in its own browser session (isolated profile), and only in
 * GENERATION_MODE=ecommerce; normal discovery keeps DISCOVERY_BLOCKED_TERMS and its storage restore.
 *
 * For each recipe (1 product, 2 products): log in -> empty the cart -> open the listing -> click "add to cart"
 * on N products -> open the cart -> snapshot (stateLabel cart_with_N_items) -> for 1 product also open the
 * checkout page -> snapshot (checkout_with_1_item). The cart is emptied again at the end.
 * Nothing on a checkout page is ever clicked, so no order or payment can happen. A recipe that fails is
 * logged and skipped; it never fails the job.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { LoginCredentials } from "../credentialService.js";
import {
  attemptLogin,
  collectSnapshot,
  resolveLoginCredentials,
  resolvePlaywrightMcpLaunchConfig,
  settlePage,
  type SnapshotStep,
} from "../snapshotService.js";
import { classifyInventory } from "./elementClassifier.js";
import { classifyPageType } from "./pageClassifier.js";
import {
  addToCartTargets,
  appendPreconditionSection,
  buildRecipe,
  cartRemoveButtons,
  PRECONDITION_ITEM_COUNTS,
  type PageSnapshot,
  type PreconditionId,
} from "./preconditions.js";
import { buildInventory } from "./snapshotCompactor.js";
import type { ElementInventory, InventoryElement, PageType } from "./types.js";

const MAX_REMOVALS = 30;
/** Pages that load their content from a database need longer than the default settle time. */
const LOAD_SETTLE_MS = 1500;
const CLICK_SETTLE_MS = 800;

export interface ClassifiedSnapshot extends PageSnapshot {
  pageType: PageType;
}

export const classifySnapshot = (snapshot: string): ClassifiedSnapshot => {
  const first = classifyInventory(buildInventory(snapshot));
  const pageType = classifyPageType(first.inventory).pageType;
  return { snapshot, pageType, inventory: classifyInventory({ ...first.inventory, pageType }, pageType).inventory };
};

export interface CapturePlan {
  listingUrl: string;
  /** Product cards (two products possible) or a product page (one). */
  listingKind: "listing" | "product_detail";
  cartUrl?: string;
  cartPageId?: string;
  loginUrl?: string;
}

const resolveHref = (href: string | undefined, base: string): string | undefined => {
  if (!href) return undefined;
  try {
    return new URL(href, base).toString();
  } catch {
    return undefined;
  }
};

/** A link to the cart in the page chrome (its href), when the page has one. */
const cartLinkUrl = (inventory: ElementInventory): string | undefined => {
  const link = inventory.elements.find((element) => element.purpose === "cart_badge" && element.href)
    ?? inventory.elements.find((element) => element.role === "link" && element.href && /(^|\/)(cart|basket|bag)(\.html?)?([/?#]|$)/i.test(element.href));
  return resolveHref(link?.href, inventory.pageUrl);
};

/** Which discovered pages the recipes use. Undefined (with a reason) when the site shows no way to add products. */
export const planPreconditionCapture = (snapshots: SnapshotStep[]): { plan?: CapturePlan; reason?: string } => {
  const classified = snapshots.map((step) => ({ step, page: classifySnapshot(step.snapshot) }));
  const hasAddButton = (page: ClassifiedSnapshot) => page.inventory.elements.some((element) => element.purpose === "add_to_cart");
  const listing = classified.find(({ page }) => page.pageType === "listing" && hasAddButton(page))
    ?? classified.find(({ page }) => page.pageType === "product_detail" && hasAddButton(page));
  if (!listing) return { reason: "no listing or product page with an add-to-cart button was discovered" };
  const cart = classified.find(({ page }) => page.pageType === "cart");
  const login = classified.find(({ page }) => page.pageType === "login");
  const cartUrl = cart?.page.inventory.pageUrl ?? classified.map(({ page }) => cartLinkUrl(page.inventory)).find(Boolean);
  return {
    plan: {
      listingUrl: listing.page.inventory.pageUrl,
      listingKind: listing.page.pageType === "listing" ? "listing" : "product_detail",
      ...(cartUrl ? { cartUrl } : {}),
      ...(cart?.step.pageId ? { cartPageId: cart.step.pageId } : {}),
      ...(login ? { loginUrl: login.page.inventory.pageUrl } : {}),
    },
  };
};

/** The `[ref=...]` of an inventory element in the snapshot it was built from. */
export const refOf = (snapshot: string, element: InventoryElement): string | undefined =>
  snapshot.split("\n")[element.sourceLine - 1]?.match(/\[ref=([^\]]+)\]/)?.[1];

export interface PreconditionDiscoveryResult {
  snapshots: SnapshotStep[];
  notes: string[];
}

export const discoverPreconditionSnapshots = async (
  targetUrl: string,
  specification: string,
  discovered: SnapshotStep[],
  loginCredentials?: LoginCredentials | null,
): Promise<PreconditionDiscoveryResult> => {
  const notes: string[] = [];
  const { plan, reason } = planPreconditionCapture(discovered);
  if (!plan) return { snapshots: [], notes: [`preconditions skipped: ${reason}`] };

  const { command, args } = resolvePlaywrightMcpLaunchConfig();
  const transport = new StdioClientTransport({ command, args });
  const client = new Client({ name: "autonomous-verification-preconditions", version: "1.0.0" });
  await client.connect(transport);

  const navigate = async (url: string, title: string): Promise<ClassifiedSnapshot> => {
    await client.callTool({ name: "browser_navigate", arguments: { url } });
    await settlePage(client, LOAD_SETTLE_MS);
    return classifySnapshot((await collectSnapshot(client, title)).snapshot);
  };
  const click = async (page: ClassifiedSnapshot, element: InventoryElement): Promise<void> => {
    const ref = refOf(page.snapshot, element);
    if (!ref) throw new Error(`no ref for "${element.name}"`);
    await client.callTool({ name: "browser_click", arguments: { target: ref } });
    await settlePage(client, CLICK_SETTLE_MS);
  };

  let cartUrl = plan.cartUrl;
  /** Opens the cart: by URL, or (no URL known) through the listing's cart link, remembering where it led. */
  const openCart = async (title: string): Promise<ClassifiedSnapshot> => {
    if (cartUrl) return navigate(cartUrl, title);
    const listing = await navigate(plan.listingUrl, "Listing");
    const link = listing.inventory.elements.find((element) => element.purpose === "cart_badge" && element.interactive);
    if (!link) throw new Error("no cart link on the listing page");
    await click(listing, link);
    const cart = classifySnapshot((await collectSnapshot(client, title)).snapshot);
    cartUrl = cart.inventory.pageUrl;
    return cart;
  };
  /** Removes every cart row. Only remove buttons of cart rows are clicked. */
  const clearCart = async (): Promise<void> => {
    let cart = await openCart("Cart (clearing)");
    if (cart.pageType !== "cart") throw new Error(`the cart URL shows a ${cart.pageType} page`);
    for (let removed = 0; removed < MAX_REMOVALS; removed += 1) {
      const [remove] = cartRemoveButtons(cart.inventory);
      if (!remove) return;
      await click(cart, remove);
      cart = classifySnapshot((await collectSnapshot(client, "Cart (clearing)")).snapshot);
    }
    throw new Error("the cart still has rows after removing many");
  };

  const snapshots: SnapshotStep[] = [];
  try {
    const credentials = resolveLoginCredentials(specification, loginCredentials);
    if (credentials) {
      const loginPages = [...new Set([plan.loginUrl, targetUrl, new URL("/login", targetUrl).toString()].filter((url): url is string => Boolean(url)))];
      let loggedIn = false;
      for (const url of loginPages) {
        await client.callTool({ name: "browser_navigate", arguments: { url } });
        await settlePage(client, LOAD_SETTLE_MS);
        if (await attemptLogin(client, credentials, (await collectSnapshot(client, "Precondition login")).snapshot)) {
          loggedIn = true;
          break;
        }
      }
      if (!loggedIn) notes.push("preconditions: no login form found; continuing as a guest");
    }

    const ids = (plan.listingKind === "listing" ? ["seed_cart_one_item", "seed_cart_two_items"] : ["seed_cart_one_item"]) as PreconditionId[];
    for (const id of ids) {
      const itemCount = PRECONDITION_ITEM_COUNTS[id];
      try {
        await clearCart();
        let listing = await navigate(plan.listingUrl, "Listing");
        const listingBeforeClicks = listing;
        const targets = addToCartTargets(listing.inventory, itemCount);
        if (!targets) {
          notes.push(`${id}: the listing has no ${itemCount} enabled add-to-cart button(s) (logged in?)`);
          continue;
        }
        for (const target of targets) {
          // Refs change after every click: find the same product's button in a fresh snapshot.
          const fresh = listing.inventory.elements.find((element) => element.purpose === "add_to_cart"
            && element.name === target.name && element.groupLabel === target.groupLabel);
          if (!fresh) throw new Error(`the add button of "${target.groupLabel ?? target.name}" disappeared`);
          await click(listing, fresh);
          listing = classifySnapshot((await collectSnapshot(client, "Listing")).snapshot);
        }
        const cart = await openCart(`Cart with ${itemCount} item(s)`);
        const rows = cartRemoveButtons(cart.inventory).length;
        if (cart.pageType !== "cart" || rows !== itemCount) {
          notes.push(`${id}: the cart shows ${rows} row(s) after adding ${itemCount} product(s); recipe skipped`);
          continue;
        }
        const label = `cart_with_${itemCount}_item${itemCount > 1 ? "s" : ""}`;
        const recipe = buildRecipe(id, listingBeforeClicks, cart, label);
        if (!recipe) {
          notes.push(`${id}: could not compile the recipe`);
          continue;
        }
        snapshots.push({
          title: `ตะกร้าที่มีสินค้า ${itemCount} รายการ`,
          snapshot: appendPreconditionSection(cart.snapshot, recipe),
          ...(plan.cartPageId ? { pageId: plan.cartPageId } : {}),
        });

        if (itemCount !== 1) continue;
        // The cart's checkout control only opens the checkout page; nothing on that page is clicked.
        const checkoutControl = cart.inventory.elements.find((element) => element.purpose === "checkout_button" && element.interactive && !element.attrs?.disabled);
        if (!checkoutControl) continue;
        const href = checkoutControl.role === "link" ? resolveHref(checkoutControl.href, cart.inventory.pageUrl) : undefined;
        let checkout: ClassifiedSnapshot;
        if (href) {
          checkout = await navigate(href, "Checkout");
        } else {
          await click(cart, checkoutControl);
          checkout = classifySnapshot((await collectSnapshot(client, "Checkout")).snapshot);
        }
        if (checkout.pageType !== "checkout") {
          notes.push(`${id}: "${checkoutControl.name}" led to a ${checkout.pageType} page; no checkout snapshot`);
          continue;
        }
        snapshots.push({
          title: `ชำระเงินเมื่อตะกร้ามีสินค้า ${itemCount} รายการ`,
          snapshot: appendPreconditionSection(checkout.snapshot, { ...recipe, stateLabel: `checkout_with_${itemCount}_item` }),
        });
      } catch (error) {
        notes.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    try {
      // Leave the account's cart empty, as the tests do.
      if (cartUrl) await clearCart();
    } catch (error) {
      notes.push(`cleanup: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await client.callTool({ name: "browser_close", arguments: {} });
    } catch {
      // Ignore close errors.
    }
    await transport.close();
  }
  return { snapshots, notes };
};

