import { Editor, Notice, Platform, Plugin, TAbstractFile, TFile, normalizePath, setIcon } from "obsidian";
import { Hit, buildScanConfig, configHash, ScanConfig, scanText } from "./scanner";
import { Direction, neighbourHit } from "./navigate";
import { DEFAULT_SETTINGS, TroubleTagsSettings, TroubleTagsSettingTab } from "./settings";
import { IndexStore } from "./index-store";
import { createIndexIO } from "./index-io";
import { TroubleView, VIEW_TYPE } from "./view";
import { findMarkdownView } from "./workspace";

const INDEX_SAVE_DELAY = 2000;

export default class TroubleTagsPlugin extends Plugin {
	settings!: TroubleTagsSettings;
	scanConfig!: ScanConfig;
	indexStore!: IndexStore;
	indexBuilding = false;
	private storeQueue: Promise<void> = Promise.resolve();
	private saveTimer: number | null = null;
	private ribbonEl: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;
	private openCount: number | null = null;
	/** configHash of the match settings, recomputed only when they change. */
	private matchHash = "";
	/** Excluded folders the index was last configured with (JSON), to detect real changes. */
	private excludedKey = "";
	private unloaded = false;
	/** Stop check for long index passes: true once the plugin is disabled. */
	readonly shouldStop = (): boolean => this.unloaded;

	async loadSettings() {
		const data = ((await this.loadData()) ?? {}) as Partial<TroubleTagsSettings>;
		this.settings = Object.assign(structuredClone(DEFAULT_SETTINGS), data, {
			filters: Object.assign({}, DEFAULT_SETTINGS.filters, data.filters),
		});
		this.scanConfig = buildScanConfig(this.settings);
		this.matchHash = configHash(this.settings);
		this.excludedKey = JSON.stringify(this.settings.excludedFolders);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	onMatchSettingsChanged() {
		this.scanConfig = buildScanConfig(this.settings);
		this.getView()?.onConfigChanged();
		const hash = configHash(this.settings);
		const excludedKey = JSON.stringify(this.settings.excludedFolders);
		if (hash === this.matchHash && excludedKey === this.excludedKey) return;
		this.matchHash = hash;
		this.excludedKey = excludedKey;
		// Back to the "Build index" state; never rebuilds on its own.
		void this.runStoreOp(() => this.indexStore.invalidate()).then(() => {
			if (this.settings.scope === "vault") this.getView()?.render();
		});
	}

	async applyIcon(): Promise<void> {
		if (this.ribbonEl) setIcon(this.ribbonEl, this.settings.icon);
		this.applyStatusBar();
		// Re-create open panel leaves so the tab header re-reads getIcon().
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			try {
				await leaf.setViewState({ type: VIEW_TYPE, active: false });
			} catch {
				// The next open picks the icon up anyway.
			}
		}
	}

	/** Creates or removes the status bar item to match the setting. No-op on mobile. */
	applyStatusBar() {
		if (!this.settings.statusBar || Platform.isMobile) {
			this.statusEl?.remove();
			this.statusEl = null;
			return;
		}
		if (!this.statusEl) {
			this.statusEl = this.addStatusBarItem();
			this.statusEl.addClass("trouble-tags-status", "mod-clickable");
			this.statusEl.addEventListener("click", () => { void this.toggleView(); });
		}
		this.statusEl.empty();
		setIcon(this.statusEl.createSpan({ cls: "trouble-tags-status-icon" }), this.settings.icon);
		this.statusEl.createSpan({ cls: "trouble-tags-status-count", text: this.openCount === null ? "–" : String(this.openCount) });
	}

	/** Open item count of the current note; null while the panel is closed (shown as an en dash). */
	updateStatus(openCount: number | null) {
		if (openCount === this.openCount) return;
		this.openCount = openCount;
		if (this.statusEl) this.applyStatusBar();
	}

	/** Serializes whole-index operations (load, build, refresh, invalidate, save). */
	runStoreOp(fn: () => Promise<void>): Promise<void> {
		const run = this.storeQueue.then(fn).catch(() => {
			new Notice("Trouble Tags: index operation failed");
		});
		this.storeQueue = run;
		return run;
	}

