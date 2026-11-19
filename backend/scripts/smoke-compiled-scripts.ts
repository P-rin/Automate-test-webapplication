/**
 * Phase 6 smoke test: compiles hand-picked cases from the captured fixtures with scriptCompiler and runs the
 * resulting .spec.ts files with Playwright against the real sites. Every case below is expected to PASS on a
 * correct site ("รันได้" + "ผ่านบนเว็บที่ถูกต้อง", ECOMMERCE_TESTGEN_CONTEXT.md §1.5).
 *
 * The cases name site elements on purpose: this is an evaluation script, not template code.
 *
 * Usage (from backend/, React-cart-web on --rcw, credentials from env only):
 *   TEST_EMAIL=... TEST_PASSWORD=... SAUCE_USERNAME=... SAUCE_PASSWORD=... \
 *     npx tsx scripts/smoke-compiled-scripts.ts [--rcw=http://localhost:5173]
 * Output: runtime/smoke-compiled/ (gitignored).
 */
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildInventory } from "../src/services/ecommerce/snapshotCompactor.js";
import { compileCase, compileSteps, type CompilableCase, type CompiledSteps } from "../src/services/ecommerce/scriptCompiler.js";
import type { ElementInventory, InventoryElement } from "../src/services/ecommerce/types.js";
import { validateGeneratedScript } from "../src/services/ollamaService.js";

const rcwBase = (process.argv.find((arg) => arg.startsWith("--rcw="))?.slice(6) ?? "http://localhost:5173").replace(/\/$/, "");
const fixturesDir = path.resolve(process.cwd(), "src/services/ecommerce/__fixtures__");
const runDir = path.resolve(process.cwd(), "runtime/smoke-compiled");

interface Page {
  snapshot: string;
  inventory: ElementInventory;
  id: (predicate: (element: InventoryElement) => boolean) => string;
}

const load = async (name: string): Promise<Page> => {
  const snapshot = (await readFile(path.join(fixturesDir, `${name}.txt`), "utf8"))
    .replaceAll("http://localhost:5173", rcwBase);
  const inventory = buildInventory(snapshot);
  return {
    snapshot,
    inventory,
    id: (predicate) => {
      const element = inventory.elements.find(predicate);
      if (!element) throw new Error(`${name}: element not found`);
      return element.id;
    },
  };
};

const named = (role: string, name: string, groupId?: string) => (element: InventoryElement) =>
  element.role === role && element.name === name && (groupId === undefined || element.groupId === groupId);

const loginRecipe = (page: Page, user: string, password: string, userEnv: string, passwordEnv: string, button: string): CompiledSteps => ({
  lines: compileSteps([
    ...page.inventory.navigationPath,
    { kind: "fill", elementId: page.id(named("textbox", user)), value: `{{env.${userEnv}}}` },
    { kind: "fill", elementId: page.id(named("textbox", password)), value: `{{env.${passwordEnv}}}` },
    { kind: "click", elementId: page.id(named("button", button)) },
  ], { inventory: page.inventory, fullSnapshot: page.snapshot }),
});

const cases: Array<{ name: string; page: Page; testCase: CompilableCase; preconditions?: Record<string, CompiledSteps> }> = [];

const rcwCatalog = await load("react-cart-web/guest-catalog");
cases.push({
  name: "rcw-search-not-found",
  page: rcwCatalog,
  testCase: {
    titleTh: "ค้นหาสินค้าที่ไม่มีอยู่แล้วแสดงข้อความไม่พบสินค้า",
    steps: [{ kind: "fill", elementId: rcwCatalog.id((element) => element.role === "textbox"), value: "zzqxnotfound" }],
    oracle: { kind: "textVisible", text: "ไม่พบสินค้าที่ตรงกับเงื่อนไข" },
  },
});
cases.push({
  name: "rcw-out-of-stock-card-disabled",
  page: rcwCatalog,
  testCase: {
    titleTh: "ปุ่มซื้อของสินค้าที่หมดในการ์ดสินค้าถูกปิดใช้งาน",
    steps: [],
    oracle: { kind: "elementDisabled", elementId: rcwCatalog.id(named("button", "สินค้าหมด", "G3")) },
  },
});
cases.push({
  name: "rcw-category-filter",
  page: rcwCatalog,
  testCase: {
    titleTh: "เลือกหมวดหมู่เฟอร์นิเจอร์แล้ว dropdown แสดงค่าที่เลือก",
    steps: [{ kind: "selectOption", elementId: rcwCatalog.id((element) => element.role === "combobox"), optionLabel: "เฟอร์นิเจอร์" }],
    oracle: { kind: "elementHidden", elementId: rcwCatalog.id(named("button", "เข้าสู่ระบบเพื่อซื้อ", "G1")) },
  },
});

