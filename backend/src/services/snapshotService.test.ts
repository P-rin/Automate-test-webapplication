import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";

import {
  buildBrowserSessionRestoreFunction,
  normalizePageUrl,
  pageUrlPattern,
  parseBrowserEvaluateResult,
  parseBrowserSessionState,
} from "./snapshotService.js";

test("parseBrowserEvaluateResult extracts JSON wrapped by the Playwright MCP result section", () => {
  const result = {
    content: [{
      type: "text",
      text: '### Result\n"[\\\"https://example.com/\\\",\\\"https://example.com/account\\\"]"\n### Ran Playwright code\n```js\npage.evaluate(...)\n```',
    }],
  };

  assert.deepEqual(parseBrowserEvaluateResult(result), [
    "https://example.com/",
    "https://example.com/account",
  ]);
});

test("parseBrowserEvaluateResult parses object results and ignores surrounding MCP text", () => {
  const result = {
    content: [{
      type: "text",
      text: '### Result\n{"localStorage":{"token":"value"},"sessionStorage":{},"cookie":"session=value"}\n### Ran Playwright code',
    }],
  };

  assert.deepEqual(parseBrowserEvaluateResult(result), {
    localStorage: { token: "value" },
    sessionStorage: {},
    cookie: "session=value",
  });
});

test("parseBrowserEvaluateResult rejects empty and non-JSON MCP responses", () => {
  assert.throws(() => parseBrowserEvaluateResult({ content: [] }), /empty browser_evaluate result/);
  assert.throws(() => parseBrowserEvaluateResult({
    content: [{ type: "text", text: "### Result\nundefined\n### Ran Playwright code" }],
  }), /non-JSON browser_evaluate result/);
});

test("parseBrowserSessionState reads state nested in MCP text content", () => {
  const result = {
    content: [{
      type: "text",
      text: '### Result\n"{\\\"localStorage\\\":{\\\"auth\\\":\\\"token\\\"},\\\"sessionStorage\\\":{\\\"step\\\":\\\"2\\\"},\\\"cookie\\\":\\\"sid=abc\\\"}"\n### Ran Playwright code',
    }],
  };

  assert.deepEqual(parseBrowserSessionState(result), {
    localStorage: { auth: "token" },
    sessionStorage: { step: "2" },
    cookie: "sid=abc",
  });
});

test("buildBrowserSessionRestoreFunction safely embeds state and restores every cookie", () => {
  const localStorage = new Map<string, string>();
  const sessionStorage = new Map<string, string>();
  const cookies: string[] = [];
  const document = Object.defineProperty({}, "cookie", {
    set: (cookie: string) => cookies.push(cookie),
  });
  const restore = runInNewContext(buildBrowserSessionRestoreFunction({
    localStorage: { token: 'quote " and newline\nvalue' },
    sessionStorage: { state: "2" },
    cookie: "sid=abc; theme=dark",
  }), {
    window: {
      localStorage: { setItem: (key: string, value: string) => localStorage.set(key, value) },
      sessionStorage: { setItem: (key: string, value: string) => sessionStorage.set(key, value) },
    },
    document,
  }) as () => void;

  restore();
  assert.equal(localStorage.get("token"), 'quote " and newline\nvalue');
  assert.equal(sessionStorage.get("state"), "2");
  assert.deepEqual(cookies, ["sid=abc", "theme=dark"]);
});

test("page URL normalization drops fragments and tracking parameters and groups dynamic IDs", () => {
  assert.equal(
    normalizePageUrl("https://example.com/product/1?utm_source=docs#details", "https://example.com/"),
    "https://example.com/product/1",
  );
  assert.equal(pageUrlPattern("https://example.com/product/1"), "https://example.com/product/:id");
  assert.equal(pageUrlPattern("https://example.com/product/2"), "https://example.com/product/:id");
});
