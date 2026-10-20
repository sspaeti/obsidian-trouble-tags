import { test } from "node:test";
import assert from "node:assert/strict";
import { buildScanConfig, configHash, scanText, struckRanges } from "../src/scanner.ts";

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

test("strike markers stripped from text", () => {
  const r = scanText("~~TODO: call bank~~", cfg);
  assert.equal(r.length, 1);
  assert.equal(r[0].text, "call bank");
  assert.equal(r[0].done, true);
});
test("empty keyword list", () => {
  const c = buildScanConfig({ keywords: [], keywordMode: "both", calloutChars: [] });
  assert.equal(c.keywordRe, null);
  assert.deepEqual(rows("TODO x", c), []);
});
test("regex metacharacters in keyword are literal", () => {
  const c = buildScanConfig({ keywords: ["C++"], keywordMode: "both", calloutChars: [] });
  assert.deepEqual(rows("C++ fix", c), [[0, "keyword", "C++", false, 0, 3, "fix"]]);
});
test("struckRanges ignores unpaired trailing", () => {
  assert.deepEqual(struckRanges("a ~~b~~ c ~~d"), [[4, 5]]);
});
test("configHash is JSON of settings", () => {
  const s = { keywords: ["A"], keywordMode: "bare" as const, calloutChars: ["?"] };
  assert.equal(
    configHash(s),
    JSON.stringify({ keywords: ["A"], keywordMode: "bare", calloutChars: ["?"] }),
  );
});

const cc = buildScanConfig({
  keywords: KW,
  keywordMode: "both",
  calloutChars: ["&", "?", "!", "~", "@", "$", "%", "="],
});
test("callout basic", () => {
  assert.deepEqual(rows("- ? why?", cc), [[0, "callout", "?", false, 2, 3, "why?"]]);
});
test("callout bullets and ordered", () => {
  assert.deepEqual(rows("* ! important", cc).map((r) => [r[1], r[2]]), [["callout", "!"]]);
  assert.deepEqual(rows("+ = idea", cc).map((r) => [r[1], r[2]]), [["callout", "="]]);
  assert.deepEqual(rows("1. ! ordered", cc).map((r) => [r[1], r[2]]), [["callout", "!"]]);
  assert.deepEqual(rows("2) $ money", cc).map((r) => [r[1], r[2]]), [["callout", "$"]]);
});
test("callout needs spaces", () => {
  assert.deepEqual(rows("-? nospace", cc), []);
  assert.deepEqual(rows("- ?nospace", cc), []);
});
test("task open", () => {
  assert.deepEqual(rows("- [ ] buy milk", cc), [[0, "task", "task", false, 2, 5, "buy milk"]]);
});
test("task done", () => {
  const r = rows("- [x] bought", cc);
  assert.equal(r.length, 1);
  assert.equal(r[0][1], "task");
  assert.equal(r[0][3], true);
});
test("task with callout char is one row", () => {
  const r = scanText("- [ ] ? question task", cc);
  assert.equal(r.length, 1);
  assert.equal(r[0].kind, "task");
  assert.equal(r[0].secondary, "?");
  assert.equal(r[0].text, "question task");
});
test("task plus keyword gives two rows", () => {
  const r = rows("- [ ] TODO: call bank", cc);
  assert.deepEqual(r, [
    [0, "task", "task", false, 2, 5, "TODO: call bank"],
    [0, "keyword", "TODO", false, 6, 10, "call bank"],
  ]);
});
test("callout plus keyword gives two rows", () => {
  const r = rows("- ! TODO later", cc);
  assert.deepEqual(r.map((x) => [x[1], x[2]]), [["callout", "!"], ["keyword", "TODO"]]);
});
test("empty calloutChars", () => {
  const c = buildScanConfig({ keywords: KW, keywordMode: "both", calloutChars: [] });
  assert.equal(c.calloutRe, null);
  assert.deepEqual(rows("- ? x", c), []);
});

test("emoji callout char matches", () => {
  const c = buildScanConfig({ keywords: [], keywordMode: "both", calloutChars: ["🔥"] });
  const hits = scanText("- 🔥 hot", c);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "callout");
  assert.equal(hits[0].label, "🔥");
  assert.equal(hits[0].text, "hot");
  assert.equal("- 🔥 hot".slice(hits[0].from, hits[0].to), "🔥");
});
