import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateGeneratedScript } from "../ollamaService.js";
import { classifyInventory } from "./elementClassifier.js";
import { termsRegexLiteral, VALIDATION_ERROR_TERMS } from "./keywords.js";
import { compileOracle, UnsupportedOracleError } from "./oracleCompiler.js";
import { HELPERS, helperSources, type HelperName } from "./oracleHelpers.js";
import { classifyPageType } from "./pageClassifier.js";
import { compileCase } from "./scriptCompiler.js";
import { buildInventory } from "./snapshotCompactor.js";
import { generateCandidates } from "./templates/index.js";
import type { CandidateCase, ElementInventory, Oracle } from "./types.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const PRECONDITION = "seed_state";

const prepare = (name: string) => {
  const snapshot = readFileSync(path.join(FIXTURES, `${name}.txt`), "utf8");
  const first = classifyInventory(buildInventory(snapshot));
  const pageType = classifyPageType(first.inventory).pageType;
  const inventory: ElementInventory = classifyInventory({ ...first.inventory, pageType }, pageType).inventory;
  const { candidates } = generateCandidates({
    inventory, pageType, allowMutatingTests: false, availablePreconditions: [PRECONDITION], statePreconditionId: PRECONDITION, credentials: { hasLogin: true },
  });
  const context = { inventory, fullSnapshot: snapshot, preconditions: { [PRECONDITION]: { lines: ["await page.goto(\"about:blank\");"] } } };
  return { inventory, candidates, context, compile: (candidate: CandidateCase) => compileCase(candidate, context) };
};

/** Runs the helper sources (plain JS) the way a spec would define them. */
const loadHelpers = (): Record<HelperName, (...args: unknown[]) => unknown> => {
  const names = Object.keys(HELPERS) as HelperName[];
  return new Function(`${helperSources(names).join("\n")}\nreturn { ${names.join(", ")} };`)();
};
const helpers = loadHelpers();

// ---------------------------------------------------------------------------------------------
// helper logic

test("parseAmount reads Thai baht, dollar and plain amounts", () => {
  const cases: Array<[string, number]> = [
    ["฿7,990", 7990],
    ["฿8,549.3", 8549.3],
    ["฿7,990 ต่อชิ้น", 7990],
    ["Item total: $39.98", 39.98],
    ["Total: $43.18", 43.18],
    ["1,290 บาท", 1290],
    ["1,290.50 THB", 1290.5],
    ["THB 99", 99],
    ["-฿120", -120],
    ["-฿0", -0],
    ["ภาษี (7%) ฿559.3", 559.3],
    ["2", 2],
    ["คงเหลือ 43", 43],
  ];
  for (const [text, expected] of cases) assert.equal(helpers.parseAmount(text), expected, text);
  assert.ok(Number.isNaN(helpers.parseAmount("ไม่มีตัวเลข") as number));
  // An amount after a dash-separated label is not negative.
  assert.equal(helpers.parseAmount("Shipping - $5.00"), 5);
});

test("lastAmount takes the line total at the end of a cart row", () => {
  assert.equal(helpers.lastAmount("AirPods ฿7,990 ต่อชิ้น สินค้าคงเหลือ: 43 - 2 + ฿15,980 ลบสินค้า"), 15980);
  assert.equal(helpers.lastAmount("1 Sauce Labs Backpack carry.allTheThings() $29.99 Remove"), 29.99);
});

test("compareAmount accepts rounding to the shown precision only", () => {
  assert.equal(helpers.compareAmount("tax", "฿559.3", 7990 * 0.07), "");
  assert.equal(helpers.compareAmount("tax", "฿559", 559.3), "");
  assert.match(helpers.compareAmount("tax", "฿560.3", 559.3) as string, /shown 560.3, expected 559.3/);
  assert.match(helpers.compareAmount("tax", "$3.21", 3.2) as string, /shown 3.21/);
  assert.match(helpers.compareAmount("tax", "n/a", 1) as string, /no amount/);
});

test("checkTotal adds fees and subtracts discounts shown with or without a minus", () => {
  assert.equal(helpers.checkTotal("฿8,549.3", ["฿7,990", "฿0", "฿559.3"], ["-฿0"]), "");
  assert.equal(helpers.checkTotal("฿900", ["฿1,000"], ["-฿100"]), "");
  assert.equal(helpers.checkTotal("฿900", ["฿1,000"], ["฿100"]), "");
  assert.match(helpers.checkTotal("฿1,100", ["฿1,000"], ["-฿100"]) as string, /total: shown 1100, expected 900/);
  assert.equal(helpers.checkTotal("Total: $43.18", ["Item total: $39.98", "Tax: $3.20"], []), "");
});

test("checkPercentage, checkLineTotal and checkSubtotal", () => {
  assert.equal(helpers.checkPercentage("฿559.3", "฿7,990", 7), "");
  assert.match(helpers.checkPercentage("฿600", "฿7,990", 7) as string, /7% of 7990/);
  assert.equal(helpers.checkLineTotal("฿15,980", "฿7,990 ต่อชิ้น", "2"), "");
  assert.match(helpers.checkLineTotal("฿7,990", "฿7,990 ต่อชิ้น", "2") as string, /expected 15980/);
  assert.equal(helpers.checkSubtotal("฿53,890", ["A ฿7,990 ต่อชิ้น 1 ฿7,990", "B ฿45,900 ต่อชิ้น 1 ฿45,900"]), "");
  assert.match(helpers.checkSubtotal("฿53,890", []) as string, /no rows/);
});

