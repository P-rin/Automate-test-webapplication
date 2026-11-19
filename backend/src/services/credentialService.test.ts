import test from "node:test";
import assert from "node:assert/strict";

import { credentialsToTestEnv, normalizeLoginCredentials, redactSecret } from "./credentialService.js";
import { resolveLoginCredentials } from "./snapshotService.js";

test("normalizeLoginCredentials requires both values and trims only the username", () => {
  assert.deepEqual(normalizeLoginCredentials("  standard_user ", " p@ss "), { username: "standard_user", password: " p@ss " });
  assert.equal(normalizeLoginCredentials("standard_user", ""), null);
  assert.equal(normalizeLoginCredentials("   ", "secret"), null);
  assert.equal(normalizeLoginCredentials(undefined, undefined), null);
  assert.equal(normalizeLoginCredentials(["a"], "secret"), null);
  assert.throws(() => normalizeLoginCredentials("u", "x".repeat(513)), /at most 512 characters/);
});

test("credentialsToTestEnv maps credentials to the variables generated scripts read", () => {
  assert.deepEqual(
    credentialsToTestEnv({ username: "standard_user", password: "secret_sauce" }),
    { TEST_EMAIL: "standard_user", TEST_PASSWORD: "secret_sauce" },
  );
  assert.deepEqual(credentialsToTestEnv(null), {});
});

test("redactSecret removes every occurrence of the password", () => {
  const credentials = { username: "standard_user", password: "secret_sauce" };
  assert.equal(
    redactSecret("fill(\"secret_sauce\") failed; retry secret_sauce", credentials),
    "fill(\"********\") failed; retry ********",
  );
  assert.equal(redactSecret("no secret here", credentials), "no secret here");
  assert.equal(redactSecret("unchanged", null), "unchanged");
});

test("resolveLoginCredentials prefers form credentials over the specification", () => {
  const specification = "User = spec_user\nPassword = spec_pass";
  assert.deepEqual(
    resolveLoginCredentials(specification, { username: "form_user", password: "form_pass" }),
    { identifier: "form_user", password: "form_pass" },
  );
  assert.deepEqual(resolveLoginCredentials(specification, null), { identifier: "spec_user", password: "spec_pass" });
  assert.equal(resolveLoginCredentials("", null), null);
});
