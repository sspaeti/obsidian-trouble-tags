import { test } from "node:test";
import assert from "node:assert/strict";
import { applyToText, doneReplacement, undoneReplacement } from "../src/edit.ts";
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

const done = (h: Hit): Hit => ({ ...h, done: true });
test("undone keyword unwraps strikethrough, widening by 2", () => {
  assert.deepEqual(undoneReplacement(done(kw(2, 6)), "~~TODO~~ x"), { from: 0, to: 8, insert: "TODO" });
});
test("undone hashtag keyword keeps the #", () => {
  assert.deepEqual(undoneReplacement(done(kw(2, 7)), "~~#TODO~~"), { from: 0, to: 9, insert: "#TODO" });
});
test("undone on a not-done keyword hit returns null", () => {
  assert.equal(undoneReplacement(kw(2, 6), "~~TODO~~ x"), null);
});
test("undone keyword whose line changed returns null", () => {
  assert.equal(undoneReplacement(done(kw(2, 6)), "~~DONE~~ x"), null);
  assert.equal(undoneReplacement(done(kw(2, 6)), "xxTODOxx x"), null);
});
test("undone task [x] becomes [ ]", () => {
  const hit: Hit = { line: 0, kind: "task", label: "task", text: "a", done: true, from: 2, to: 5 };
  assert.deepEqual(undoneReplacement(hit, "- [x] a"), { from: 2, to: 5, insert: "[ ]" });
  assert.deepEqual(undoneReplacement(hit, "- [-] a"), { from: 2, to: 5, insert: "[ ]" });
});
test("undone task already open returns null", () => {
  const hit: Hit = { line: 0, kind: "task", label: "task", text: "a", done: true, from: 2, to: 5 };
  assert.equal(undoneReplacement(hit, "- [ ] a"), null);
});
test("undone callout returns null", () => {
  const hit: Hit = { line: 0, kind: "callout", label: "?", text: "q", done: true, from: 2, to: 3 };
  assert.equal(undoneReplacement(hit, "- ? q"), null);
});
test("undone keyword inside a wider strike span removes the pair, keeps the text", () => {
  assert.deepEqual(undoneReplacement(done(kw(6, 10)), "~~fix TODO later~~ x"), { from: 0, to: 18, insert: "fix TODO later" });
});
test("undone keyword flagged done but outside any strike span returns null", () => {
  assert.equal(undoneReplacement(done(kw(4, 8)), "fix TODO later ~~x~~"), null);
  assert.equal(undoneReplacement(done(kw(4, 8)), "fix TODO later"), null);
});
test("undone task [X] uppercase becomes [ ]", () => {
  const hit: Hit = { line: 0, kind: "task", label: "task", text: "a", done: true, from: 2, to: 5 };
  assert.deepEqual(undoneReplacement(hit, "- [X] a"), { from: 2, to: 5, insert: "[ ]" });
});

test("applyToText marks a keyword done on its line", () => {
  const hit: Hit = { ...kw(0, 4), line: 1 };
  assert.deepEqual(applyToText("a\nTODO: x\nb", hit, doneReplacement), { text: "a\n~~TODO~~: x\nb", changed: true });
});
test("applyToText keeps CRLF line endings", () => {
  const hit: Hit = { ...kw(0, 4), line: 1 };
  assert.deepEqual(applyToText("a\r\nTODO: x\r\nb", hit, doneReplacement), { text: "a\r\n~~TODO~~: x\r\nb", changed: true });
});
test("applyToText leaves text unchanged when the line is out of range", () => {
  const hit: Hit = { ...kw(0, 4), line: 5 };
  assert.deepEqual(applyToText("TODO: x", hit, doneReplacement), { text: "TODO: x", changed: false });
});
test("applyToText leaves text unchanged when the line changed", () => {
  const hit: Hit = { ...kw(0, 4), line: 0 };
  assert.deepEqual(applyToText("DONE: x\nTODO", hit, doneReplacement), { text: "DONE: x\nTODO", changed: false });
});
