/**
 * Captures real Playwright MCP accessibility snapshots as unit-test fixtures for the e-commerce pipeline
 * (ECOMMERCE_TESTGEN_CONTEXT.md Phase 1; REACT_CART_WEB_PROFILE.md §9).
 *
 * Usage (from backend/):
 *   TEST_EMAIL=... TEST_PASSWORD=... npx tsx scripts/capture-fixtures.ts react-cart-web [--base=http://localhost:5173]
 *   SAUCE_USERNAME=... SAUCE_PASSWORD=... npx tsx scripts/capture-fixtures.ts saucedemo
 *
 * Writes src/services/ecommerce/__fixtures__/<site>/<state>.txt.
 * Credentials are read from env only and scrubbed from every snapshot; logged-in personal data (email,
 * display name, pre-filled checkout fields) is replaced with synthetic values before writing.
 * Never clicks order confirmation/payment. Items added to a Firestore-backed cart are removed at the end.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  appendElementAttributeSection,
  COLLECT_ELEMENT_ATTRS_FUNCTION,
  COLLECT_TEST_IDS_FUNCTION,
  formatTestIdSection,
  type ElementAttributeEntry,
  insertTestIdSection,
  parseBrowserEvaluateResult,
  resolvePlaywrightMcpLaunchConfig,
  type TestIdEntry,
} from "../src/services/snapshotService.js";

const site = process.argv[2];
const baseArg = process.argv.find((arg) => arg.startsWith("--base="))?.slice("--base=".length);
const outDir = path.resolve(process.cwd(), "src", "services", "ecommerce", "__fixtures__", site ?? "");

const client = new Client({ name: "fixture-capture", version: "1.0.0" });
const secrets: string[] = [];
const replacements: Array<[string, string]> = [];

const toolText = (result: unknown): string =>
  ((result as { content?: Array<{ text?: string }> }).content ?? []).map((item) => item.text ?? "").join("\n");

const call = async (name: string, args: Record<string, unknown>): Promise<string> =>
  toolText(await client.callTool({ name, arguments: args }));

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Same shape as snapshotService.collectSnapshot in GENERATION_MODE=ecommerce: tool output with the
 * "### Test IDs" section inserted and the "### Element Attributes" section appended.
 */
