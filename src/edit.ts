import type { Hit } from "./scanner";

export function doneReplacement(
  hit: Hit,
  lineText: string,
): { from: number; to: number; insert: string } | null {
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
): { from: number; to: number; insert: string } | null {
  if (hit.kind === "keyword") {
    if (!hit.done) return null;
    const token = lineText.slice(hit.from, hit.to);
    if (token !== hit.label && token !== "#" + hit.label) return null;
    // The scanner reports the token only; the surrounding "~~" sit outside the range.
    if (lineText.slice(hit.from - 2, hit.to + 2) !== "~~" + token + "~~") return null;
    return { from: hit.from - 2, to: hit.to + 2, insert: token };
  }
  if (hit.kind === "task") {
    if (!/^\[[^ ]\]$/.test(lineText.slice(hit.from, hit.to))) return null;
    return { from: hit.from, to: hit.to, insert: "[ ]" };
  }
  return null;
}
