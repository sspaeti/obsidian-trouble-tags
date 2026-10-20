import { test } from "node:test";
import assert from "node:assert/strict";
import { buildScanConfig, scanText } from "../src/scanner.ts";

const KW = ["TODO", "FIXME", "BUG", "NOTE", "WARN", "IDEA", "TK"];
const cfg = buildScanConfig({ keywords: KW, keywordMode: "both", calloutChars: [] });
const rows = (text: string, c = cfg) =>
  scanText(text, c).map((h) => [h.line, h.kind, h.label, h.done, h.from, h.to, h.text]);

test("plain keyword with colon", () => {
  assert.deepEqual(rows("TODO: fix it"), [[0, "keyword", "TODO", false, 0, 4, "fix it"]]);
});
test("hashtag keyword", () => {
  assert.deepEqual(rows("#TODO fix it"), [[0, "keyword", "TODO", false, 0, 5, "fix it"]]);
});
test("keyword in parens", () => {
  assert.deepEqual(rows("(TODO: why?)"), [[0, "keyword", "TODO", false, 1, 5, "why?)"]]);
});
test("heading with possessive", () => {
  assert.deepEqual(rows("## TODO's"), [[0, "keyword", "TODO", false, 3, 7, "'s"]]);
});
test("keyword alone falls back to line", () => {
  assert.deepEqual(rows("TODO"), [[0, "keyword", "TODO", false, 0, 4, "TODO"]]);
});
test("lowercase no hit", () => {
  assert.deepEqual(rows("a note about todos"), []);
});
test("word-embedded no hit", () => {
  assert.deepEqual(rows("TODOS and MYTODO"), []);
});
test("two hits on a line", () => {
  const r = rows("TODO one and FIXME two");
  assert.equal(r.length, 2);
  assert.deepEqual(r.map((x) => x[2]), ["TODO", "FIXME"]);
  assert.deepEqual(r.map((x) => x[0]), [0, 0]);
});
test("struck keyword is done", () => {
  const r = rows("~~TODO~~ done");
  assert.equal(r.length, 1);
  assert.equal(r[0][3], true);
});
test("struck whole item is done", () => {
  const r = rows("~~TODO: call bank~~");
  assert.equal(r.length, 1);
  assert.equal(r[0][3], true);
});
test("unpaired strike not done", () => {
  const r = rows("~~TODO fix this");
  assert.equal(r.length, 1);
  assert.equal(r[0][3], false);
});
test("callout headers are not keyword hits", () => {
  assert.deepEqual(rows("> [!NOTE] title"), []);
  assert.deepEqual(rows("> [!TODO]- folded"), []);
});
test("frontmatter skipped", () => {
  const r = rows("---\ntags: TODO\n---\nTODO: real");
  assert.equal(r.length, 1);
  assert.equal(r[0][0], 3);
});
test("code fence content still scanned", () => {
  assert.equal(rows("```\nTODO in code\n```").length, 1);
});
test("mode hashtag", () => {
  const c = buildScanConfig({ keywords: KW, keywordMode: "hashtag", calloutChars: [] });
  assert.equal(rows("TODO x", c).length, 0);
  assert.equal(rows("#TODO x", c).length, 1);
});
test("mode bare", () => {
  const c = buildScanConfig({ keywords: KW, keywordMode: "bare", calloutChars: [] });
  assert.equal(rows("#TODO x", c).length, 0);
  assert.equal(rows("TODO x", c).length, 1);
});
