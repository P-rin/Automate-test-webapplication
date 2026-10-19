import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRetryTestPlan,
  buildPlannedGenerationCase,
  decodeGenerationSnapshot,
  encodeGenerationSnapshot,
  findSnapshotForPage,
} from "./generationJobService.js";

test("generation snapshots round-trip through compressed storage", () => {
  const snapshot = "### Snapshot\n```yaml\n- heading: Account settings\n- button: Save\n```";
  const compressedSnapshot = encodeGenerationSnapshot(snapshot);

  assert.notEqual(compressedSnapshot, snapshot);
  assert.equal(decodeGenerationSnapshot({ encoding: "gzip-base64", compressedSnapshot }), snapshot);
});

test("decodeGenerationSnapshot supports uncompressed legacy snapshot records", () => {
  assert.equal(decodeGenerationSnapshot({ snapshot: "legacy snapshot" }), "legacy snapshot");
});

test("findSnapshotForPage matches the stored page title without case sensitivity", () => {
  const snapshots = [
    { title: "Landing page", snapshot: "landing snapshot" },
    { title: "Route: https://example.com/account", snapshot: "account snapshot" },
  ];

  assert.deepEqual(findSnapshotForPage(snapshots, " route: HTTPS://EXAMPLE.COM/account "), snapshots[1]);
  assert.equal(findSnapshotForPage(snapshots, "Route: /missing"), undefined);
});

test("buildRetryTestPlan restores the persisted plan and original sequence id", () => {
  const plan = buildRetryTestPlan({
    sequence: 4,
    title: "Update account details",
    description: "Confirm profile edits are saved",
    type: "API",
    testSteps: ["Open profile", "Update the name"],
    expectedResult: "The updated name is displayed",
  });

  assert.deepEqual(plan, {
    id: "TC-004",
    title: "Update account details",
    description: "Confirm profile edits are saved",
    type: "API",
    testSteps: ["Open profile", "Update the name"],
    expectedResult: "The updated name is displayed",
  });
});

test("buildRetryTestPlan rejects incomplete persisted plans", () => {
  assert.throws(() => buildRetryTestPlan({ sequence: 1, title: "Incomplete" }), /stored Test plan is incomplete/);
});

test("buildPlannedGenerationCase persists the full plan and snapshot reference without a script", () => {
  const generationCase = buildPlannedGenerationCase({
    id: "planner-id",
    title: "Account form rejects an invalid email",
    description: "Verify email validation on the account form",
    type: "UI",
    testSteps: ["Open account form", "Enter an invalid email", "Submit"],
    expectedResult: "An email validation message is shown",
  }, 2, "Route: https://example.com/account", "snapshot-00003");

  assert.deepEqual(generationCase, {
    id: "case-00002",
    sequence: 2,
    title: "Account form rejects an invalid email",
    description: "Verify email validation on the account form",
    type: "UI",
    testSteps: ["Open account form", "Enter an invalid email", "Submit"],
    expectedResult: "An email validation message is shown",
    page: "Route: https://example.com/account",
    snapshotId: "snapshot-00003",
    status: "planned",
  });
});