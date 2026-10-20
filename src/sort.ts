import type { Hit } from "./scanner";

export type NoteSort = "line" | "label";
export type VaultSort = "modified" | "created" | "name";

function byPosition(a: Hit, b: Hit): number {
	return a.line - b.line || a.from - b.from;
}

function labelRank(hit: Hit, keywordOrder: string[], calloutOrder: string[]): number {
	const known = hit.kind === "keyword" ? keywordOrder.indexOf(hit.label)
		: hit.kind === "callout" ? calloutOrder.indexOf(hit.label) : 0;
	const unknown = known < 0;
	// Bands: keywords, callouts, tasks, then unknown labels.
	const band = unknown ? 3 : hit.kind === "keyword" ? 0 : hit.kind === "callout" ? 1 : 2;
	return band * 1_000_000 + (unknown ? 0 : known);
}

export function sortHits(hits: Hit[], mode: NoteSort, keywordOrder: string[], calloutOrder: string[]): Hit[] {
	const out = hits.slice();
	if (mode === "line") return out.sort(byPosition);
	return out.sort((a, b) =>
		labelRank(a, keywordOrder, calloutOrder) - labelRank(b, keywordOrder, calloutOrder) || byPosition(a, b));
}

function basename(path: string): string {
	return (path.split("/").pop() ?? path).replace(/\.md$/, "");
}

export function sortFiles<T extends { path: string; mtime: number; ctime: number }>(files: T[], mode: VaultSort): T[] {
	const out = files.slice();
	return out.sort((a, b) => {
		let d = 0;
		if (mode === "modified") d = b.mtime - a.mtime;
		else if (mode === "created") d = b.ctime - a.ctime;
		else d = basename(a.path).toLowerCase().localeCompare(basename(b.path).toLowerCase());
		return d || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
	});
}

export function displayNames(paths: string[]): Map<string, string> {
	const byBase = new Map<string, string[]>();
	for (const p of paths) {
		const b = basename(p);
		const list = byBase.get(b);
		if (list) list.push(p);
		else byBase.set(b, [p]);
	}
	const names = new Map<string, string>();
	for (const [base, group] of byBase) {
		for (const p of group) {
			if (group.length === 1) { names.set(p, base); continue; }
			const parts = p.split("/");
			const parent = parts.length > 1 ? parts[parts.length - 2] : "";
			names.set(p, parent ? parent + "/" + base : base);
		}
	}
	const count = new Map<string, number>();
	for (const n of names.values()) count.set(n, (count.get(n) ?? 0) + 1);
	for (const [p, n] of names) {
		if ((count.get(n) ?? 0) > 1) names.set(p, p.replace(/\.md$/, ""));
	}
	return names;
}
