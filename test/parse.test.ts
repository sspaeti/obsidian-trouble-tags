import { test } from "node:test";
import assert from "node:assert/strict";
import { parseKeywords, parseCalloutChars } from "../src/parse.ts";

test("parseKeywords trims, uppercases, drops empty, dedupes", () => {
  assert.deepEqual(parseKeywords(" todo, Fixme,,tk "), ["TODO", "FIXME", "TK"]);
  assert.deepEqual(parseKeywords("a, A, b"), ["A", "B"]);
  assert.deepEqual(parseKeywords(""), []);
});

test("parseCalloutChars keeps single chars, dedupes", () => {
  assert.deepEqual(parseCalloutChars("? !  = ab"), ["?", "!", "="]);
  assert.deepEqual(parseCalloutChars("? ? !"), ["?", "!"]);
  assert.deepEqual(parseCalloutChars(""), []);
});
