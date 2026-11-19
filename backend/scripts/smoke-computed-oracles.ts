/**
 * Phase 5 smoke test: real template candidates of the captured fixtures, compiled with their computed
 * oracles, run with Playwright against the real sites. A case that fails here is either a template/oracle
 * problem or a real bug of the site; the report prints Playwright's message so they can be told apart.
 *
 * The state recipes below name site elements on purpose: this is an evaluation script, not template code
 * (Phase 7 replaces them with generated precondition recipes).
 * Safety: a spec that clicks an order confirmation/payment button is refused, and cart rows are never removed
 * (only items added by the recipes are changed).
 *
 * Usage (from backend/, credentials from env only):
 *   TEST_EMAIL=... TEST_PASSWORD=... SAUCE_USERNAME=... SAUCE_PASSWORD=... npx tsx scripts/smoke-computed-oracles.ts [--rcw=http://localhost:5173] [--only=substring]
 * Output: runtime/smoke-oracles/ (gitignored).
 */
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { classifyInventory } from "../src/services/ecommerce/elementClassifier.js";
import { classifyPageType } from "../src/services/ecommerce/pageClassifier.js";
import { compileCase } from "../src/services/ecommerce/scriptCompiler.js";
import { buildInventory } from "../src/services/ecommerce/snapshotCompactor.js";
import { FINAL_ORDER_TERMS } from "../src/services/ecommerce/templates/helpers.js";
import { generateCandidates } from "../src/services/ecommerce/templates/index.js";
import { matchesAnyTerm } from "../src/services/ecommerce/keywords.js";
import { validateGeneratedScript } from "../src/services/ollamaService.js";

const rcwBase = (process.argv.find((arg) => arg.startsWith("--rcw="))?.slice(6) ?? "http://localhost:5173").replace(/\/$/, "");
const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice(7);
const fixturesDir = path.resolve(process.cwd(), "src/services/ecommerce/__fixtures__");
const runDir = path.resolve(process.cwd(), "runtime/smoke-oracles");
const q = (value: string) => JSON.stringify(value);

const rcwLogin = [
  `await page.goto(${q(`${rcwBase}/login`)});`,
  "await page.getByRole(\"textbox\", { name: \"อีเมล\", exact: true }).fill(process.env.TEST_EMAIL ?? '');",
  "await page.getByRole(\"textbox\", { name: \"รหัสผ่าน\", exact: true }).fill(process.env.TEST_PASSWORD ?? '');",
  "await page.getByRole(\"button\", { name: \"เข้าสู่ระบบ\", exact: true }).click();",
  "await expect(page).not.toHaveURL(/\\/login/);",
];
const rcwAddAirPods = [
  `await page.goto(${q(`${rcwBase}/products/prd_airpods_pro_2_usb_c`)});`,
  "await page.getByRole(\"button\", { name: \"เพิ่มลงตะกร้า\", exact: true }).click();",
  // Firebase keeps connections open (no networkidle): wait until the cart shows the item instead.
  `await page.goto(${q(`${rcwBase}/cart`)});`,
  "await expect(page.locator(\"article\").filter({ hasText: \"AirPods Pro 2 USB-C\" })).toBeVisible({ timeout: 15_000 });",
];
const sauceLogin = [
  "await page.goto(\"https://www.saucedemo.com/\");",
  "await page.getByPlaceholder(\"Username\").fill(process.env.SAUCE_USERNAME ?? '');",
  "await page.getByPlaceholder(\"Password\").fill(process.env.SAUCE_PASSWORD ?? '');",
  "await page.getByRole(\"button\", { name: \"Login\" }).click();",
];
const sauceTwoItems = [
  ...sauceLogin,
  "await page.locator('[data-test=\"add-to-cart-sauce-labs-backpack\"]').click();",
  "await page.locator('[data-test=\"add-to-cart-sauce-labs-bike-light\"]').click();",
];
const sauceCheckoutInfo = [
  ...sauceTwoItems,
  "await page.goto(\"https://www.saucedemo.com/cart.html\");",
  "await page.getByRole(\"button\", { name: \"Checkout\" }).click();",
];
const sauceCheckoutOverview = [
  ...sauceCheckoutInfo,
  "await page.getByPlaceholder(\"First Name\").fill(\"Test\");",
  "await page.getByPlaceholder(\"Last Name\").fill(\"User\");",
  "await page.getByPlaceholder(\"Zip/Postal Code\").fill(\"10110\");",
  "await page.getByRole(\"button\", { name: \"Continue\" }).click();",
];

