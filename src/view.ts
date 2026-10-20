import { Editor, ItemView, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type TroubleTagsPlugin from "./main";
import { Hit, HitKind, scanText } from "./scanner";
import { doneReplacement } from "./edit";
import { DEFAULT_SETTINGS } from "./settings";
import { findMarkdownView } from "./workspace";

export const VIEW_TYPE = "trouble-tags-view";

// Keywords with a dedicated colour class in styles.css.
const BUILTIN_KEYWORDS = DEFAULT_SETTINGS.keywords;
const CUSTOM_PALETTE_SIZE = 6;
const NOTE_SCAN_DELAY = 250;

const FILTER_CHIPS: Array<{ kind: HitKind; text: string }> = [
	{ kind: "keyword", text: "Keywords" },
	{ kind: "callout", text: "Callouts" },
	{ kind: "task", text: "Tasks" },
];

export class TroubleView extends ItemView {
	plugin: TroubleTagsPlugin;
	currentPath: string | null = null;
	hits: Hit[] = [];
	private noteScanTimer: number | null = null;
	private scanSeq = 0;
	private lastRenderKey: string | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: TroubleTagsPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() { return VIEW_TYPE; }
	getDisplayText() { return "Trouble Tags"; }
	getIcon() { return "alert-triangle"; }

	async onOpen() {
		await this.scanNote(this.app.workspace.getActiveFile());
	}

	onClose() {
		this.clearNoteScanTimer();
		return Promise.resolve();
	}

	private clearNoteScanTimer() {
		if (this.noteScanTimer !== null) {
			window.clearTimeout(this.noteScanTimer);
			this.noteScanTimer = null;
		}
	}

	scheduleNoteScan(editor?: Editor) {
		this.clearNoteScanTimer();
		const path = this.currentPath;
		if (!path) return;
		this.noteScanTimer = window.setTimeout(() => {
			this.noteScanTimer = null;
			// The panel switched to another note meanwhile; this editor's text is stale.
			if (this.currentPath !== path) return;
			const file = this.app.vault.getFileByPath(path);
			void this.scanNote(file, editor?.getValue());
		}, NOTE_SCAN_DELAY);
	}

	/** Rescan a note, preferring the live editor buffer over the (possibly stale) disk copy. */
	private rescanPath(path: string | null) {
		const file = path ? this.app.vault.getFileByPath(path) : null;
		const mv = path ? findMarkdownView(this.app, path) : null;
		void this.scanNote(file, mv ? mv.editor.getValue() : undefined);
	}

	async scanNote(file: TFile | null, text?: string) {
		const seq = ++this.scanSeq;
		if ((file?.path ?? null) !== this.currentPath) this.clearNoteScanTimer();
		if (!file || file.extension !== "md") {
			this.currentPath = null;
			this.hits = [];
			this.render();
			return;
		}
		this.currentPath = file.path;
		const content = text ?? (await this.app.vault.cachedRead(file));
		// A newer scan started while reading from disk; drop this result.
		if (seq !== this.scanSeq) return;
		this.hits = scanText(content, this.plugin.scanConfig);
		this.render();
	}

	onConfigChanged() {
		// Force a rebuild: keyword colours depend on settings, not only on hits.
		this.lastRenderKey = null;
		this.rescanPath(this.currentPath);
	}

	private visibleHits(): Hit[] {
		const { filters, showDone } = this.plugin.settings;
		return this.hits.filter((h) => filters[h.kind] && (showDone || !h.done));
	}

	render() {
		const visible = this.visibleHits();
		const { filters, showDone } = this.plugin.settings;
		const key = JSON.stringify(visible) + "\n" + this.currentPath + "\n" + JSON.stringify({ filters, showDone });
		if (key === this.lastRenderKey) return;
		this.lastRenderKey = key;

		const root = this.contentEl;
		root.empty();
		const container = root.createDiv({ cls: "trouble-tags-container" });
		this.renderHeader(container);

		if (!this.currentPath) {
			container.createDiv({ cls: "trouble-tags-empty", text: "No file open" });
			return;
		}
		container.createDiv({ cls: "trouble-tags-filename", text: this.currentPath.split("/").pop() ?? "" });

		if (visible.length === 0) {
			container.createDiv({ cls: "trouble-tags-empty", text: "Nothing found" });
			return;
		}
		const path = this.currentPath;
		for (const hit of visible) this.renderRow(container, path, hit);
	}

	private renderHeader(container: HTMLElement) {
		const settings = this.plugin.settings;
		const header = container.createDiv({ cls: "trouble-tags-header" });
		for (const chip of FILTER_CHIPS) {
			this.renderChip(header, chip.text, settings.filters[chip.kind], () => {
				settings.filters[chip.kind] = !settings.filters[chip.kind];
			});
		}
		this.renderChip(header, "Show done", settings.showDone, () => {
			settings.showDone = !settings.showDone;
		});
	}

	private renderChip(parent: HTMLElement, text: string, active: boolean, toggle: () => void) {
		const btn = parent.createEl("button", { cls: "trouble-tags-chip", text });
		btn.toggleClass("is-active", active);
		btn.addEventListener("click", () => {
			toggle();
			void this.plugin.saveSettings();
			this.render();
		});
	}

	private renderRow(container: HTMLElement, path: string, hit: Hit) {
		const row = container.createDiv({ cls: "trouble-tags-row" });
		if (hit.done) row.addClass("is-done");

		row.createSpan({ cls: ["trouble-tags-label", this.labelClass(hit)], text: hit.kind === "task" ? "task" : hit.label });
		if (hit.secondary) {
			row.createSpan({ cls: ["trouble-tags-label", "trouble-tags-label-callout"], text: hit.secondary });
		}
		row.createSpan({ cls: "trouble-tags-line", text: ":" + (hit.line + 1) });
		row.createSpan({ cls: "trouble-tags-context", text: hit.text });

		if (hit.kind !== "callout" && !hit.done) {
			const btn = row.createEl("button", { cls: "trouble-tags-done", attr: { "aria-label": "Mark done" } });
			setIcon(btn, "check");
			btn.addEventListener("click", (evt) => {
				evt.stopPropagation();
				this.markDone(path, hit);
			});
		}

		row.addEventListener("click", () => this.jumpTo(path, hit.line));
	}

	private labelClass(hit: Hit): string {
		if (hit.kind === "callout") return "trouble-tags-label-callout";
		if (hit.kind === "task") return "trouble-tags-label-task";
		if (BUILTIN_KEYWORDS.includes(hit.label)) return "trouble-tags-label-" + hit.label.toLowerCase();
		const i = Math.max(0, this.plugin.settings.keywords.indexOf(hit.label));
		return "trouble-tags-label-custom-" + (i % CUSTOM_PALETTE_SIZE);
	}

	jumpTo(path: string, line: number) {
		const mv = findMarkdownView(this.app, path);
		if (mv && mv.getMode() === "source") {
			const pos = { line, ch: 0 };
			mv.editor.setCursor(pos);
			mv.editor.scrollIntoView({ from: pos, to: pos }, true);
			void this.app.workspace.revealLeaf(mv.leaf);
			mv.editor.focus();
			return;
		}
		const file = this.app.vault.getFileByPath(path);
		if (!file) return;
		// Reading mode: reuse the leaf already showing the note.
		const leaf = mv ? mv.leaf : this.app.workspace.getLeaf(false);
		void leaf.openFile(file, { eState: { line } });
	}

	markDone(path: string, hit: Hit) {
		const mv = findMarkdownView(this.app, path);
		// A MarkdownView always has an editor, even in reading mode; only write in source mode.
		if (!mv || mv.getMode() !== "source") {
			new Notice("Open the note in editing mode to mark done");
			return;
		}
		const editor = mv.editor;
		const lineText = hit.line < editor.lineCount() ? editor.getLine(hit.line) : "";
		const r = doneReplacement(hit, lineText);
		if (r) {
			editor.replaceRange(r.insert, { line: hit.line, ch: r.from }, { line: hit.line, ch: r.to });
			this.scheduleNoteScan(editor);
			return;
		}
		new Notice("Line changed, rescanning");
		void this.scanNote(this.app.vault.getFileByPath(path), editor.getValue());
	}
}
