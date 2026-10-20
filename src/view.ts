import { Editor, ItemView, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type TroubleTagsPlugin from "./main";
import { Hit, HitKind, scanText } from "./scanner";
import { applyToText, doneReplacement, undoneReplacement } from "./edit";
import type { Replacement } from "./edit";
import { renderRow } from "./rows";
import { findMarkdownView } from "./workspace";
import { NoteSort, VaultSort, displayNames, sortFiles, sortHits } from "./sort";

export const VIEW_TYPE = "trouble-tags-view";

const NOTE_SCAN_DELAY = 250;
const VAULT_ROW_STEP = 500;
const PROGRESS_THROTTLE = 100;

type PanelScope = "note" | "vault";
type EditFn = (hit: Hit, lineText: string) => Replacement | null;

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
	private collapsed = new Set<string>();
	private rowLimit = VAULT_ROW_STEP;
	private progressText = "Indexing 0/0";
	private progressEl: HTMLElement | null = null;
	private renderedPaths: string[] = [];
	private refreshing = false;
	private refreshBtn: HTMLButtonElement | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: TroubleTagsPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() { return VIEW_TYPE; }
	getDisplayText() { return "Trouble Tags"; }
	getIcon() { return this.plugin.settings.icon; }

	get panelScope(): PanelScope {
		return this.plugin.settings.scope;
	}

	async onOpen() {
		// Renders the loaded index as-is. A layout restore must not touch the vault;
		// the open command (a user action) calls refreshVault() instead.
		await this.scanNote(this.app.workspace.getActiveFile());
		// scanNote only pushes the status count in vault scope.
		if (this.panelScope === "vault") this.renderVault();
	}

	onClose() {
		this.clearNoteScanTimer();
		// A scan still reading from disk must not push a status count after close.
		this.scanSeq++;
		this.progressEl = null;
		this.plugin.updateStatus(null);
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
		// In vault scope this still runs to keep the status bar count fresh; scanNote skips the render.
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
			this.pushStatus();
			if (this.panelScope === "note") this.render();
			return;
		}
		this.currentPath = file.path;
		const content = text ?? (await this.app.vault.cachedRead(file));
		// A newer scan started while reading from disk; drop this result.
		if (seq !== this.scanSeq) return;
		this.hits = scanText(content, this.plugin.scanConfig);
		this.pushStatus();
		// Vault scope does not show the note; setScope("note") rescans and renders it.
		if (this.panelScope === "note") this.render();
	}

	/** Status bar count: visible, not done hits of the current note. */
	private pushStatus() {
		const open = this.currentPath ? this.hits.filter((h) => !h.done && this.plugin.settings.filters[h.kind]).length : 0;
		this.plugin.updateStatus(open);
	}

	onConfigChanged() {
		// Force a rebuild: keyword colours depend on settings, not only on hits.
		this.lastRenderKey = null;
		this.rescanPath(this.currentPath);
		this.renderVault();
	}

	async setScope(scope: PanelScope) {
		if (scope === this.panelScope) return;
		this.plugin.settings.scope = scope;
		void this.plugin.saveSettings();
		this.rowLimit = VAULT_ROW_STEP;
		if (scope === "note") {
			this.rescanPath(this.currentPath);
			return;
		}
		// Show the cached index (or the build button) at once, then catch up.
		this.render();
		await this.refreshVault();
	}

	/** Metadata pass over the vault; no-op without an index or outside vault scope. */
	async refreshVault() {
		if (this.panelScope !== "vault") return;
		const store = this.plugin.indexStore;
		if (store.files === null || this.refreshing) return;
		this.setRefreshing(true);
		try {
			await this.plugin.runStoreOp(() => store.refresh(this.plugin.shouldStop));
		} finally {
			this.setRefreshing(false);
		}
		this.renderVault();
	}

	private setRefreshing(on: boolean) {
		this.refreshing = on;
		this.updateRefreshBtn();
	}

	private updateRefreshBtn() {
		if (this.refreshBtn) this.refreshBtn.disabled = this.refreshing || this.plugin.indexBuilding;
	}

	async buildIndex() {
		const plugin = this.plugin;
		if (plugin.indexBuilding) return;
		plugin.indexBuilding = true;
		this.rowLimit = VAULT_ROW_STEP;
		this.progressText = "Indexing 0/0";
		this.render();
		let lastPaint = 0;
		const store = plugin.indexStore;
		try {
			await plugin.runStoreOp(async () => {
				await store.build((done, total) => {
					const now = Date.now();
					if (now - lastPaint < PROGRESS_THROTTLE && done < total) return;
					lastPaint = now;
					this.progressText = `Indexing ${done}/${total}`;
					if (this.progressEl?.isConnected) this.progressEl.setText(this.progressText);
				}, plugin.shouldStop);
				// Files touched during the build were marked dirty; pick them up now.
				if (store.files !== null && store.dirty.size > 0) await store.refresh(plugin.shouldStop);
			});
		} finally {
			plugin.indexBuilding = false;
		}
		this.renderVault();
	}

	private isVisible(hit: Hit): boolean {
		return this.plugin.isVisibleHit(hit);
	}

	render() {
		if (this.panelScope === "vault") {
			this.renderVault();
			return;
		}
		const { filters, showDone, noteSort, keywords, calloutChars } = this.plugin.settings;
		const visible = sortHits(this.hits.filter((h) => this.isVisible(h)), noteSort, keywords, calloutChars);
		const key = "note\n" + JSON.stringify(visible) + "\n" + this.currentPath + "\n" + JSON.stringify({ filters, showDone, noteSort });
		if (key === this.lastRenderKey) return;
		this.lastRenderKey = key;

		const container = this.resetContainer();
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
		for (const hit of visible) {
			renderRow(container, hit, {
				location: ":" + (hit.line + 1),
				title: path,
				keywords: this.plugin.settings.keywords,
				onJump: () => this.jumpTo(path, hit.line),
				onDone: () => { void this.markDone(path, hit); },
				onUndone: () => { void this.markUndone(path, hit); },
			});
		}
	}

	renderVault() {
		if (this.panelScope !== "vault") return;
		const plugin = this.plugin;
		const files = plugin.indexStore.files;
		let groups: Array<{ path: string; mtime: number; ctime: number; hits: Hit[] }> = [];
		const { vaultSort } = plugin.settings;
		if (files !== null) {
			for (const path in files) {
				const entry = files[path];
				const hits = entry.hits.filter((h) => this.isVisible(h));
				if (hits.length === 0) continue;
				const ctime = vaultSort === "created" ? (this.app.vault.getFileByPath(path)?.stat.ctime ?? 0) : 0;
				groups.push({ path, mtime: entry.mtime, ctime, hits });
			}
			groups = sortFiles(groups, vaultSort);
			for (const p of this.collapsed) if (!(p in files)) this.collapsed.delete(p);
		} else {
			// Cleared or invalidated index: start the next build from a fresh view state.
			this.rowLimit = VAULT_ROW_STEP;
			this.collapsed.clear();
		}
		const { filters, showDone } = plugin.settings;
		// The store revision stands in for the hits: it changes on every index mutation.
		const key = "vault\n" + JSON.stringify([
			files === null, plugin.indexBuilding, plugin.indexStore.revision,
			filters, showDone, Array.from(this.collapsed).sort(), this.rowLimit, vaultSort,
		]);
		if (key === this.lastRenderKey) return;
		this.lastRenderKey = key;

		this.renderedPaths = groups.map((g) => g.path);
		const container = this.resetContainer();
		this.progressEl = null;
		if (files === null) {
			container.createDiv({ cls: "trouble-tags-filename", text: "Whole vault" });
			if (plugin.indexBuilding) {
				this.progressEl = container.createDiv({ cls: "trouble-tags-progress", text: this.progressText });
			} else {
				container.createDiv({ cls: "trouble-tags-empty", text: "No index yet" });
			}
			const btn = container.createEl("button", { cls: ["trouble-tags-build", "mod-cta"], text: "Build index" });
			btn.disabled = plugin.indexBuilding;
			btn.addEventListener("click", () => { void this.buildIndex(); });
			return;
		}
		const n = groups.length;
		container.createDiv({ cls: "trouble-tags-filename", text: `Whole vault · ${n} ${n === 1 ? "file" : "files"}` });
		if (n === 0) {
			container.createDiv({ cls: "trouble-tags-empty", text: "Nothing found" });
			return;
		}

		const names = displayNames(this.renderedPaths);
		let rows = 0;
		let total = 0;
		for (const g of groups) {
			const collapsed = this.collapsed.has(g.path);
			if (!collapsed) total += g.hits.length;
			if (rows >= this.rowLimit) continue;
			const name = names.get(g.path) ?? g.path;
			const header = container.createDiv({ cls: "trouble-tags-file", attr: { title: g.path } });
			header.toggleClass("is-collapsed", collapsed);
			header.createSpan({ cls: "trouble-tags-file-name", text: name });
			header.createSpan({ cls: "trouble-tags-file-count", text: String(g.hits.length) });
			header.addEventListener("click", () => {
				if (this.collapsed.has(g.path)) this.collapsed.delete(g.path);
				else this.collapsed.add(g.path);
				// Collapsed groups have no rows in the DOM; re-render and keep the scroll position.
				const top = this.contentEl.scrollTop;
				this.renderVault();
				this.contentEl.scrollTop = top;
			});
			// Rows of a collapsed group are not created and do not count toward the row limit.
			if (collapsed) continue;
			const rowsEl = container.createDiv({ cls: "trouble-tags-file-rows" });
			for (const hit of g.hits) {
				if (rows >= this.rowLimit) break;
				rows++;
				renderRow(rowsEl, hit, {
					location: `${name}:${hit.line + 1}`,
					title: g.path,
					keywords: plugin.settings.keywords,
					onJump: () => this.jumpTo(g.path, hit.line),
					onDone: () => { void this.markDone(g.path, hit); },
					onUndone: () => { void this.markUndone(g.path, hit); },
				});
			}
		}
		if (rows < total) {
			const more = container.createDiv({ cls: "trouble-tags-more", text: "Show more" });
			more.addEventListener("click", () => {
				this.rowLimit += VAULT_ROW_STEP;
				this.renderVault();
			});
		}
	}

	private resetContainer(): HTMLElement {
		const root = this.contentEl;
		root.empty();
		const container = root.createDiv({ cls: "trouble-tags-container" });
		this.renderHeader(container);
		return container;
	}

	private renderHeader(container: HTMLElement) {
		const settings = this.plugin.settings;
		const header = container.createDiv({ cls: "trouble-tags-header" });
		const vault = this.panelScope === "vault";
		this.refreshBtn = null;
		const scopeBtn = header.createEl("button", {
			cls: "trouble-tags-scope",
			attr: { "aria-label": vault ? "Whole vault" : "Current note" },
		});
		setIcon(scopeBtn, vault ? "folder-open" : "file-text");
		scopeBtn.addEventListener("click", () => { void this.setScope(vault ? "note" : "vault"); });

		for (const chip of FILTER_CHIPS) {
			this.renderChip(header, chip.text, settings.filters[chip.kind], () => {
				settings.filters[chip.kind] = !settings.filters[chip.kind];
			});
		}
		this.renderChip(header, "Show done", settings.showDone, () => {
			settings.showDone = !settings.showDone;
		});

		if (vault) {
			this.renderSort(header, [["modified", "Modified"], ["created", "Created"], ["name", "Name"]],
				settings.vaultSort, (v) => { settings.vaultSort = v as VaultSort; });
			if (this.plugin.indexStore.files !== null) this.renderRefresh(header);
			if (this.renderedPaths.length > 0) this.renderFold(header);
		} else {
			this.renderSort(header, [["line", "Line"], ["label", "Label"]],
				settings.noteSort, (v) => { settings.noteSort = v as NoteSort; });
		}
	}

	private renderSort(parent: HTMLElement, options: Array<[string, string]>, current: string, apply: (value: string) => void) {
		const select = parent.createEl("select", { cls: ["trouble-tags-sort", "dropdown"], attr: { "aria-label": "Sort" } });
		for (const [value, text] of options) {
			const opt = select.createEl("option", { text, value });
			opt.selected = value === current;
		}
		select.addEventListener("change", () => {
			apply(select.value);
			void this.plugin.saveSettings();
			this.render();
		});
	}

	private foldBtn: HTMLElement | null = null;

	private anyCollapsed(): boolean {
		return this.renderedPaths.some((p) => this.collapsed.has(p));
	}

	private updateFoldBtn() {
		const btn = this.foldBtn;
		if (!btn) return;
		const expandAll = this.anyCollapsed();
		btn.setAttribute("aria-label", expandAll ? "Expand all" : "Collapse all");
		setIcon(btn, expandAll ? "chevrons-up-down" : "chevrons-down-up");
	}

	private renderRefresh(parent: HTMLElement) {
		const btn = parent.createEl("button", { cls: "trouble-tags-refresh", attr: { "aria-label": "Refresh index" } });
		setIcon(btn, "refresh-cw");
		this.refreshBtn = btn;
		this.updateRefreshBtn();
		btn.addEventListener("click", () => { void this.refreshVault(); });
	}

	private renderFold(parent: HTMLElement) {
		const btn = parent.createEl("button", { cls: "trouble-tags-fold" });
		this.foldBtn = btn;
		this.updateFoldBtn();
		btn.addEventListener("click", () => {
			if (this.anyCollapsed()) this.collapsed.clear();
			else for (const p of this.renderedPaths) this.collapsed.add(p);
			this.renderVault();
		});
	}

	private renderChip(parent: HTMLElement, text: string, active: boolean, toggle: () => void) {
		const btn = parent.createEl("button", { cls: "trouble-tags-chip", text });
		btn.toggleClass("is-active", active);
		btn.addEventListener("click", () => {
			toggle();
			void this.plugin.saveSettings();
			this.pushStatus();
			this.render();
		});
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
		return this.applyEdit(path, hit, doneReplacement, "Could not mark done");
	}

	markUndone(path: string, hit: Hit) {
		return this.applyEdit(path, hit, undoneReplacement, "Could not mark undone");
	}

	private async applyEdit(path: string, hit: Hit, replacement: EditFn, failText: string) {
		const mv = findMarkdownView(this.app, path);
		// A MarkdownView always has an editor, even in reading mode; only use it in source mode.
		if (mv && mv.getMode() === "source") {
			this.applyEditInEditor(mv.editor, path, hit, replacement);
			return;
		}
		// Reading mode or note not open: edit the file on disk.
		const file = this.app.vault.getFileByPath(path);
		if (!file) {
			new Notice("File not found");
			return;
		}
		let changed = false;
		try {
			await this.app.vault.process(file, (data) => {
				const res = applyToText(data, hit, replacement);
				changed = res.changed;
				return res.text;
			});
		} catch {
			new Notice(failText);
			return;
		}
		if (!changed) new Notice("Line changed, rescanning");
		if (path === this.currentPath) void this.scanNote(file);
		await this.updateIndexEntry(path, file.stat.mtime);
	}

	private applyEditInEditor(editor: Editor, path: string, hit: Hit, replacement: EditFn) {
		const lineText = hit.line < editor.lineCount() ? editor.getLine(hit.line) : "";
		const r = replacement(hit, lineText);
		if (r) {
			editor.replaceRange(r.insert, { line: hit.line, ch: r.from }, { line: hit.line, ch: r.to });
			if (path === this.currentPath) this.scheduleNoteScan(editor);
		} else {
			new Notice("Line changed, rescanning");
			if (path === this.currentPath) void this.scanNote(this.app.vault.getFileByPath(path), editor.getValue());
		}
		if (this.panelScope === "vault") {
			const mtime = this.app.vault.getFileByPath(path)?.stat.mtime ?? Date.now();
			void this.updateIndexEntry(path, mtime, editor.getValue());
		}
	}

	private async updateIndexEntry(path: string, mtime: number, text?: string) {
		const store = this.plugin.indexStore;
		try {
			if (!(await store.updateFile(path, mtime, text))) return;
		} catch {
			store.markDirty(path);
			return;
		}
		this.renderVault();
		this.plugin.scheduleIndexSave();
	}
}
