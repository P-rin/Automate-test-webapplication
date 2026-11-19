import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AcceptanceCriterion } from "../../types.js";
import {
  batchCandidates,
  buildSelectionPrompt,
  fallbackSelections,
  keywordRequirementIds,
  MAX_CANDIDATES_PER_CALL,
  renderCandidateLine,
  selectCandidates,
  type AskJson,
} from "./candidateSelector.js";
import { classifyInventory } from "./elementClassifier.js";
import { classifyPageType } from "./pageClassifier.js";
import { buildInventory } from "./snapshotCompactor.js";
import { generateCandidates } from "./templates/index.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");

const page = (name: string, statePreconditionId?: string) => {
  const first = classifyInventory(buildInventory(readFileSync(path.join(FIXTURES, `${name}.txt`), "utf8")));
  const pageType = classifyPageType(first.inventory).pageType;
  const inventory = classifyInventory({ ...first.inventory, pageType }, pageType).inventory;
  const { candidates } = generateCandidates({
    inventory, pageType, allowMutatingTests: false, availablePreconditions: [], credentials: { hasLogin: true }, statePreconditionId,
  });
  return { inventory, candidates };
};

const criterion = (id: string, scenario: string, action: string, expected: string): AcceptanceCriterion => ({
  id, requirementRef: "R", scenario, action, expected, mustNot: "", category: "happy_path", priority: "required", verification: "automated", ambiguity: "",
});

test("candidate lines are short and say category, mandatory, title and expectation", () => {
  const { candidates } = page("react-cart-web/product-detail-in-stock");
  const zero = candidates.find((candidate) => candidate.templateId === "num.zero")!;
  assert.match(renderCandidateLine(zero), /^C\d+ \[boundary, mandatory\] ใส่ 0 ในช่องจำนวน .* → ระบบไม่ยอมรับจำนวน 0/);
});

test("batches hold at most 8 candidates and keep an element's cases together when they fit", () => {
  const { candidates } = page("react-cart-web/checkout-with-item", "seed_cart_one_item");
  assert.ok(candidates.length > MAX_CANDIDATES_PER_CALL);
  const batches = batchCandidates(candidates);
  assert.ok(batches.every((batch) => batch.length <= MAX_CANDIDATES_PER_CALL));
  assert.deepEqual(batches.flat().map((candidate) => candidate.id).sort(), candidates.map((candidate) => candidate.id).sort());
});

test("mandatory candidates stay when the model drops them; unanswered optional ones are dropped", async () => {
  const { inventory, candidates } = page("react-cart-web/product-detail-in-stock");
  const ask: AskJson = async (_prompt, schema) => {
    const ids: string[] = (schema as any).properties.selections.items.properties.candidateId.enum;
    // Answer only the first candidate of each batch, always keep=false.
    return JSON.stringify({ selections: [{ candidateId: ids[0], keep: false, requirementIds: [], titleTh: "" }] });
  };
  const { selections, stats } = await selectCandidates({ candidates, inventory, acceptanceCriteria: [], coveredAcIds: new Set() }, ask);
  for (const candidate of candidates) {
    const selection = selections.find((entry) => entry.candidateId === candidate.id)!;
    assert.equal(selection.keep, candidate.mandatory, candidate.templateId);
  }
  assert.ok(stats.issues.some((issue) => issue.startsWith("no answer for")));
});

test("a failing call falls back to mandatory + the first happy path of each template, with keyword AC links", async () => {
  const { inventory, candidates } = page("saucedemo/inventory");
  const criteria = [criterion("AC-001", "เรียงสินค้า", "เลือก Price (low to high) ใน Sort products", "สินค้าเรียงตามราคา")];
  const { selections, stats } = await selectCandidates({ candidates, inventory, acceptanceCriteria: criteria, coveredAcIds: new Set() }, async () => {
    throw new Error("timeout");
  });
  assert.equal(stats.failedCalls, stats.calls);
  assert.equal(stats.fallbackCandidates, candidates.length);
  const kept = selections.filter((selection) => selection.keep).map((selection) => candidates.find((candidate) => candidate.id === selection.candidateId)!.templateId);
  assert.ok(kept.includes("listing.add_to_cart"));
  assert.ok(!kept.includes("listing.add_twice"));
  const sort = selections.find((selection) => candidates.find((candidate) => candidate.id === selection.candidateId)!.templateId === "listing.sort")!;
  assert.deepEqual(sort.requirementIds, ["AC-001"], "the AC names the sort element");
  assert.deepEqual(fallbackSelections([], inventory, criteria), []);
});

test("keyword AC matching links by element label or shared words, not by chance", () => {
  const { inventory, candidates } = page("react-cart-web/login");
  const invalid = candidates.find((candidate) => candidate.templateId === "auth.login_invalid")!;
  assert.deepEqual(keywordRequirementIds(invalid, inventory, [criterion("AC-009", "เข้าสู่ระบบผิด", "กรอก รหัสผ่าน ผิด", "แสดงข้อความ")]), ["AC-009"]);
  assert.deepEqual(keywordRequirementIds(invalid, inventory, [criterion("AC-010", "ตะกร้า", "ลบสินค้า", "ยอดรวมลดลง")]), []);
});

test("the selection prompt lists ACs and candidates, and adds the page only within budget", () => {
  const { inventory, candidates } = page("saucedemo/inventory");
  const input = {
    candidates, inventory, acceptanceCriteria: [criterion("AC-001", "เพิ่มสินค้า", "กด Add to cart", "จำนวนในตะกร้าเพิ่ม")], coveredAcIds: new Set<string>(),
  };
  const withPage = buildSelectionPrompt(candidates, { ...input, pageText: "PAGE /inventory.html", maxPromptChars: 6000 });
  assert.match(withPage, /AC-001/);
  assert.match(withPage, /\[หน้าเว็บ\]\nPAGE \/inventory\.html/);
  assert.match(withPage, /ห้ามสร้าง case ใหม่/);
  const tooBig = buildSelectionPrompt(candidates, { ...input, pageText: "x".repeat(10_000), maxPromptChars: 6000 });
  assert.doesNotMatch(tooBig, /\[หน้าเว็บ\]/);
  assert.ok(tooBig.length < 6000);
});
