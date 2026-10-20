import type { Hit } from "./scanner";

export interface Cursor {
	line: number;
	ch: number;
}

export type Direction = 1 | -1;

function before(a: Cursor, b: Cursor): boolean {
	return a.line < b.line || (a.line === b.line && a.ch < b.ch);
}

/**
 * The hit after (dir 1) or before (dir -1) the cursor, wrapping around the
 * note. Returns null when there are no hits.
 */
export function neighbourHit(hits: Hit[], cursor: Cursor, dir: Direction): Hit | null {
	if (hits.length === 0) return null;
	const sorted = hits.slice().sort((a, b) => a.line - b.line || a.from - b.from);
	if (dir === 1) {
		return sorted.find((h) => before(cursor, { line: h.line, ch: h.from })) ?? sorted[0];
	}
	for (let i = sorted.length - 1; i >= 0; i--) {
		const h = sorted[i];
		if (before({ line: h.line, ch: h.from }, cursor)) return h;
	}
	return sorted[sorted.length - 1];
}
