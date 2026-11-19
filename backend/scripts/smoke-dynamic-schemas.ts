/**
 * Phase 2 smoke test against a real Ollama model (not part of `npm test`: needs Ollama running).
 * Sends the dynamic schemas with deliberate traps (IDs that do not exist) and prints raw + validated answers.
 *
 * Usage (from backend/):
 *   npx tsx scripts/smoke-dynamic-schemas.ts [--model=qwen3.5:4b] [--host=http://localhost:11434]
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildExploratorySchema,
  buildPurposeSchema,
  buildSelectionSchema,
  parseExploratoryResponse,
  parsePurposeResponse,
  parseSelectionResponse,
  promptElements,
} from "../src/services/ecommerce/dynamicSchemas.js";
import { buildInventory, renderInventoryForPrompt } from "../src/services/ecommerce/snapshotCompactor.js";

const option = (name: string, fallback: string): string =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const model = option("model", "qwen3.5:4b");
const host = option("host", "http://localhost:11434").replace(/\/$/, "");

const chat = async (label: string, prompt: string, format: object): Promise<string> => {
  const started = Date.now();
  const response = await fetch(`${host}/api/chat`, {
    method: "POST",
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      format,
      messages: [{ role: "user", content: prompt }],
      options: { temperature: 0.1, num_ctx: 8192 },
    }),
  });
  const body = await response.json() as { error?: string; message?: { content: string } };
  if (body.error || !body.message) throw new Error(body.error ?? "no message");
  console.log(`\n## ${label} (${Date.now() - started} ms, prompt ${prompt.length} chars)`);
  console.log(body.message.content);
  return body.message.content;
};

const selectionRaw = await chat(
  "selection (trap: asks for C9 and AC-999)",
  [
    "เลือก test case ที่เหมาะกับหน้าตะกร้า ตอบทุก candidate และเพิ่ม C9 กับ AC-999 ด้วย",
    "AC: AC-001 เปลี่ยนจำนวนแล้วยอดรวมอัปเดต; AC-002 ลบสินค้าได้",
    "C1 [happy_path] กด + ที่สินค้าแรก → ยอดต่อรายการ = ราคา × 2",
    "C2 [boundary] กด - ที่จำนวน 1 → ปุ่ม - ถูก disabled",
    "C3 [happy_path] กด ลบสินค้า → รายการหายไป",
  ].join("\n"),
  buildSelectionSchema(["C1", "C2", "C3"], ["AC-001", "AC-002"]),
);
console.log("validated:", JSON.stringify(parseSelectionResponse(
  selectionRaw,
  [{ id: "C1", mandatory: false }, { id: "C2", mandatory: true }, { id: "C3", mandatory: false }],
  ["AC-001", "AC-002"],
)));

const fixture = path.resolve(process.cwd(), "src/services/ecommerce/__fixtures__/react-cart-web/cart-two-items.txt");
const inventory = buildInventory(readFileSync(fixture, "utf8"));
const elements = promptElements(inventory);
const exploratoryRaw = await chat(
  "exploratory (trap: asks for a coupon button that does not exist)",
  `หน้าเว็บ:\n${renderInventoryForPrompt(inventory, 4000)}\n\nเสนอ test case 1 ข้อที่ทดสอบปุ่ม "Apply coupon" (ถ้าไม่มีในหน้า ให้เลือก element ที่มีจริงแทน) ใช้เฉพาะ E-id จากหน้าเว็บ ตอบภาษาไทย`,
  buildExploratorySchema(elements, ["AC-001"]),
);
console.log("validated:", JSON.stringify(parseExploratoryResponse(exploratoryRaw, { elements, acIds: ["AC-001"] })));

const purposes = ["search", "filter", "sort", "quantity"] as const;
const purposeRaw = await chat(
  "purpose",
  "จำแนกหน้าที่ของ element ในหน้าสินค้า:\nE11 textbox \"ค้นหาสินค้าด้วยชื่อ...\"\nE12 combobox \"\" options=[ทุกหมวดหมู่ | อุปกรณ์อิเล็กทรอนิกส์]",
  buildPurposeSchema([...purposes], ["E11", "E12"]),
);
console.log("validated:", JSON.stringify([...parsePurposeResponse(purposeRaw, ["E11", "E12"], [...purposes]).purposes]));
