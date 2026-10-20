import { Notice, Platform, Plugin, TAbstractFile, TFile, normalizePath, setIcon } from "obsidian";
import { buildScanConfig, configHash, ScanConfig } from "./scanner";
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
	private openCount = 0;

	async loadSettings() {
		const data = ((await this.loadData()) ?? {}) as Partial<TroubleTagsSettings>;
		this.settings = Object.assign(structuredClone(DEFAULT_SETTINGS), data, {
			filters: Object.assign({}, DEFAULT_SETTINGS.filters, data.filters),
		});
		this.scanConfig = buildScanConfig(this.settings);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	onMatchSettingsChanged() {
		this.scanConfig = buildScanConfig(this.settings);
		this.getView()?.onConfigChanged();
		// Back to the "Build index" state; never rebuilds on its own.
		void this.runStoreOp(() => this.indexStore.invalidate()).then(() => {
			if (this.settings.scope === "vault") this.getView()?.render();
		});
	}

	applyIcon() {
		if (this.ribbonEl) setIcon(this.ribbonEl, this.settings.icon);
		this.applyStatusBar();
		// Open panel tabs pick up the new icon on their next open.
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
		this.statusEl.createSpan({ cls: "trouble-tags-status-count", text: String(this.openCount) });
	}

	updateStatus(openCount: number) {
		if (openCount === this.openCount && this.statusEl) return;
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
			hash: configHash(this.settings),
			excludedFolders: this.settings.excludedFolders,
		}));
		// Reads the cached index only; never scans the vault.
		void this.runStoreOp(() => this.indexStore.load()).then(() => this.getView()?.render());

		this.addSettingTab(new TroubleTagsSettingTab(this.app, this));
		this.registerView(VIEW_TYPE, (leaf) => new TroubleView(leaf, this));

		this.applyStatusBar();
		this.ribbonEl = this.addRibbonIcon(this.settings.icon, "Trouble Tags", () => { void this.toggleView(); });

		this.addCommand({
			id: "toggle-trouble-tags",
			name: "Toggle Trouble Tags panel",
			callback: () => { void this.toggleView(); },
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