/** Fixture, the state recipe that reproduces it, and the templates to run (all when omitted). */
const PAGES: Array<{ fixture: string; recipe: string[]; templates?: string[]; skip?: string[] }> = [
  { fixture: "saucedemo/inventory", recipe: sauceLogin, templates: ["listing.add_to_cart", "listing.add_twice", "listing.sort"] },
  { fixture: "saucedemo/cart-two-items", recipe: sauceTwoItems },
  { fixture: "saucedemo/checkout-step-one", recipe: sauceCheckoutInfo },
  { fixture: "saucedemo/checkout-step-two", recipe: sauceCheckoutOverview },
  { fixture: "react-cart-web/catalog", recipe: rcwLogin, templates: ["search.found", "search.case_insensitive", "search.empty", "search.not_found", "product.out_of_stock"] },
  { fixture: "react-cart-web/product-detail-in-stock", recipe: rcwLogin },
  // Removing rows could delete the account's own items: only the line/subtotal/stepper checks run.
  { fixture: "react-cart-web/cart-two-items", recipe: [...rcwLogin, ...rcwAddAirPods], skip: ["cart.remove_item", "cart.remove_last"] },
  { fixture: "react-cart-web/checkout-with-item", recipe: [...rcwLogin, ...rcwAddAirPods] },
];

const clicksFinalOrder = (script: string): boolean => script.split("\n").some((line) =>
  /\.click\(\)/.test(line) && [...line.matchAll(/name: "([^"]+)"/g)].some((match) => matchesAnyTerm(match[1], FINAL_ORDER_TERMS)));

await rm(runDir, { recursive: true, force: true });
await mkdir(path.join(runDir, "tests"), { recursive: true });
const written: Array<{ file: string; name: string; oracle: string }> = [];
for (const page of PAGES) {
  const snapshot = (await readFile(path.join(fixturesDir, `${page.fixture}.txt`), "utf8")).replaceAll("http://localhost:5173", rcwBase);
  const first = classifyInventory(buildInventory(snapshot));
  const pageType = classifyPageType(first.inventory).pageType;
  const inventory = classifyInventory({ ...first.inventory, pageType }, pageType).inventory;
  const { candidates } = generateCandidates({
    inventory, pageType, allowMutatingTests: false, availablePreconditions: ["state"], statePreconditionId: "state", credentials: { hasLogin: true },
  });
  const context = { inventory, fullSnapshot: snapshot, preconditions: { state: { lines: page.recipe } } };
  for (const candidate of candidates) {
    if (page.templates && !page.templates.includes(candidate.templateId)) continue;
    if (page.skip?.includes(candidate.templateId)) continue;
    const name = `${page.fixture.replace("/", "__")}__${candidate.id}_${candidate.templateId}`;
    if (only && !name.includes(only)) continue;
    let compiled;
    try {
      compiled = compileCase({ ...candidate, preconditionId: "state" }, context);
      validateGeneratedScript(compiled.script);
    } catch (error) {
      console.log(`COMPILE-FAIL ${name}: ${(error as Error).message}`);
      continue;
    }
    if (clicksFinalOrder(compiled.script)) {
      console.log(`REFUSED ${name}: clicks an order confirmation/payment button`);
      continue;
    }
    const file = `${name}.spec.ts`;
    await writeFile(path.join(runDir, "tests", file), compiled.script, "utf8");
    written.push({ file, name, oracle: candidate.oracle.kind });
  }
}

await writeFile(path.join(runDir, "playwright.config.ts"), [
  "import { defineConfig } from '@playwright/test';",
  "export default defineConfig({",
  "  testDir: './tests',",
  "  timeout: 60_000,",
  "  workers: 1,",
  "  expect: { timeout: 8_000 },",
  "  reporter: [['json', { outputFile: './report.json' }]],",
  "  outputDir: './test-results',",
  "});",
  "",
].join("\n"), "utf8");

console.log(`Running ${written.length} specs...`);
spawnSync("npx", ["playwright", "test", "--config", "playwright.config.ts"], { cwd: runDir, stdio: "ignore", shell: true, env: process.env });

interface JsonSpec { file: string; tests: Array<{ results: Array<{ status: string; error?: { message?: string } }> }> }
interface JsonSuite { specs?: JsonSpec[]; suites?: JsonSuite[] }
const report = JSON.parse(await readFile(path.join(runDir, "report.json"), "utf8")) as { suites: JsonSuite[] };
const specs: JsonSpec[] = [];
const walk = (suite: JsonSuite) => {
  specs.push(...(suite.specs ?? []));
  (suite.suites ?? []).forEach(walk);
};
report.suites.forEach(walk);
let passed = 0;
for (const entry of written) {
  const spec = specs.find((candidate) => candidate.file.endsWith(entry.file));
  const result = spec?.tests[0]?.results.at(-1);
  const status = result?.status ?? "missing";
  if (status === "passed") passed += 1;
  const message = (result?.error?.message ?? "").replace(/\u001b\[[0-9;]*m/g, "").split("\n").filter(Boolean).slice(0, 3).join(" | ");
  console.log(`${status.toUpperCase().padEnd(8)} ${entry.name} [${entry.oracle}]${message ? `\n         ${message.slice(0, 300)}` : ""}`);
}
console.log(`\n${passed}/${written.length} passed`);