test("checkSorted compares numbers numerically and text case-insensitively", () => {
  assert.equal(helpers.checkSorted([7.99, 9.99, 15.99, 49.99], "asc"), "");
  assert.match(helpers.checkSorted([9.99, 7.99], "asc") as string, /items 1 and 2 are not in asc order/);
  assert.equal(helpers.checkSorted([49.99, 15.99, 15.99], "desc"), "");
  assert.equal(helpers.checkSorted(["apple", "Banana", "cherry"], "asc"), "");
  assert.equal(helpers.checkSorted(["Test.allTheThings() T-Shirt (Red)", "Sauce Labs Onesie"], "desc"), "");
  assert.match(helpers.checkSorted([1], "asc") as string, /at least 2/);
  assert.match(helpers.checkSorted([1, Number.NaN], "asc") as string, /could not read/);
});

test("checkAllContain needs at least one item and matches case-insensitively", () => {
  assert.equal(helpers.checkAllContain(["AirPods Pro 2 USB-C ฿7,990"], "airpods pro 2 usb-c"), "");
  assert.match(helpers.checkAllContain([], "x") as string, /no items/);
  assert.match(helpers.checkAllContain(["AirPods", "Dell XPS"], "airpods") as string, /item 2 does not contain/);
});

test("validation error terms match English words whole and Thai anywhere", () => {
  const pattern = new Function(`return ${termsRegexLiteral(VALIDATION_ERROR_TERMS)};`)() as RegExp;
  for (const text of ["This field is required", "กรุณากรอกอีเมล", "Error: Last Name is required", "จำนวนต้องไม่เกินสต็อก", "อีเมลไม่ถูกต้อง"]) assert.match(text, pattern, text);
  for (const text of ["Requirements", "เพิ่มลงตะกร้าแล้ว", "Terror Books"]) assert.doesNotMatch(text, pattern, text);
});

test("helpers are emitted once each with their dependencies first", () => {
  const sources = helperSources(["checkTotal", "compareAmount", "parseAmount"]);
  const names = sources.map((source) => source.match(/function (\w+)/)![1]);
  assert.deepEqual(new Set(names).size, names.length);
  assert.ok(names.indexOf("amountTokens") < names.indexOf("parseAmount"));
  assert.ok(names.indexOf("compareAmount") < names.indexOf("checkTotal"));
});

// ---------------------------------------------------------------------------------------------
// compiled oracles on real fixtures

test("every template candidate of every fixture compiles into a valid spec", () => {
  const unsupported: string[] = [];
  let compiled = 0;
  for (const site of ["react-cart-web", "saucedemo"]) {
    for (const file of readdirSync(path.join(FIXTURES, site)).filter((name) => name.endsWith(".txt"))) {
      const name = `${site}/${file.replace(/\.txt$/, "")}`;
      const page = prepare(name);
      for (const candidate of page.candidates) {
        try {
          const result = page.compile(candidate);
          validateGeneratedScript(result.script);
          compiled += 1;
        } catch (error) {
          if (error instanceof UnsupportedOracleError) unsupported.push(`${name} ${candidate.templateId}: ${error.message}`);
          else throw new Error(`${name} ${candidate.templateId} (${candidate.oracle.kind}): ${(error as Error).message}`);
        }
      }
    }
  }
  assert.ok(compiled > 50, `compiled ${compiled}`);
  // Product names that are plain text (no role, no shared test ID) cannot be sorted by name; no fixture needs it.
  assert.deepEqual(unsupported, []);
});

