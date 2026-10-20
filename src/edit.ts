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
