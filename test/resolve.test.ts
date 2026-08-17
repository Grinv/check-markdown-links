import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { classify } from "../src/resolve.ts";

const rootDir = "/root";
const sourceFile = "/root/docs/a.md";

test("relative link without prefix resolves relative to the source file's dir", () => {
  const result = classify("setup.md", { sourceFile, rootDir });
  assert.equal(result.type, "local");
  assert.equal(result.target, path.join(rootDir, "docs", "setup.md"));
});

test("./ and ../ relative links resolve relative to source file's dir", () => {
  assert.equal(
    classify("./setup.md", { sourceFile, rootDir }).target,
    path.join(rootDir, "docs", "setup.md"),
  );
  assert.equal(
    classify("../out.md", { sourceFile, rootDir }).target,
    path.join(rootDir, "out.md"),
  );
});

test("going outside rootDir via .. is resolved, not an error", () => {
  const result = classify("../../out.md", { sourceFile, rootDir });
  assert.equal(result.type, "local");
  assert.equal(result.target, path.resolve(rootDir, "..", "out.md"));
});

test("root-relative link resolves against rootDir, not filesystem root", () => {
  const result = classify("/docs/x.md", { sourceFile, rootDir });
  assert.equal(result.type, "local");
  assert.equal(result.target, path.join(rootDir, "docs", "x.md"));
});

test("same relative url from files at different depths resolves differently", () => {
  const shallow = classify("b.md", { sourceFile: "/root/a.md", rootDir });
  const deep = classify("b.md", { sourceFile: "/root/nested/deep/a.md", rootDir });
  assert.notEqual(shallow.target, deep.target);
  assert.equal(shallow.target, path.join(rootDir, "b.md"));
  assert.equal(deep.target, path.join(rootDir, "nested", "deep", "b.md"));
});

test("file:// URL resolves to an absolute path via fileURLToPath", () => {
  const result = classify("file:///abs/path.md", { sourceFile, rootDir });
  assert.equal(result.type, "local");
  assert.equal(result.target, "/abs/path.md");
});

test("link to a directory is classified as local (existence is checked elsewhere)", () => {
  const result = classify("./dir", { sourceFile, rootDir });
  assert.equal(result.type, "local");
});

test("percent-encoded space in filename is decoded", () => {
  const result = classify("./my%20doc.md", { sourceFile, rootDir });
  assert.equal(result.target, path.join(rootDir, "docs", "my doc.md"));
});

test("fragment is stripped before checking the local path", () => {
  const result = classify("./a.md#section", { sourceFile, rootDir });
  assert.equal(result.target, path.join(rootDir, "docs", "a.md"));
});

test("query string is stripped before checking the local path", () => {
  const result = classify("./a.md?v=1", { sourceFile, rootDir });
  assert.equal(result.target, path.join(rootDir, "docs", "a.md"));
});

test("malformed percent-encoding does not throw and keeps the raw string", () => {
  const result = classify("./100%.md", { sourceFile, rootDir });
  assert.equal(result.type, "local");
  assert.equal(result.target, path.join(rootDir, "docs", "100%.md"));
});

test("empty url is invalid/EMPTY_URL", () => {
  const result = classify("", { sourceFile, rootDir });
  assert.deepEqual(result, { type: "invalid", target: null, reason: "EMPTY_URL", anchor: null });
});

test("whitespace-only url is invalid/EMPTY_URL", () => {
  const result = classify("   ", { sourceFile, rootDir });
  assert.equal(result.type, "invalid");
  assert.equal(result.reason, "EMPTY_URL");
});

test("query-only url resolves to an empty path and is invalid/EMPTY_URL", () => {
  const result = classify("?x=1", { sourceFile, rootDir });
  assert.equal(result.type, "invalid");
  assert.equal(result.reason, "EMPTY_URL");
});

test("null rawUrl (undefined reference) is invalid/UNDEFINED_REFERENCE", () => {
  const result = classify(null, { sourceFile, rootDir });
  assert.deepEqual(result, { type: "invalid", target: null, reason: "UNDEFINED_REFERENCE", anchor: null });
});

test("anchor-only url resolves to the source file itself, with the anchor set", () => {
  const result = classify("#anchor", { sourceFile, rootDir });
  assert.deepEqual(result, { type: "local", target: sourceFile, reason: null, anchor: "anchor" });
});

test("a bare # (top of document) has an empty-string anchor, always valid", () => {
  const result = classify("#", { sourceFile, rootDir });
  assert.deepEqual(result, { type: "local", target: sourceFile, reason: null, anchor: "" });
});

test("anchor on a relative local link is captured separately from the path", () => {
  const result = classify("./b.md#some-section", { sourceFile, rootDir });
  assert.equal(result.type, "local");
  assert.equal(result.target, path.join(rootDir, "docs", "b.md"));
  assert.equal(result.anchor, "some-section");
});

test("anchor on a file:// link is captured", () => {
  const result = classify("file:///abs/path.md#foo", { sourceFile, rootDir });
  assert.equal(result.target, "/abs/path.md");
  assert.equal(result.anchor, "foo");
});

test("mailto/tel/data schemes are skipped/UNSUPPORTED_SCHEME", () => {
  for (const url of ["mailto:a@b.com", "tel:+123", "data:text/plain;base64,abc"]) {
    const result = classify(url, { sourceFile, rootDir });
    assert.deepEqual(
      result,
      { type: "skipped", target: null, reason: "UNSUPPORTED_SCHEME", anchor: null },
      url,
    );
  }
});

test("http/https schemes classify as external with fragment dropped, query kept", () => {
  const withFragment = classify("http://example.com/page?x=1#frag", { sourceFile, rootDir });
  assert.equal(withFragment.type, "external");
  assert.equal(withFragment.target, "http://example.com/page?x=1");

  const httpsResult = classify("https://example.com/", { sourceFile, rootDir });
  assert.equal(httpsResult.type, "external");
});

test("protocol-relative URL is external with https prepended", () => {
  const result = classify("//example.com/path", { sourceFile, rootDir });
  assert.deepEqual(result, {
    type: "external",
    target: "https://example.com/path",
    reason: null,
    anchor: null,
  });
});