const snapshot = async (waitMs = 1500): Promise<string> => {
  await pause(waitMs);
  const text = await call("browser_snapshot", {});
  let section = "";
  try {
    const entries = parseBrowserEvaluateResult(
      await client.callTool({ name: "browser_evaluate", arguments: { function: COLLECT_TEST_IDS_FUNCTION } }),
    );
    section = Array.isArray(entries) ? formatTestIdSection(entries as TestIdEntry[]) : "";
  } catch {
    // Same fallback as the pipeline: continue without test IDs.
  }
  let attributes: ElementAttributeEntry[] = [];
  try {
    const entries = parseBrowserEvaluateResult(
      await client.callTool({ name: "browser_evaluate", arguments: { function: COLLECT_ELEMENT_ATTRS_FUNCTION } }),
    );
    attributes = Array.isArray(entries) ? entries as ElementAttributeEntry[] : [];
  } catch {
    // Same fallback as the pipeline: continue without element attributes.
  }
  // "### Open tabs" lists unrelated tabs (e.g. a footer link that opened one); the pipeline never relies on it.
  return appendElementAttributeSection(insertTestIdSection(text.replace(/### Open tabs\n(?:- .*\n)*/, ""), section), attributes);
};

const navigate = async (url: string): Promise<string> => {
  await call("browser_navigate", { url });
  return snapshot();
};

/** First line whose role and quoted name match; returns its ref. */
const findRef = (snap: string, role: string, name: RegExp, extra?: RegExp): string | undefined => {
  for (const line of snap.split("\n")) {
    const match = line.match(new RegExp(`^\\s*- ${role}(?: "([^"]*)")?(.*)$`));
    if (!match) continue;
    if (!name.test(match[1] ?? "")) continue;
    if (extra && !extra.test(line)) continue;
    const ref = line.match(/\[ref=([^\]]+)\]/)?.[1];
    if (ref) return ref;
  }
  return undefined;
};

const mustRef = (snap: string, role: string, name: RegExp, extra?: RegExp): string => {
  const ref = findRef(snap, role, name, extra);
  if (!ref) throw new Error(`Element not found: ${role} ${name}`);
  return ref;
};

const scrub = (snap: string): string => {
  let result = snap;
  for (const secret of secrets) if (secret) result = result.split(secret).join("********");
  for (const [from, to] of replacements) if (from) result = result.split(from).join(to);
  // The Test IDs section cuts element text at 30 chars, which can leave a truncated value
  // (e.g. "user@gma") right before the closing quote.
  for (const value of [...secrets, ...replacements.map(([from]) => from)]) {
    for (let length = value.length - 1; length >= 4; length -= 1) {
      result = result.split(`${value.slice(0, length)}"`).join(`<redacted>"`);
    }
  }
  return result;
};

const save = async (state: string, snap: string): Promise<void> => {
  const clean = scrub(snap);
  await writeFile(path.join(outDir, `${state}.txt`), clean.endsWith("\n") ? clean : `${clean}\n`, "utf8");
  console.log(`saved ${state} (${clean.length} chars)`);
};

/** Values typed into textboxes (`- textbox "Label" [ref=..]: value`) mapped to synthetic data by label. */
const SYNTHETIC_BY_LABEL: Array<[RegExp, string]> = [
  [/อีเมล|mail/i, "test+auto@example.com"],
  [/โทร|phone|tel/i, "0800000000"],
  [/ไปรษณีย์|postal|zip/i, "10110"],
  [/ประเทศ|country/i, "ประเทศไทย"],
  [/จังหวัด|province|state/i, "กรุงเทพมหานคร"],
  [/เขต|อำเภอ|district/i, "เขตทดสอบ"],
  [/ที่อยู่|address/i, "99 ถนนทดสอบ"],
  [/ชื่อ|name/i, "Test User"],
];

const registerFilledValues = (snap: string): void => {
  for (const line of snap.split("\n")) {
    const match = line.match(/- textbox "([^"]*)"[^:\n]*\]: (.+)$/);
    if (!match) continue;
    const value = match[2].trim();
    const synthetic = SYNTHETIC_BY_LABEL.find(([pattern]) => pattern.test(match[1]))?.[1] ?? "ข้อมูลทดสอบ";
    if (value && value !== synthetic && !replacements.some(([from]) => from === value)) replacements.push([value, synthetic]);
  }
};

/** The paragraph right after "กำลังใช้งานในฐานะ"/"Logged in as" is the user's display name. */
const registerDisplayName = (snap: string): void => {
  const lines = snap.split("\n");
  const index = lines.findIndex((line) => /กำลังใช้งานในฐานะ|เข้าสู่ระบบในชื่อ|logged in as/i.test(line));
  const value = lines[index + 1]?.match(/: (.+)$/)?.[1]?.trim();
  if (index >= 0 && value && value !== "Guest" && !replacements.some(([from]) => from === value)) {
    replacements.push([value, "Test User"]);
  }
};

const productUrls = (snap: string): { inStock: string[]; outOfStock: string[] } => {
  const articles = snap.split(/\n(?=\s*- article )/).slice(1);
  const inStock: string[] = [];
  const outOfStock: string[] = [];
  for (const article of articles) {
    const url = article.match(/- \/url: (\/products\/[^\s]+)/)?.[1];
    if (!url) continue;
    (/\[disabled\]/.test(article) ? outOfStock : inStock).push(url);
  }
  return { inStock, outOfStock };
};

const captureReactCartWeb = async (): Promise<void> => {
  const base = (baseArg ?? "http://localhost:5173").replace(/\/$/, "");
  const email = process.env.TEST_EMAIL;
  const password = process.env.TEST_PASSWORD;
  if (!email || !password) throw new Error("TEST_EMAIL and TEST_PASSWORD are required");
  secrets.push(password);
  replacements.push([email, "test+auto@example.com"]);

  // Guest states
  await save("guest-home", await navigate(`${base}/`));
  const catalog = await navigate(`${base}/products`);
  await save("guest-catalog", catalog);
  const products = productUrls(catalog);
  if (products.inStock.length < 2) throw new Error("Need at least two in-stock products");
  await save("guest-product-detail-in-stock", await navigate(`${base}${products.inStock[0]}`));
  if (products.outOfStock[0]) {
    await save("guest-product-detail-out-of-stock", await navigate(`${base}${products.outOfStock[0]}`));
  }
  const searchPage = await navigate(`${base}/products`);
  await call("browser_type", { target: mustRef(searchPage, "textbox", /ค้นหา|search/i), text: "zzqxnotfound" });
  await save("catalog-search-not-found", await snapshot());
  await save("guest-cart-requires-login", await navigate(`${base}/cart`));
  await save("register", await navigate(`${base}/register`));
  const login = await navigate(`${base}/login`);
  await save("login", login);

  // Log in
  await call("browser_type", { target: mustRef(login, "textbox", /อีเมล|mail/i), text: email });
  await call("browser_type", { target: mustRef(login, "textbox", /รหัสผ่าน|password/i), text: password });
  await call("browser_click", { target: mustRef(login, "button", /^เข้าสู่ระบบ$|^log ?in$/i) });
  registerDisplayName(await snapshot(2500));

  const clearCart = async (): Promise<string> => {
    let cart = await navigate(`${base}/cart`);
    for (let guard = 0; guard < 20; guard += 1) {
      const remove = findRef(cart, "button", /ลบสินค้า|remove/i);
      if (!remove) break;
      await call("browser_click", { target: remove });
      cart = await snapshot();
    }
    return cart;
  };

  const addToCart = async (productUrl: string): Promise<void> => {
    const detail = await navigate(`${base}${productUrl}`);
    await call("browser_click", { target: mustRef(detail, "button", /เพิ่มลงตะกร้า|add to cart/i) });
    await snapshot();
  };

  try {
    const loggedInCatalog = await navigate(`${base}/products`);
    registerDisplayName(loggedInCatalog);
    await save("catalog", loggedInCatalog);
    await save("product-detail-in-stock", await navigate(`${base}${products.inStock[0]}`));
    if (products.outOfStock[0]) await save("product-detail-out-of-stock", await navigate(`${base}${products.outOfStock[0]}`));

    await save("cart-empty", await clearCart());
    await save("checkout-empty-cart", await navigate(`${base}/checkout`));

    await addToCart(products.inStock[0]);
    const cartOne = await navigate(`${base}/cart`);
    await save("cart-one-item", cartOne);

    // Checkout is opened through the cart's checkout button; "ยืนยันและชำระเงิน" is never clicked.
    await call("browser_click", { target: mustRef(cartOne, "(?:button|link)", /ดำเนินการชำระเงิน|checkout/i) });
    const checkout = await snapshot(2000);
    registerFilledValues(checkout);
    await save("checkout-with-item", checkout);

    await addToCart(products.inStock[1]);
    await save("cart-two-items", await navigate(`${base}/cart`));
  } finally {
    await clearCart();
    console.log("cart cleared");
  }
};

const captureSaucedemo = async (): Promise<void> => {
  const base = (baseArg ?? "https://www.saucedemo.com").replace(/\/$/, "");
  const username = process.env.SAUCE_USERNAME;
  const password = process.env.SAUCE_PASSWORD;
  if (!username || !password) throw new Error("SAUCE_USERNAME and SAUCE_PASSWORD are required");
  secrets.push(password);

  const login = await navigate(`${base}/`);
  await save("login", login);
  await call("browser_type", { target: mustRef(login, "textbox", /username/i), text: username });
  await call("browser_type", { target: mustRef(login, "textbox", /password/i), text: password });
  await call("browser_click", { target: mustRef(login, "button", /login/i) });
  const inventory = await snapshot(2000);
  await save("inventory", inventory);

  // Product titles are buttons ("View details for ...") or links whose /url is a product page.
  const itemRef = findRef(inventory, "button", /^view details for /i)
    ?? findRef(inventory, "link", /./, /inventory[_-]item/i);
  if (!itemRef) throw new Error("Product detail entry not found on inventory page");
  await call("browser_click", { target: itemRef });
  await save("inventory-item", await snapshot());

  await save("cart-empty", await navigate(`${base}/cart.html`));
  let page = await navigate(`${base}/inventory.html`);
  await call("browser_click", { target: mustRef(page, "button", /add to cart/i) });
  page = await snapshot();
  await save("inventory-one-in-cart", page);
  await save("cart-one-item", await navigate(`${base}/cart.html`));
  page = await navigate(`${base}/inventory.html`);
  await call("browser_click", { target: mustRef(page, "button", /add to cart/i) });
  await snapshot();
  const cartTwo = await navigate(`${base}/cart.html`);
  await save("cart-two-items", cartTwo);
  await call("browser_click", { target: mustRef(cartTwo, "button", /checkout/i) });
  const stepOne = await snapshot();
  await save("checkout-step-one", stepOne);
  await call("browser_type", { target: mustRef(stepOne, "textbox", /first name/i), text: "Test" });
  await call("browser_type", { target: mustRef(stepOne, "textbox", /last name/i), text: "User" });
  await call("browser_type", { target: mustRef(stepOne, "textbox", /zip|postal/i), text: "10110" });
  await call("browser_click", { target: mustRef(stepOne, "button", /continue/i) });
  // Overview page only; "Finish" (places the order) is never clicked.
  await save("checkout-step-two", await snapshot());
};

const sites: Record<string, () => Promise<void>> = {
  "react-cart-web": captureReactCartWeb,
  saucedemo: captureSaucedemo,
};

if (!site || !sites[site]) {
  console.error(`Usage: npx tsx scripts/capture-fixtures.ts <${Object.keys(sites).join("|")}> [--base=url]`);
  process.exit(1);
}

await mkdir(outDir, { recursive: true });
await client.connect(new StdioClientTransport(resolvePlaywrightMcpLaunchConfig()));
let exitCode = 0;
try {
  await sites[site]();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
}
process.exit(exitCode);
