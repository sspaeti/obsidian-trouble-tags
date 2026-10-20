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