	scheduleIndexSave() {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.runStoreOp(() => this.indexStore.save());
		}, INDEX_SAVE_DELAY);
	}

	async onload() {
		await this.loadSettings();
		const indexPath = normalizePath(`${this.manifest.dir}/index.json`);
		this.indexStore = new IndexStore(createIndexIO(this.app, indexPath), () => ({
			scan: this.scanConfig,
			hash: this.matchHash,
			excludedFolders: this.settings.excludedFolders,
		}));
		// Reads the cached index only; never scans the vault.
		void this.runStoreOp(() => this.indexStore.load()).then(() => this.getView()?.render());

		this.addSettingTab(new TroubleTagsSettingTab(this.app, this));
		this.registerView(VIEW_TYPE, (leaf) => new TroubleView(leaf, this));

		this.applyStatusBar();
		this.ribbonEl = this.addRibbonIcon(this.settings.icon, "Trouble Tags", () => { void this.toggleView(); });

		this.addCommand({
			id: "toggle-panel",
			name: "Toggle panel",
			callback: () => { void this.toggleView(); },
		});
		this.addCommand({
			id: "toggle-scope",
			name: "Toggle scope (current note / whole vault)",
			callback: () => { void this.toggleScope(); },
		});
		this.addCommand({
			id: "next-item",
			name: "Jump to next item in note",
			editorCallback: (editor) => this.jumpToNeighbour(editor, 1),
		});
		this.addCommand({
			id: "previous-item",
			name: "Jump to previous item in note",
			editorCallback: (editor) => this.jumpToNeighbour(editor, -1),
		});

		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				const view = this.getView();
				if (!view) return;
				if (file?.path !== view.currentPath) void view.scanNote(file);
			})
		);

		this.registerEvent(
			this.app.workspace.on("editor-change", (editor, info) => {
				const view = this.getView();
				if (!view) return;
				if (info.file?.path === view.currentPath) view.scheduleNoteScan(editor);
			})
		);

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (!(file instanceof TFile) || file.extension !== "md") return;
				const view = this.getView();
				// An open editor already drives note rescans through editor-change.
				if (view && file.path === view.currentPath && !findMarkdownView(this.app, file.path)) {
					void view.scanNote(file);
				}
				void this.onIndexModify(file);
			})
		);

		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (!this.isIndexable(file)) return;
				if (this.indexStore.removeFile(file.path)) this.onIndexChanged();
			})
		);

		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (!this.isIndexable(file)) return;
				const files = this.indexStore.files;
				if (files === null) return;
				const had = oldPath in files;
				this.indexStore.renameFile(oldPath, file.path);
				if (had) {
					this.onIndexChanged();
				} else if (file instanceof TFile && file.extension === "md" && !this.indexStore.isExcluded(file.path)) {
					// Moved in from an excluded folder (or renamed to .md): index it like a modify.
					void this.onIndexModify(file);
				}
			})
		);
	}

	/** True when an index exists to keep fresh. During a build, marks the path dirty instead. */
	private isIndexable(file: TAbstractFile): boolean {
		if (!(file instanceof TFile)) return false;
		if (this.indexStore.files === null) {
			if (this.indexBuilding) this.indexStore.markDirty(file.path);
			return false;
		}
		return true;
	}

	private async onIndexModify(file: TFile) {
		if (!this.isIndexable(file)) return;
		const store = this.indexStore;
		const view = this.getView();
		if (!view || this.settings.scope !== "vault") {
			store.markDirty(file.path);
			return;
		}
		let changed = false;
		try {
			changed = await store.updateFile(file.path, file.stat.mtime);
		} catch {
			store.markDirty(file.path);
			return;
		}
		if (changed) this.onIndexChanged();
	}

	private onIndexChanged() {
		if (this.settings.scope === "vault") this.getView()?.renderVault();
		this.scheduleIndexSave();
	}

	onunload() {
		// A running build or refresh sees this and abandons its pass without saving.
		this.unloaded = true;
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
			void this.indexStore.save().catch(() => {});
		}
	}

	getView(): TroubleView | null {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		if (leaves.length > 0 && leaves[0].view instanceof TroubleView) {
			return leaves[0].view;
		}
		return null;
	}

	/** Panel filters applied to a hit: source chips and "Show done". */
	isVisibleHit(hit: Hit): boolean {
		const { filters, showDone } = this.settings;
		return filters[hit.kind] && (showDone || !hit.done);
	}

	/** Move the cursor to the next or previous visible hit in the editor, wrapping around. */
	jumpToNeighbour(editor: Editor, dir: Direction) {
		const hits = scanText(editor.getValue(), this.scanConfig).filter((h) => this.isVisibleHit(h));
		const hit = neighbourHit(hits, editor.getCursor(), dir);
		if (!hit) {
			new Notice("Trouble Tags: nothing found in this note");
			return;
		}
		const pos = { line: hit.line, ch: hit.from };
		editor.setCursor(pos);
		editor.scrollIntoView({ from: pos, to: pos }, true);
	}

	/** Flip the panel between note and vault scope, opening it first if needed. */
	async toggleScope() {
		if (!this.getView()) await this.toggleView();
		const view = this.getView();
		if (!view) return;
		await view.setScope(view.panelScope === "vault" ? "note" : "vault");
	}

	async toggleView() {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		if (existing.length > 0) {
			existing.forEach((leaf) => leaf.detach());
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: VIEW_TYPE, active: true });
		void this.app.workspace.revealLeaf(leaf);
		// Opened by the user: catch up on changes made while the panel was closed.
		void this.getView()?.refreshVault();
	}
}
