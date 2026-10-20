import { Plugin, ItemView, WorkspaceLeaf } from "obsidian";
import { buildScanConfig, ScanConfig } from "./scanner";
import { DEFAULT_SETTINGS, TroubleTagsSettings, TroubleTagsSettingTab } from "./settings";

const VIEW_TYPE = "trouble-tags-view";
const TAG_REGEX = /#(TODO|FIXME|BUG|NOTE|WARN)\b/g;

interface Hit {
	tag: string;
	line: number;
	context: string;
}

class TroubleView extends ItemView {
	plugin: TroubleTagsPlugin;
	results: Hit[] = [];
	currentPath: string | null = null;
	debounceTimer: number | null = null;
	rootEl: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: TroubleTagsPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() { return VIEW_TYPE; }
	getDisplayText() { return "Trouble Tags"; }
	getIcon() { return "alert-triangle"; }

	async onOpen() {
		this.contentEl.empty();
		this.rootEl = this.contentEl.createDiv({ cls: "trouble-tags-container" });
		await this.scanActiveFile();
	}

	onClose() {
		if (this.debounceTimer) window.clearTimeout(this.debounceTimer);
		return Promise.resolve();
	}

	requestRefresh() {
		if (this.debounceTimer) window.clearTimeout(this.debounceTimer);
		this.debounceTimer = window.setTimeout(() => {
			this.debounceTimer = null;
			void this.scanActiveFile();
		}, 300);
	}

	async scanActiveFile() {
		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension !== "md") {
			this.currentPath = null;
			this.results = [];
			this.renderResults();
			return;
		}

		this.currentPath = file.path;
		const content = await this.app.vault.cachedRead(file);
		const lines = content.split("\n");
		const hits: Hit[] = [];

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			TAG_REGEX.lastIndex = 0;
			let m: RegExpExecArray | null;
			while ((m = TAG_REGEX.exec(line)) !== null) {
				const tag = m[1];
				const context = line
					.substring(m.index + m[0].length)
					.replace(/^[\s:—–-]+/, "")
					.trim();
				hits.push({ tag, line: i, context: context || line.trim() });
			}
		}

		this.results = hits;
		this.renderResults();
	}

	renderResults() {
		if (!this.rootEl) return;
		this.rootEl.empty();

		if (this.currentPath) {
			const name = this.currentPath.split("/").pop();
			this.rootEl.createDiv({ cls: "trouble-tags-filename", text: name });
		}

		if (this.results.length === 0) {
			this.rootEl.createDiv({ cls: "trouble-tags-empty", text: "No tags found" });
			return;
		}

		for (const hit of this.results) {
			const row = this.rootEl.createDiv({ cls: "trouble-tags-row" });

			row.createSpan({ cls: `trouble-tags-label trouble-tags-label-${hit.tag.toLowerCase()}`, text: hit.tag });

			row.createSpan({ cls: "trouble-tags-line", text: ":" + (hit.line + 1) });
			row.createSpan({ cls: "trouble-tags-context", text: hit.context });

			row.addEventListener("click", () => this.jumpToLine(hit.line));
		}
	}

	jumpToLine(line: number) {
		const leaf = this.app.workspace.getMostRecentLeaf();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const view = leaf?.view as any;
		if (!leaf || !view || !view.editor) return;
		const editor = view.editor;
		editor.setCursor({ line, ch: 0 });
		editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
		editor.focus();
	}
}

export default class TroubleTagsPlugin extends Plugin {
	settings!: TroubleTagsSettings;
	scanConfig!: ScanConfig;

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()) as TroubleTagsSettings;
		this.scanConfig = buildScanConfig(this.settings);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	onMatchSettingsChanged() {
		this.scanConfig = buildScanConfig(this.settings);
		void this.getView()?.scanActiveFile();
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
			this.app.workspace.on("active-leaf-change", () => {
				void this.getView()?.scanActiveFile();
			})
		);

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				const view = this.getView();
				if (view && view.currentPath === file.path) {
					view.requestRefresh();
				}
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
