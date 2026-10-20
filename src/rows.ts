import { setIcon } from "obsidian";
import type { Hit } from "./scanner";
import { DEFAULT_SETTINGS } from "./settings";

// Keywords with a dedicated colour class in styles.css.
const BUILTIN_KEYWORDS = DEFAULT_SETTINGS.keywords;
const CUSTOM_PALETTE_SIZE = 6;

export interface RowOptions {
	/** Text of the location span, e.g. ":12" (note scope) or "note.md:12" (vault scope). */
	location: string;
	/** Tooltip of the location span, the full path of the note. */
	title?: string;
	keywords: string[];
	onJump: () => void;
	onDone: () => void;
	onUndone: () => void;
}

export function labelClass(hit: Hit, keywords: string[]): string {
	if (hit.kind === "callout") return "trouble-tags-label-callout";
	if (hit.kind === "task") return "trouble-tags-label-task";
	if (BUILTIN_KEYWORDS.includes(hit.label)) return "trouble-tags-label-" + hit.label.toLowerCase();
	const i = Math.max(0, keywords.indexOf(hit.label));
	return "trouble-tags-label-custom-" + (i % CUSTOM_PALETTE_SIZE);
}

export function renderRow(container: HTMLElement, hit: Hit, opts: RowOptions) {
	const row = container.createDiv({ cls: "trouble-tags-row" });
	if (hit.done) row.addClass("is-done");

	row.createSpan({ cls: ["trouble-tags-label", labelClass(hit, opts.keywords)], text: hit.kind === "task" ? "task" : hit.label });
	if (hit.secondary) {
		row.createSpan({ cls: ["trouble-tags-label", "trouble-tags-label-callout"], text: hit.secondary });
	}
	row.createSpan({ cls: "trouble-tags-line", text: opts.location, attr: opts.title ? { title: opts.title } : undefined });
	row.createSpan({ cls: "trouble-tags-context", text: hit.text });

	if (hit.kind !== "callout" && !hit.done) {
		const btn = row.createEl("button", { cls: "trouble-tags-done", attr: { "aria-label": "Mark done" } });
		setIcon(btn, "check");
		btn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			opts.onDone();
		});
	}

	if (hit.kind !== "callout" && hit.done) {
		const btn = row.createEl("button", { cls: "trouble-tags-undone", attr: { "aria-label": "Mark undone" } });
		setIcon(btn, "undo-2");
		btn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			opts.onUndone();
		});
	}

	row.addEventListener("click", opts.onJump);
}
