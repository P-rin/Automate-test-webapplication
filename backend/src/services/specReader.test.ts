import test from "node:test";
import assert from "node:assert/strict";
import type { Express } from "express";

import { readSpecFiles } from "./specReader.js";

test("readSpecFiles returns file contents without adding filenames", () => {
  const result = readSpecFiles([{
    originalname: "Context ภาษาไทย.md",
    buffer: Buffer.from("ข้อกำหนดของระบบ", "utf-8"),
  } as Express.Multer.File]);

  assert.equal(result.combinedText, "ข้อกำหนดของระบบ");
  assert.deepEqual(result.fileNames, ["Context ภาษาไทย.md"]);
});