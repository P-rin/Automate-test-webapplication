import test from "node:test";
import assert from "node:assert/strict";

import { countResultsRecursive, parsePlaywrightReport } from "./executionReport.js";

test("counts passed, failed, flaky, and skipped tests by test-level outcome", () => {
  const report = {
    stats: { duration: 2450 },
    suites: [
      {
        specs: [
          { tests: [{ results: [{ status: "passed", duration: 300 }] }] },
          {
            tests: [{
              results: [{
                status: "failed",
                errors: [{ message: "assertion failed" }],
              }],
            }],
          },
          {
            tests: [{
              outcome: "flaky",
              results: [
                { status: "failed", errors: [{ message: "first attempt failed" }] },
                { status: "passed" },
              ],
            }],
          },
          { tests: [{ outcome: "skipped", results: [{ status: "skipped" }] }] },
        ],
        suites: [
          {
            specs: [
              { tests: [{ results: [{ status: "passed" }] }] },
            ],
          },
        ],
      },
    ],
  };

  const parsed = parsePlaywrightReport(report);
  assert.equal(parsed.passCount, 2);
  assert.equal(parsed.failCount, 1);
  assert.equal(parsed.flakyCount, 1);
  assert.equal(parsed.skippedCount, 1);
  assert.equal(parsed.duration, 2450);
  assert.deepEqual(parsed.errors, ["assertion failed", "first attempt failed"]);
  assert.deepEqual(parsed.outcomes, ["passed", "failed", "flaky", "skipped", "passed"]);
});

test("counts a retry-passed test as flaky even when the JSON reporter omits outcome", () => {
  const result = countResultsRecursive({
    specs: [{
      tests: [{
        results: [
          { status: "timedOut", errors: [{ stack: "timeout stack" }] },
          { status: "passed" },
        ],
      }],
    }],
  });

  assert.equal(result.passCount, 0);
  assert.equal(result.failCount, 0);
  assert.equal(result.flakyCount, 1);
  assert.equal(result.skippedCount, 0);
  assert.deepEqual(result.errors, ["timeout stack"]);
});
