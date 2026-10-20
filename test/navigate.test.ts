import { test } from "node:test";
import assert from "node:assert/strict";
import { neighbourHit } from "../src/navigate.ts";
import type { Hit } from "../src/scanner.ts";

const h = (line: number, from: number): Hit => ({
  line, from, to: from + 4, kind: "keyword", label: "TODO", text: "x", done: false,
});
const at = (hit: Hit | null) => hit && [hit.line, hit.from];

const hits = [h(10, 2), h(3, 0), h(3, 8)];

test("next picks the first hit after the cursor", () => {
  assert.deepEqual(at(neighbourHit(hits, { line: 0, ch: 0 }, 1)), [3, 0]);
  assert.deepEqual(at(neighbourHit(hits, { line: 3, ch: 0 }, 1)), [3, 8]);
  assert.deepEqual(at(neighbourHit(hits, { line: 5, ch: 0 }, 1)), [10, 2]);
});

test("next wraps to the first hit after the last one", () => {
  assert.deepEqual(at(neighbourHit(hits, { line: 10, ch: 2 }, 1)), [3, 0]);
  assert.deepEqual(at(neighbourHit(hits, { line: 40, ch: 0 }, 1)), [3, 0]);
});

test("previous picks the last hit before the cursor", () => {
  assert.deepEqual(at(neighbourHit(hits, { line: 10, ch: 2 }, -1)), [3, 8]);
  assert.deepEqual(at(neighbourHit(hits, { line: 3, ch: 8 }, -1)), [3, 0]);
  assert.deepEqual(at(neighbourHit(hits, { line: 3, ch: 5 }, -1)), [3, 0]);
});

test("previous wraps to the last hit before the first one", () => {
  assert.deepEqual(at(neighbourHit(hits, { line: 3, ch: 0 }, -1)), [10, 2]);
  assert.deepEqual(at(neighbourHit(hits, { line: 0, ch: 0 }, -1)), [10, 2]);
});

test("no hits gives null", () => {
  assert.equal(neighbourHit([], { line: 0, ch: 0 }, 1), null);
});