test("computed oracles read the shown values and need the playwright engine", () => {
  const checkout = prepare("react-cart-web/checkout-with-item");
  const formula = checkout.compile(checkout.candidates.find((candidate) => candidate.templateId === "checkout.total_formula")!);
  assert.match(formula.script, /^async function readPairValue\(label\)/m);
  assert.match(formula.script, /checkTotal\(await readPairValue\(page\.getByText\("ยอดสุทธิ", \{ exact: true \}\)\), \[await readPairValue/);
  // No amount from the snapshot is hard-coded into the assertion.
  assert.doesNotMatch(formula.script.split("test(")[1], /8,549|8549|7,990/);
  assert.equal(formula.requiresPlaywrightEngine, true);

  const tax = checkout.compile(checkout.candidates.find((candidate) => candidate.templateId === "checkout.tax_rate")!);
  assert.match(tax.script, /checkPercentage\(await readPairValue\(page\.getByText\("ภาษี \(7%\)", \{ exact: true \}\)\), await readPairValue\(page\.getByText\("ยอดรวมสินค้า", \{ exact: true \}\)\), 7\)/);
});

test("sortedBy reads every card: prices by amount, names by the name element's role and position", () => {
  const sauce = prepare("saucedemo/inventory");
  const sorts = sauce.candidates.filter((candidate) => candidate.templateId === "listing.sort");
  const byField = (field: string) => sauce.compile(sorts.find((candidate) => candidate.oracle.kind === "sortedBy" && candidate.oracle.field === field)!).script;
  assert.match(byField("price"), /checkSorted\(\(await page\.locator\("\[data-test=\\"inventory-item\\"\]"\)\.allInnerTexts\(\)\)\.map\(parseAmount\), "asc"\)/);
  // The first button of a card is the image link; the second shows the product name.
  assert.match(byField("name"), /for \(const item of await page\.locator\("\[data-test=\\"inventory-item\\"\]"\)\.all\(\)\) names\.push\(\(await item\.getByRole\("button"\)\.nth\(1\)\.innerText\(\)\)\.trim\(\)\);/);
});

test("countChangedBy reads the counter before the click and polls it after", () => {
  const sauce = prepare("saucedemo/inventory");
  const add = sauce.compile(sauce.candidates.find((candidate) => candidate.templateId === "listing.add_to_cart")!);
  const body = add.script.split("\n").map((line) => line.trim());
  const before = body.findIndex((line) => line.startsWith("const countBefore = await readCount(page.getByRole(\"button\", { name: /^Cart/ }))"));
  const click = body.findIndex((line) => /Add to cart.*\.click\(\);/.test(line));
  const poll = body.findIndex((line) => line.startsWith("await expect.poll(() => readCount("));
  assert.ok(before >= 0 && before < click && click < poll, body.join("\n"));
  assert.match(body[poll], /\.toBe\(countBefore \+ 1\);$/);
});

test("validationMessageShown counts error texts before the steps and accepts native or shown errors", () => {
  const detail = prepare("react-cart-web/product-detail-in-stock");
  const zero = detail.compile(detail.candidates.find((candidate) => candidate.templateId === "num.zero")!);
  const body = zero.script.split("\n").map((line) => line.trim());
  const before = body.findIndex((line) => line.startsWith("const errorsBefore = await countMatchingTexts(page, /"));
  const fill = body.findIndex((line) => line.endsWith(".fill(\"0\");"));
  assert.ok(before >= 0 && before < fill);
  assert.equal(zero.requiresPlaywrightEngine, true);
  assert.match(body.at(-3)!, /^await expect\.poll\(\(\) => hasValidationError\(page\.getByRole\("spinbutton"\), page, errorsBefore, \/.*\/i\)/);
});

test("cart row oracles use the row's own elements and all rows of the set", () => {
  const cart = prepare("react-cart-web/cart-two-items");
  const line = cart.compile(cart.candidates.find((candidate) => candidate.templateId === "cart.line_total")!).script;
  const row = 'page.locator("article").filter({ hasText: "AirPods Pro 2 USB-C" })';
  // Amounts and quantities change with the cart, so they are located by pattern and position, not by value.
  const valueText = (index: number) => String.raw`${row}.getByText(/^-?(?:[฿$€£¥]\s?)?-?\d[\d,]*(?:\.\d+)?(?:\s?(?:บาท|THB|USD|EUR))?$/).nth(${index})`;
  assert.ok(line.includes(`checkLineTotal(await ${valueText(1)}.innerText(), await ${row}.getByText("฿7,990 ต่อชิ้น", { exact: true }).innerText(), await ${valueText(0)}.innerText())`), line);
  const subtotal = cart.compile(cart.candidates.find((candidate) => candidate.templateId === "cart.subtotal")!).script;
  assert.match(subtotal, /checkSubtotal\(await readPairValue\(page\.getByText\("ยอดรวม", \{ exact: true \}\)\), await page\.locator\("article"\)\.allInnerTexts\(\)\)/);
});

test("other computed oracles", () => {
  const context = {
    locate: (id: string) => `page.getByRole("combobox", { name: ${JSON.stringify(id)} })`,
    startUrl: "https://shop.example/",
    renavigate: () => [],
  };
  assert.deepEqual(compileOracle({ kind: "selectedOptionIs", elementId: "E1", label: "Price (low to high)" }, context).after,
    ["await expect(page.getByRole(\"combobox\", { name: \"E1\" }).locator(\"option:checked\")).toHaveText(\"Price (low to high)\");"]);
  const unchanged = compileOracle({ kind: "textUnchanged", elementId: "E1" }, context);
  assert.deepEqual(unchanged.before, ["const shownBefore = await page.getByRole(\"combobox\", { name: \"E1\" }).innerText();"]);
  assert.match(compileOracle({ kind: "emptyStateShown" }, context).after[0], /getByText\(\/\(\?:\\bempty\\b\|.*ไม่พบ.*\)\/i\)\.filter\(\{ visible: true \}\)\.first\(\)\)\.toBeVisible\(\)/);
  const reload = compileOracle({ kind: "persistsAfterReload", inner: { kind: "countChangedBy", elementId: "E1", delta: 1 } } as Oracle, context);
  assert.equal(reload.before.length, 1);
  assert.deepEqual(reload.helpers, ["readCount"]);
});