const rcwDetail = await load("react-cart-web/guest-product-detail-out-of-stock");
cases.push({
  name: "rcw-detail-out-of-stock",
  page: rcwDetail,
  testCase: {
    titleTh: "หน้ารายละเอียดสินค้าหมด ปุ่มซื้อและช่องจำนวนถูกปิดใช้งาน",
    steps: [],
    oracle: { kind: "elementDisabled", elementId: rcwDetail.id((element) => element.role === "spinbutton") },
  },
});

const rcwLogin = await load("react-cart-web/login");
cases.push({
  name: "rcw-login-env",
  page: rcwLogin,
  testCase: {
    titleTh: "เข้าสู่ระบบด้วยบัญชีทดสอบจาก env แล้วแสดงชื่อผู้ใช้",
    steps: [
      { kind: "fill", elementId: rcwLogin.id(named("textbox", "อีเมล")), value: "{{env.TEST_EMAIL}}" },
      { kind: "fill", elementId: rcwLogin.id(named("textbox", "รหัสผ่าน")), value: "{{env.TEST_PASSWORD}}" },
      { kind: "click", elementId: rcwLogin.id(named("button", "เข้าสู่ระบบ")) },
    ],
    oracle: { kind: "textVisible", text: "เข้าสู่ระบบในชื่อ" },
  },
});

const sauceLogin = await load("saucedemo/login");
const sauceRecipe = { logged_in: loginRecipe(sauceLogin, "Username", "Password", "SAUCE_USERNAME", "SAUCE_PASSWORD", "Login") };
const sauceInventory = await load("saucedemo/inventory");
cases.push({
  name: "sauce-add-second-card",
  page: sauceInventory,
  preconditions: sauceRecipe,
  testCase: {
    titleTh: "กด Add to cart ของสินค้าชิ้นที่สองแล้วปุ่มของชิ้นนั้นเปลี่ยนไป",
    preconditionId: "logged_in",
    steps: [{ kind: "click", elementId: sauceInventory.id(named("button", "Add to cart", "G2")) }],
    oracle: { kind: "elementHidden", elementId: sauceInventory.id(named("button", "Add to cart", "G2")) },
  },
});
cases.push({
  name: "sauce-sort-select",
  page: sauceInventory,
  preconditions: sauceRecipe,
  testCase: {
    titleTh: "เลือกเรียงราคาจากน้อยไปมาก",
    preconditionId: "logged_in",
    steps: [{ kind: "selectOption", elementId: sauceInventory.id((element) => element.role === "combobox"), optionLabel: "Price (low to high)" }],
    oracle: { kind: "elementVisible", elementId: sauceInventory.id((element) => element.name.startsWith("Cart")) },
  },
});
cases.push({
  name: "sauce-second-view-details-duplicate",
  page: sauceInventory,
  preconditions: sauceRecipe,
  testCase: {
    titleTh: "คลิกชื่อสินค้า (ปุ่มที่สองที่ชื่อซ้ำในการ์ด) แล้วไปหน้ารายละเอียด",
    preconditionId: "logged_in",
    steps: [{ kind: "click", elementId: sauceInventory.inventory.elements.filter((element) => element.groupId === "G1" && element.name.startsWith("View details"))[1].id }],
    oracle: { kind: "urlContains", fragment: "inventory-item.html" },
  },
});

await rm(runDir, { recursive: true, force: true });
await mkdir(path.join(runDir, "tests"), { recursive: true });
for (const { name, page, testCase, preconditions } of cases) {
  const compiled = compileCase(testCase, { inventory: page.inventory, fullSnapshot: page.snapshot, preconditions });
  validateGeneratedScript(compiled.script);
  await writeFile(path.join(runDir, "tests", `${name}.spec.ts`), compiled.script, "utf8");
  console.log(`compiled ${name}${compiled.requiresPlaywrightEngine ? " (playwright engine)" : ""}`);
}
await writeFile(path.join(runDir, "playwright.config.ts"), [
  "import { defineConfig } from '@playwright/test';",
  "export default defineConfig({",
  "  testDir: './tests',",
  "  timeout: 30_000,",
  "  workers: 1,",
  "  reporter: [['list']],",
  "  use: { headless: true, actionTimeout: 10_000 },",
  "});",
  "",
].join("\n"), "utf8");

// Relative path: the shell would split an absolute path that contains spaces.
const result = spawnSync("npx", ["playwright", "test", "--config", path.relative(process.cwd(), path.join(runDir, "playwright.config.ts"))], {
  cwd: process.cwd(),
  stdio: "inherit",
  shell: true,
  env: process.env,
});
process.exit(result.status ?? 1);
