import { struckRanges } from "./scanner.ts";
import type { Hit } from "./scanner.ts";

export type Replacement = { from: number; to: number; insert: string };

export function doneReplacement(
  hit: Hit,
  lineText: string,
): Replacement | null {
  const token = lineText.slice(hit.from, hit.to);
  if (hit.kind === "keyword") {
    if (token !== hit.label && token !== "#" + hit.label) return null;
    return { from: hit.from, to: hit.to, insert: "~~" + token + "~~" };
  }
  if (hit.kind === "task") {
    if (token !== "[ ]") return null;
    return { from: hit.from, to: hit.to, insert: "[x]" };
  }
  return null;
}

export function undoneReplacement(
  hit: Hit,
  lineText: string,
): Replacement | null {
  if (hit.kind === "keyword") {
    if (!hit.done) return null;
    const token = lineText.slice(hit.from, hit.to);
    if (token !== hit.label && token !== "#" + hit.label) return null;
    // The scanner reports the token only; the surrounding "~~" sit outside the range.
    if (lineText.slice(hit.from - 2, hit.to + 2) === "~~" + token + "~~") {
      return { from: hit.from - 2, to: hit.to + 2, insert: token };
    }
    // Hand-struck wider span (~~fix TODO later~~): drop the pair, keep the text.
    for (const [open, close] of struckRanges(lineText)) {
      if (open <= hit.from && hit.to <= close) {
        return { from: open - 2, to: close + 2, insert: lineText.slice(open, close) };
      }
    }
    return null;
  }
  if (hit.kind === "task") {
    if (!/^\[[^ ]\]$/.test(lineText.slice(hit.from, hit.to))) return null;
    return { from: hit.from, to: hit.to, insert: "[ ]" };
  }
  return null;
}

/**
 * Applies `fn` to line `hit.line` of a whole note. Splits on "\n" only, so a CRLF
 * line keeps its "\r". Out-of-range line or a refused replacement: text unchanged.
 */
export function applyToText(
  data: string,
  hit: Hit,
  fn: (hit: Hit, line: string) => Replacement | null,
): { text: string; changed: boolean } {
  const lines = data.split("\n");
  if (hit.line < 0 || hit.line >= lines.length) return { text: data, changed: false };
  const l = lines[hit.line];
  const r = fn(hit, l);
  if (!r) return { text: data, changed: false };
  lines[hit.line] = l.slice(0, r.from) + r.insert + l.slice(r.to);
  return { text: lines.join("\n"), changed: true };
}
