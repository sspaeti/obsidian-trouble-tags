const { Plugin, ItemView } = require("obsidian");

const VIEW_TYPE = "trouble-tags-view";
const TAG_REGEX = /#(TODO|FIXME|BUG|NOTE|WARN)\b/g;

const TAG_COLORS = {
	TODO:  { bg: "rgba(59,130,246,0.15)", fg: "rgb(59,130,246)" },
	FIXME: { bg: "rgba(249,115,22,0.15)", fg: "rgb(249,115,22)" },
	BUG:   { bg: "rgba(239,68,68,0.15)",  fg: "rgb(239,68,68)" },
	NOTE:  { bg: "rgba(34,197,94,0.15)",   fg: "rgb(34,197,94)" },
	WARN:  { bg: "rgba(234,179,8,0.15)",   fg: "rgb(234,179,8)" },
};

class TroubleView extends ItemView {
	constructor(leaf, plugin) {
		super(leaf);
		this.plugin = plugin;
		this.results = [];
		this.currentPath = null;
		this.debounceTimer = null;
	}

	getViewType() { return VIEW_TYPE; }
	getDisplayText() { return "Trouble Tags"; }
	getIcon() { return "alert-triangle"; }

	async onOpen() {
		this.containerEl.children[1].empty();
		this.rootEl = this.containerEl.children[1].createDiv({ cls: "trouble-tags-container" });
		await this.scanActiveFile();
	}

	onClose() {
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		return Promise.resolve();
	}

	requestRefresh() {
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = null;
			this.scanActiveFile();
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
		const hits = [];

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			TAG_REGEX.lastIndex = 0;
			let m;
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

			const label = row.createSpan({ cls: "trouble-tags-label", text: hit.tag });
			const colors = TAG_COLORS[hit.tag];
			label.style.backgroundColor = colors.bg;
			label.style.color = colors.fg;

			row.createSpan({ cls: "trouble-tags-line", text: ":" + (hit.line + 1) });
			row.createSpan({ cls: "trouble-tags-context", text: hit.context });

			row.addEventListener("click", () => this.jumpToLine(hit.line));
		}
	}

	jumpToLine(line) {
		const leaf = this.app.workspace.getMostRecentLeaf();
		if (!leaf || !leaf.view || !leaf.view.editor) return;
		const editor = leaf.view.editor;
		editor.setCursor({ line, ch: 0 });
		editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
		editor.focus();
	}
}

class TroubleTagsPlugin extends Plugin {
	async onload() {
		this.registerView(VIEW_TYPE, (leaf) => new TroubleView(leaf, this));

		this.addRibbonIcon("alert-triangle", "Trouble Tags", () => this.toggleView());

		this.addCommand({
			id: "toggle-trouble-tags",
			name: "Toggle Trouble Tags panel",
			callback: () => this.toggleView(),
		});

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				this.getView()?.scanActiveFile();
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
		this.app.workspace.detachLeavesOfType(VIEW_TYPE);
	}

	getView() {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		return leaves.length > 0 ? leaves[0].view : null;
	}

	async toggleView() {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		if (existing.length > 0) {
			existing.forEach((leaf) => leaf.detach());
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		await leaf.setViewState({ type: VIEW_TYPE, active: true });
		this.app.workspace.revealLeaf(leaf);
	}
}

module.exports = TroubleTagsPlugin;
