import test from "node:test";
import assert from "node:assert/strict";
import { formatCoveredCase, PlanCoverageRegistry } from "./planDedup.js";

const plan = (
  title: string,
  targetElement: string,
  inputVariant: string,
  steps: string[] = ["เปิดหน้าแรก", `คลิก '${targetElement}'`],
  expectedResult = "ผลลัพธ์แสดงบนหน้าจอ",
) => ({ title, description: title, testSteps: steps, expectedResult, targetElement, inputVariant });

test("findDuplicate catches a reworded case on the same element and start state", () => {
  const registry = new PlanCoverageRegistry();
  registry.add(plan("ตรวจสอบการสลับธีมสีจากโหมดสว่างเป็นมืด (Dark Mode)", "Switch between dark and light mode", "light -> dark"));

  assert.equal(
    registry.findDuplicate(plan("ตรวจสอบการเปลี่ยนโหมดสี (Dark/Light Mode)", "Switch between dark and light mode (currently light mode)", "light mode -> dark mode")),
    "ตรวจสอบการสลับธีมสีจากโหมดสว่างเป็นมืด (Dark Mode)",
  );
});

test("findDuplicate keeps similar-looking cases on different elements", () => {
  const registry = new PlanCoverageRegistry();
  registry.add(plan("ทดสอบลิงก์ 'Discord server' ในแถบเมนูหลัก", "Discord server", ""));

  assert.equal(registry.findDuplicate(plan("ทดสอบลิงก์ 'GitHub repository' ในแถบเมนูหลัก", "GitHub repository", "")), undefined);
  assert.equal(registry.findDuplicate(plan("ทดสอบลิงก์ 'Java'", "Java", "")), undefined);
  registry.add(plan("ทดสอบลิงก์ 'Java'", "Java", ""));
  assert.equal(registry.findDuplicate(plan("ทดสอบลิงก์ 'JavaScript'", "JavaScript", "")), undefined);
});

test("findDuplicate keeps different input partitions on the same element", () => {
  const registry = new PlanCoverageRegistry();
  registry.add(plan("กรอกจำนวนสินค้าเป็น 0", "Quantity", "quantity=0"));

  assert.equal(registry.findDuplicate(plan("กรอกจำนวนสินค้าติดลบ", "Quantity", "quantity=-1")), undefined);
  assert.equal(registry.findDuplicate(plan("กรอกจำนวนสินค้าเกินสต็อก", "Quantity", "quantity above stock")), undefined);
});

test("findDuplicate falls back to identical titles and near-verbatim content without target elements", () => {
  const registry = new PlanCoverageRegistry();
  registry.add({ title: "Distinct behavior 1", description: "Verify behavior 1", testSteps: ["Exercise behavior 1"], expectedResult: "Behavior 1 is correct" });

  assert.equal(registry.findDuplicate({ title: "distinct  BEHAVIOR 1", description: "x", testSteps: [], expectedResult: "y" }), "Distinct behavior 1");
  assert.equal(registry.findDuplicate({ title: "Distinct behavior 2", description: "Verify behavior 2", testSteps: ["Exercise behavior 2"], expectedResult: "Behavior 2 is correct" }), undefined);
});

test("findDuplicate with titleOnly ignores semantic matches", () => {
  const registry = new PlanCoverageRegistry();
  registry.add(plan("Get started ไปหน้า Intro", "Get started", ""));

  assert.equal(registry.findDuplicate(plan("Get started ตาม AC-001", "Get started", ""), { titleOnly: true }), undefined);
  assert.equal(registry.findDuplicate(plan("Get started ตาม AC-001", "Get started", "")), "Get started ไปหน้า Intro");
});

test("a repeatedly proposed duplicate moves its match to the most-recent end of the covered list", () => {
  const registry = new PlanCoverageRegistry();
  registry.add(plan("Theme toggle", "Switch between dark and light mode", ""));
  registry.add(plan("Discord link", "Discord server", ""));

  registry.findDuplicate(plan("Theme toggle again", "Switch between dark and light mode", ""));

  assert.deepEqual(registry.coveredCases().map((item) => item.title), ["Discord link", "Theme toggle"]);
});

test("formatCoveredCase renders a compact title with its dedup key", () => {
  assert.equal(formatCoveredCase({ title: "A", targetElement: "Login", inputVariant: "empty email" }), "- A [Login | empty email]");
  assert.equal(formatCoveredCase({ title: "B", description: "ignored" }), "- B");
  assert.ok(formatCoveredCase({ title: "x".repeat(300) }).length <= 122);
});
