import { test } from "node:test";
import assert from "node:assert/strict";
import { doneReplacement } from "../src/edit.ts";
import type { Hit } from "../src/scanner.ts";

const kw = (from: number, to: number, label = "TODO"): Hit => ({
  line: 0, kind: "keyword", label, text: "x", done: false, from, to,
});

test("keyword bare wraps token", () => {
  assert.deepEqual(doneReplacement(kw(0, 4), "TODO: x"), { from: 0, to: 4, insert: "~~TODO~~" });
});
test("keyword hashtag wraps token including #", () => {
  assert.deepEqual(doneReplacement(kw(0, 5), "#TODO x"), { from: 0, to: 5, insert: "~~#TODO~~" });
});
test("keyword line changed returns null", () => {
  assert.equal(doneReplacement(kw(0, 4), "DONE: x"), null);
});
test("task open box becomes [x]", () => {
  const hit: Hit = { line: 0, kind: "task", label: "task", text: "x", done: false, from: 2, to: 5 };
  assert.deepEqual(doneReplacement(hit, "- [ ] x"), { from: 2, to: 5, insert: "[x]" });
});
test("task already checked returns null", () => {
  const hit: Hit = { line: 0, kind: "task", label: "task", text: "x", done: false, from: 2, to: 5 };
  assert.equal(doneReplacement(hit, "- [x] x"), null);
});
test("callout returns null", () => {
  const hit: Hit = { line: 0, kind: "callout", label: "?", text: "q", done: false, from: 2, to: 3 };
  assert.equal(doneReplacement(hit, "- ? q"), null);
});
test("hashtag hit whose line lost the # returns null", () => {
  assert.equal(doneReplacement(kw(0, 5), "TODO x"), null);
});
test("lowercase token returns null", () => {
  assert.equal(doneReplacement(kw(0, 4), "todo: x"), null);
});
test("out-of-range offsets on a shorter line return null", () => {
  assert.equal(doneReplacement(kw(10, 14), "TODO"), null);
  const hit: Hit = { line: 0, kind: "task", label: "task", text: "x", done: false, from: 8, to: 11 };
  assert.equal(doneReplacement(hit, "- [ ]"), null);
});
