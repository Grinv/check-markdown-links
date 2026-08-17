import { test } from "node:test";
import assert from "node:assert/strict";
import { extractLinks, extractHeadingAnchors, slugifyHeading } from "../src/extract.ts";

test("extracts a basic inline link", () => {
  const links = extractLinks("[text](./setup.md)", "f.md");
  assert.equal(links.length, 1);
  assert.deepEqual(links[0], {
    file: "f.md",
    line: 1,
    column: 1,
    text: "text",
    rawUrl: "./setup.md",
    kind: "inline",
  });
});

test("extracts an image link", () => {
  const links = extractLinks("![alt](img.png)", "f.md");
  assert.equal(links.length, 1);
  assert.equal(links[0].kind, "image");
  assert.equal(links[0].text, "alt");
  assert.equal(links[0].rawUrl, "img.png");
});

test("strips title in double-quote form", () => {
  const links = extractLinks('[t](url "title")', "f.md");
  assert.equal(links[0].rawUrl, "url");
});

test("strips title in single-quote form", () => {
  const links = extractLinks("[t](url 'title')", "f.md");
  assert.equal(links[0].rawUrl, "url");
});

test("strips title in parenthesized form", () => {
  const links = extractLinks("[t](url (title))", "f.md");
  assert.equal(links[0].rawUrl, "url");
});

test("strips angle brackets around destination with spaces", () => {
  const links = extractLinks("[t](<url with spaces>)", "f.md");
  assert.equal(links[0].rawUrl, "url with spaces");
});

test("handles nested balanced parens in destination", () => {
  const links = extractLinks("[t](a(b)c.md)", "f.md");
  assert.equal(links[0].rawUrl, "a(b)c.md");
});

test("does not recognize a link with an unclosed paren", () => {
  const links = extractLinks("[t](unclosed.md", "f.md");
  assert.equal(links.length, 0);
});

test("reference-style link with explicit id", () => {
  const content = "[text][ref]\n\n[ref]: ./target.md\n";
  const links = extractLinks(content, "f.md");
  assert.equal(links.length, 1);
  assert.equal(links[0].kind, "reference");
  assert.equal(links[0].rawUrl, "./target.md");
  assert.equal(links[0].line, 1);
});

test("collapsed reference-style link [text][]", () => {
  const content = "[Text][]\n\n[text]: ./target.md\n";
  const links = extractLinks(content, "f.md");
  assert.equal(links.length, 1);
  assert.equal(links[0].rawUrl, "./target.md");
});

test("reference definition with indentation up to 3 spaces", () => {
  const content = "[t][ref]\n\n   [ref]: ./x.md\n";
  const links = extractLinks(content, "f.md");
  assert.equal(links[0].rawUrl, "./x.md");
});

test("undefined reference produces null rawUrl", () => {
  const links = extractLinks("[t][missing]", "f.md");
  assert.equal(links.length, 1);
  assert.equal(links[0].kind, "reference");
  assert.equal(links[0].rawUrl, null);
});

test("autolink is recognized", () => {
  const links = extractLinks("see <https://example.com> here", "f.md");
  assert.equal(links.length, 1);
  assert.equal(links[0].kind, "autolink");
  assert.equal(links[0].rawUrl, "https://example.com");
});

test("bare file:/// link outside brackets is recognized", () => {
  const links = extractLinks("see file:///abs/path.md here", "f.md");
  assert.equal(links.length, 1);
  assert.equal(links[0].kind, "bare");
  assert.equal(links[0].rawUrl, "file:///abs/path.md");
});

test("links inside fenced ``` blocks are not extracted", () => {
  const content = "text\n```\n[t](a.md)\n```\nmore\n";
  const links = extractLinks(content, "f.md");
  assert.equal(links.length, 0);
});

test("links inside fenced ~~~ blocks are not extracted", () => {
  const content = "text\n~~~\n[t](a.md)\n~~~\nmore\n";
  const links = extractLinks(content, "f.md");
  assert.equal(links.length, 0);
});

test("unclosed fenced block swallows the rest of the file", () => {
  const content = "```\n[t](a.md)\nmore [u](b.md)\n";
  const links = extractLinks(content, "f.md");
  assert.equal(links.length, 0);
});

