import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";

import {
  appendElementAttributeSection,
  COLLECT_ELEMENT_ATTRS_FUNCTION,
  buildBrowserSessionRestoreFunction,
  formatTestIdSection,
  insertTestIdSection,
  isBlockedDiscoveryAction,
  normalizePageUrl,
  withIsolatedBrowserProfile,
  pageUrlPattern,
  disambiguatePageTitles,
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
  // Keys added after the state was captured (e.g. a cart filled by an explored click).
  const localStorage = new Map<string, string>([["cart-contents", "[4]"]]);
  const sessionStorage = new Map<string, string>([["draft", "x"]]);
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
      localStorage: { setItem: (key: string, value: string) => localStorage.set(key, value), clear: () => localStorage.clear() },
      sessionStorage: { setItem: (key: string, value: string) => sessionStorage.set(key, value), clear: () => sessionStorage.clear() },
    },
    document,
  }) as () => void;

  restore();
  assert.deepEqual([...localStorage.entries()], [["token", 'quote " and newline\nvalue']]);
  assert.deepEqual([...sessionStorage.entries()], [["state", "2"]]);
  assert.deepEqual(cookies, ["sid=abc", "theme=dark"]);
});

test("MCP browsers use an isolated profile unless a profile is chosen explicitly", () => {
  assert.deepEqual(withIsolatedBrowserProfile(["--headless"]), ["--headless", "--isolated"]);
  assert.deepEqual(withIsolatedBrowserProfile(["--headless", "--isolated"]), ["--headless", "--isolated"]);
  assert.deepEqual(withIsolatedBrowserProfile(["--user-data-dir", "C:/profile"]), ["--user-data-dir", "C:/profile"]);
  assert.deepEqual(withIsolatedBrowserProfile(["--user-data-dir=C:/profile"]), ["--user-data-dir=C:/profile"]);
});

test("discovery never clicks controls that change data or end the session", () => {
  for (const name of [
    "Add to cart", "add to cart", "Remove", "Save changes", "Place order", "Checkout", "Logout",
    "เพิ่มลงตะกร้า", "บันทึก", "ลบรายการ", "สั่งซื้อ", "ยืนยันการชำระเงิน",
  ]) {
    assert.equal(isBlockedDiscoveryAction(name), true, name);
  }
  // Whole-word matching: these only contain a blocked term inside another word.
  for (const name of ["Addresses", "Facebook", "Feedback", "Posts", "View details for Sauce Labs Backpack", "Docs", "เปิดเมนู"]) {
    assert.equal(isBlockedDiscoveryAction(name), false, name);
  }
});

test("page URL normalization drops fragments and tracking parameters and groups dynamic IDs", () => {
  assert.equal(
    normalizePageUrl("https://example.com/product/1?utm_source=docs#details", "https://example.com/"),
    "https://example.com/product/1",
  );
  assert.equal(pageUrlPattern("https://example.com/product/1"), "https://example.com/product/:id");
  assert.equal(pageUrlPattern("https://example.com/product/2"), "https://example.com/product/:id");
  assert.equal(
    pageUrlPattern("https://www.saucedemo.com/inventory-item.html?id=4"),
    "https://www.saucedemo.com/inventory-item.html?id=:id",
  );
  assert.equal(
    pageUrlPattern("https://example.com/search?q=shoes&page=2"),
    "https://example.com/search?page=:id&q=shoes",
  );
});

test("disambiguatePageTitles appends the path only to repeated titles", () => {
  const page = (title: string, urlPattern: string) => ({
    pageId: urlPattern, title, urlPattern, sampleUrl: urlPattern, depth: 0, requiresLogin: false, suggestedAcIds: [],
  });
  const titles = disambiguatePageTitles([
    page("Swag Labs", "https://www.saucedemo.com/inventory.html"),
    page("Swag Labs", "https://www.saucedemo.com/inventory-item.html?id=:id"),
    page("Docs", "https://www.saucedemo.com/docs"),
  ]).map((item) => item.title);
  assert.deepEqual(titles, [
    "Swag Labs (/inventory.html)",
    "Swag Labs (/inventory-item.html?id=:id)",
    "Docs",
  ]);
});

