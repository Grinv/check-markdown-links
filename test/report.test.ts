import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSummary, sortResults, toJson, printReport, type LinkResult, type ReportData } from "../src/report.ts";

function makeResult(overrides: Partial<LinkResult>): LinkResult {
  return {
    file: "a.md",
    line: 1,
    column: 1,
    kind: "inline",
    text: "t",
    rawUrl: "./x.md",
    type: "local",
    target: "/abs/x.md",
    anchor: null,
    status: "ok",
    httpStatus: null,
    reason: null,
    ...overrides,
  };
}

test("computeSummary tallies each status", () => {
  const results = [
    makeResult({ status: "ok" }),
    makeResult({ status: "ok" }),
    makeResult({ status: "broken" }),
    makeResult({ status: "warning" }),
    makeResult({ status: "skipped" }),
  ];
  assert.deepEqual(computeSummary(results), { ok: 2, broken: 1, warning: 1, skipped: 1 });
});

test("sortResults orders by file, then line, then column", () => {
  const results = [
    makeResult({ file: "b.md", line: 1, column: 1 }),
    makeResult({ file: "a.md", line: 2, column: 1 }),
    makeResult({ file: "a.md", line: 1, column: 5 }),
    makeResult({ file: "a.md", line: 1, column: 1 }),
  ];
  const sorted = sortResults(results);
  assert.deepEqual(
    sorted.map((r) => `${r.file}:${r.line}:${r.column}`),
    ["a.md:1:1", "a.md:1:5", "a.md:2:1", "b.md:1:1"],
  );
});

function makeReportData(results: LinkResult[]): ReportData {
  return {
    root: "/abs/path",
    scannedFiles: 12,
    totalLinks: results.length,
    uniqueExternalUrls: 0,
    durationMs: 42,
    results,
    warnings: [],
  };
}

test("JSON output parses and contains all documented keys", () => {
  const data = makeReportData([makeResult({ status: "broken", reason: "NOT_FOUND" })]);
  const json = toJson(data);
  const parsed = JSON.parse(json);
  assert.deepEqual(Object.keys(parsed).sort(), [
    "durationMs",
    "results",
    "root",
    "scannedFiles",
    "summary",
    "totalLinks",
    "uniqueExternalUrls",
    "warnings",
  ].sort());
  assert.equal(parsed.summary.broken, 1);
});

test("JSON output never contains ANSI escape codes", () => {
  const data = makeReportData([
    makeResult({ status: "broken", reason: "NOT_FOUND" }),
    makeResult({ status: "ok" }),
  ]);
  const json = toJson(data);
  assert.ok(!json.includes("\x1b["));
});

test("results in the JSON include ok and skipped entries too", () => {
  const data = makeReportData([
    makeResult({ status: "ok" }),
    makeResult({ status: "skipped", type: "skipped" }),
  ]);
  const parsed = JSON.parse(toJson(data));
  assert.equal(parsed.results.length, 2);
});

function captureStdout(fn: () => void): string {
  const original = process.stdout.write.bind(process.stdout);
  let captured = "";
  (process.stdout as any).write = (chunk: string) => {
    captured += chunk;
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return captured;
}

test("text-mode table lists only broken rows, not ok/warning/skipped", () => {
  const data = makeReportData([
    makeResult({ line: 1, rawUrl: "./ok.md", status: "ok" }),
    makeResult({ line: 2, rawUrl: "./bad.md", status: "broken", reason: "NOT_FOUND" }),
    makeResult({ line: 3, rawUrl: "http://x.com", status: "warning", reason: "RATE_LIMITED" }),
    makeResult({ line: 4, rawUrl: "mailto:a@b.com", status: "skipped" }),
  ]);
  const output = captureStdout(() => printReport(data, { color: false }));
  assert.match(output, /bad\.md/);
  assert.match(output, /NOT_FOUND/);
  assert.doesNotMatch(output, /ok\.md/);
  assert.doesNotMatch(output, /x\.com/);
  assert.doesNotMatch(output, /a@b\.com/);
});