test("link inside inline code span is not extracted", () => {
  const content = "`[not](a.md)` but [real](b.md)";
  const links = extractLinks(content, "f.md");
  assert.equal(links.length, 1);
  assert.equal(links[0].rawUrl, "b.md");
});

test("multi-backtick code span delimiters are respected", () => {
  const content = "``code with `nested` backtick [not](a.md)``";
  const links = extractLinks(content, "f.md");
  assert.equal(links.length, 0);
});

test("escaped brackets do not form a link", () => {
  const links = extractLinks("\\[not a link\\](x.md)", "f.md");
  assert.equal(links.length, 0);
});

test("line and column are 1-based and accurate on a multi-line fixture", () => {
  const content = "line one\nline two [link](a.md)\nline three\n";
  const links = extractLinks(content, "f.md");
  assert.equal(links.length, 1);
  assert.equal(links[0].line, 2);
  assert.equal(links[0].column, 10);
});

test("two links on the same line get distinct columns", () => {
  const content = "start [a](a.md) middle [b](b.md) end";
  const links = extractLinks(content, "f.md");
  assert.equal(links.length, 2);
  assert.equal(links[0].column, 7);
  assert.equal(links[1].column, 24);
  assert.notEqual(links[0].column, links[1].column);
});

test("HTML links are not recognized (out of scope)", () => {
  const links = extractLinks('<a href="a.md">text</a>', "f.md");
  assert.equal(links.length, 0);
});

test("slugifyHeading approximates GitHub's slug algorithm", () => {
  assert.equal(slugifyHeading("Ключевые принципы"), "ключевые-принципы");
  assert.equal(slugifyHeading("Getting Started!"), "getting-started");
  assert.equal(slugifyHeading("DELETE /spaces/{space_id}"), "delete-spacesspace_id");
  assert.equal(slugifyHeading("`code` and **bold** text"), "code-and-bold-text");
});

test("extractHeadingAnchors collects slugs from ATX headings", () => {
  const content = "# Title\n\n## Getting Started\n\ntext\n\n### Sub Section\n";
  const anchors = extractHeadingAnchors(content);
  assert.deepEqual([...anchors].sort(), ["getting-started", "sub-section", "title"]);
});

test("extractHeadingAnchors appends -1, -2 for duplicate headings", () => {
  const content = "# Intro\n## Intro\n### Intro\n";
  const anchors = extractHeadingAnchors(content);
  assert.deepEqual([...anchors].sort(), ["intro", "intro-1", "intro-2"]);
});

test("extractHeadingAnchors ignores headings inside fenced code blocks", () => {
  const content = "# Real Heading\n```\n# Not A Heading\n```\n";
  const anchors = extractHeadingAnchors(content);
  assert.deepEqual([...anchors], ["real-heading"]);
});

test("extractHeadingAnchors strips inline formatting before slugifying", () => {
  const content = "## `run_tests` and *the* setup\n";
  const anchors = extractHeadingAnchors(content);
  assert.deepEqual([...anchors], ["run_tests-and-the-setup"]);
});

test("slugifyHeading produces a double hyphen where punctuation removal leaves adjacent spaces", () => {
  // GitHub's slugger maps each space to a hyphen without collapsing runs,
  // so stripping "/" or "&" out of "A / B" / "A & B" leaves a double space
  // and therefore a double hyphen — this is real, observed GitHub behavior.
  assert.equal(slugifyHeading("8. Auth / Token"), "8-auth--token");
  assert.equal(slugifyHeading("Data Fetching & State Management"), "data-fetching--state-management");
  assert.equal(slugifyHeading("UI & Styling"), "ui--styling");
});

test("extractHeadingAnchors also picks up explicit HTML id=\"...\" anchors", () => {
  const content = '## <a id="my-custom-anchor">Some Heading</a>\n';
  const anchors = extractHeadingAnchors(content);
  assert.ok(anchors.has("my-custom-anchor"));
  assert.ok(anchors.has("some-heading")); // the auto-slug of the visible text still exists too
});