test("test IDs are listed before the YAML tree so prompt truncation keeps them", () => {
  const section = formatTestIdSection([
    { attr: "data-test", value: "inventory-item", tag: "div", count: 6, text: "Sauce Labs Backpack" },
    { attr: "id", value: "user-name", tag: "input", count: 1, text: "" },
  ]);
  assert.match(section, /^### Test IDs\n/);
  assert.match(section, /- \[data-test="inventory-item"\] <div> x6 "Sauce Labs Backpack"/);
  assert.match(section, /- \[id="user-name"\] <input>\n/);
  assert.equal(formatTestIdSection([]), "");

  const snapshot = "### Page\n- Page URL: https://example.com/\n### Snapshot\n```yaml\n- button \"Go\" [ref=e1]\n```";
  const merged = insertTestIdSection(snapshot, section);
  assert.ok(merged.indexOf("### Test IDs") < merged.indexOf("### Snapshot"));
  assert.ok(merged.includes("- Page URL: https://example.com/"));
  assert.ok(merged.endsWith("```"));
  assert.equal(insertTestIdSection(snapshot, ""), snapshot);
});

test("test ID section stays within budget and keeps repeated containers and controls first", () => {
  const entries = [
    ...Array.from({ length: 80 }, (_, i) => ({ attr: "data-test", value: `item-${i}-img`, tag: "img", count: 1, text: "" })),
    { attr: "data-test", value: "username", tag: "input", count: 1, text: "Username" },
    { attr: "data-test", value: "inventory-item", tag: "div", count: 6, text: "Sauce Labs Backpack" },
  ];
  const section = formatTestIdSection(entries);
  assert.ok(section.length <= 1600, String(section.length));
  const lines = section.split("\n");
  assert.match(lines[2], /inventory-item/);
  assert.match(lines[3], /username/);
  assert.match(section, /more omitted\)/);
});

/** Minimal DOM stand-in for COLLECT_ELEMENT_ATTRS_FUNCTION (only what the function reads). */
const fakeElement = (tag: string, attributes: Record<string, string>, extra: Record<string, unknown> = {}) => ({
  nodeType: 1,
  tagName: tag.toUpperCase(),
  id: attributes.id ?? "",
  childNodes: [] as unknown[],
  labels: [] as unknown[],
  getAttribute: (name: string) => attributes[name] ?? null,
  getClientRects: () => [{}],
  closest: () => null,
  ...extra,
});

test("COLLECT_ELEMENT_ATTRS_FUNCTION reports implicit roles, names and form attributes without touching the page", () => {
  const text = (value: string) => ({ nodeType: 3, textContent: value });
  const image = fakeElement("img", { alt: "Backpack" });
  const label = { childNodes: [text("Quantity")] };
  const elements = [
    fakeElement("input", { type: "number", min: "1", max: "10", name: "qty" }, { labels: [label], required: true }),
    fakeElement("input", { type: "search", placeholder: "Search products" }),
    fakeElement("textarea", { placeholder: "Write a review", maxlength: "500" }),
    fakeElement("a", { href: "/p/1", "data-test": "item-link" }, { childNodes: [image, text(" -10%")] }),
    fakeElement("button", { "aria-label": "Add to cart", disabled: "" }, { disabled: true }),
    fakeElement("button", { type: "button" }, { getClientRects: () => [] }),
  ];
  const result = runInNewContext(`(${COLLECT_ELEMENT_ATTRS_FUNCTION})()`, {
    document: { querySelectorAll: () => elements, getElementById: () => null },
  }) as string;
  assert.deepEqual(JSON.parse(result), [
    { role: "spinbutton", name: "Quantity", tag: "input", type: "number", htmlName: "qty", required: true, min: "1", max: "10" },
    { role: "searchbox", name: "Search products", tag: "input", type: "search", placeholder: "Search products" },
    { role: "textbox", name: "Write a review", tag: "textarea", placeholder: "Write a review", maxLength: 500 },
    { role: "link", name: "Backpack -10%", tag: "a", testId: "item-link" },
    { role: "button", name: "Add to cart", tag: "button", disabled: true },
  ], "invisible elements are skipped");
  assert.doesNotMatch(COLLECT_ELEMENT_ATTRS_FUNCTION, /\.(click|focus|submit|dispatchEvent|setAttribute|remove)\(/, "read-only");
});

test("element attributes are appended after the snapshot tree as a JSON section", () => {
  const snapshot = "### Page\n- Page URL: https://shop.example/\n### Snapshot\n```yaml\n- button \"Buy\" [ref=e1]\n```";
  assert.equal(appendElementAttributeSection(snapshot, []), snapshot);
  const withAttributes = appendElementAttributeSection(snapshot, [{ role: "button", name: "Buy", tag: "button" }]);
  assert.ok(withAttributes.startsWith(snapshot));
  assert.match(withAttributes, /### Element Attributes\n```json\n\[\{"role":"button","name":"Buy","tag":"button"\}\]\n```\n$/);
});
