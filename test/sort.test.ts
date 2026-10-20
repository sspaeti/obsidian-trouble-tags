import { test } from "node:test";
import assert from "node:assert/strict";
import { displayNames, sortFiles, sortHits } from "../src/sort.ts";
import type { Hit } from "../src/scanner.ts";

const h = (line: number, from: number, kind: Hit["kind"], label: string): Hit => ({
  line, kind, label, text: "x", done: false, from, to: from + 1,
});

const KW = ["TODO", "FIXME"];
const CO = ["&", "?"];

test("sortHits line orders by line then from", () => {
  const hits = [h(3, 0, "keyword", "TODO"), h(1, 5, "keyword", "TODO"), h(1, 2, "keyword", "FIXME")];
  assert.deepEqual(sortHits(hits, "line", KW, CO).map((x) => [x.line, x.from]), [[1, 2], [1, 5], [3, 0]]);
});

test("sortHits label: keywords, callouts, tasks, unknown last; ties by line", () => {
  const hits = [
    h(0, 0, "task", "task"),
    h(1, 0, "callout", "?"),
    h(2, 0, "keyword", "FIXME"),
    h(3, 0, "keyword", "TODO"),
    h(4, 0, "callout", "&"),
    h(5, 0, "keyword", "ZZZ"),
    h(6, 0, "keyword", "TODO"),
  ];
  const out = sortHits(hits, "label", KW, CO).map((x) => x.line);
  assert.deepEqual(out, [3, 6, 2, 4, 1, 0, 5]);
});

test("sortHits does not mutate input", () => {
  const hits = [h(2, 0, "keyword", "TODO"), h(1, 0, "keyword", "TODO")];
  sortHits(hits, "line", KW, CO);
  assert.equal(hits[0].line, 2);
});

const f = (path: string, mtime: number, ctime: number) => ({ path, mtime, ctime });

test("sortFiles modified and created are descending", () => {
  const files = [f("a.md", 1, 3), f("b.md", 3, 1), f("c.md", 2, 2)];
  assert.deepEqual(sortFiles(files, "modified").map((x) => x.path), ["b.md", "c.md", "a.md"]);
  assert.deepEqual(sortFiles(files, "created").map((x) => x.path), ["a.md", "c.md", "b.md"]);
});

test("sortFiles name is case-insensitive basename, ties by path", () => {
  const files = [f("z/b.md", 0, 0), f("a/B.md", 0, 0), f("m/a.md", 0, 0)];
  assert.deepEqual(sortFiles(files, "name").map((x) => x.path), ["m/a.md", "a/B.md", "z/b.md"]);
});

test("sortFiles ties by path", () => {
  const files = [f("b.md", 1, 1), f("a.md", 1, 1)];
  assert.deepEqual(sortFiles(files, "modified").map((x) => x.path), ["a.md", "b.md"]);
});

test("displayNames unique basenames", () => {
  const m = displayNames(["a/x.md", "a/y.md"]);
  assert.equal(m.get("a/x.md"), "x");
  assert.equal(m.get("a/y.md"), "y");
});

test("displayNames duplicates get parent folder", () => {
  const m = displayNames(["a/x.md", "b/x.md", "root.md"]);
  assert.equal(m.get("a/x.md"), "a/x");
  assert.equal(m.get("b/x.md"), "b/x");
  assert.equal(m.get("root.md"), "root");
});

test("displayNames root duplicate stays bare", () => {
  const m = displayNames(["x.md", "a/x.md"]);
  assert.equal(m.get("x.md"), "x");
  assert.equal(m.get("a/x.md"), "a/x");
});

test("displayNames same parent falls back to full path", () => {
  const m = displayNames(["p/a/x.md", "q/a/x.md", "r/b/x.md"]);
  assert.equal(m.get("p/a/x.md"), "p/a/x");
  assert.equal(m.get("q/a/x.md"), "q/a/x");
  assert.equal(m.get("r/b/x.md"), "b/x");
});
