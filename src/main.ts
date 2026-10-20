import { Plugin, TFile } from "obsidian";
import { buildScanConfig, ScanConfig } from "./scanner";
import { DEFAULT_SETTINGS, TroubleTagsSettings, TroubleTagsSettingTab } from "./settings";
import { TroubleView, VIEW_TYPE } from "./view";
import { findMarkdownView } from "./workspace";

export default class TroubleTagsPlugin extends Plugin {
	settings!: TroubleTagsSettings;
	scanConfig!: ScanConfig;

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
	}

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new TroubleTagsSettingTab(this.app, this));
		this.registerView(VIEW_TYPE, (leaf) => new TroubleView(leaf, this));

		this.addRibbonIcon("alert-triangle", "Trouble Tags", () => { void this.toggleView(); });

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
				const view = this.getView();
				if (!view) return;
				if (!(file instanceof TFile) || file.path !== view.currentPath) return;
				// An open editor already drives rescans through editor-change.
				if (findMarkdownView(this.app, file.path)) return;
				void view.scanNote(file);
			})
		);
	}

	onunload() {
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
	}
}
