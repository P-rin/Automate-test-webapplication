import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const originalCwd = process.cwd();

test("persists GitHub sessions to disk so a restarted backend can reuse an existing session token", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "github-session-test-"));
  fs.mkdirSync(path.join(tempRoot, "runtime"), { recursive: true });

  process.chdir(tempRoot);

  try {
    const { createGithubSession, getGithubSession } = await import("./githubAuthService.js");

    const session = createGithubSession("gh-test-token", {
      id: 1,
      login: "octocat",
      name: "Octo Cat",
      avatarUrl: "https://example.com/octocat.png",
      email: "octocat@example.com",
    }, {
      active: true,
      reason: "ok",
    });

    const persistedPath = path.join(tempRoot, "runtime", "sessions.json");
    assert.ok(fs.existsSync(persistedPath), "session persistence file should be created");

    const raw = fs.readFileSync(persistedPath, "utf8");
    assert.match(raw, new RegExp(session.sessionToken));

    const reloaded = getGithubSession(session.sessionToken);
    assert.ok(reloaded, "the session should be reloadable from storage");
    assert.equal(reloaded?.sessionToken, session.sessionToken);
  } finally {
    process.chdir(originalCwd);
  }
});
