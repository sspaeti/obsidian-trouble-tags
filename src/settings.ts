import { App, Notice, PluginSettingTab, Setting, normalizePath, setIcon } from "obsidian";
import type TroubleTagsPlugin from "./main";
import type { KeywordMode, MatchSettings } from "./scanner";
import { parseCalloutChars, parseKeywords } from "./parse";
import type { NoteSort, VaultSort } from "./sort";

export interface TroubleTagsSettings extends MatchSettings {
	showDone: boolean;
	statusBar: boolean;
	icon: string;
	excludedFolders: string[];
	scope: "note" | "vault";
	filters: { keyword: boolean; callout: boolean; task: boolean };
	/** Set from the panel header, not the settings tab. */
	vaultSort: VaultSort;
	noteSort: NoteSort;
}

export const DEFAULT_SETTINGS: TroubleTagsSettings = {
	keywords: ["TODO", "FIXME", "BUG", "NOTE", "WARN", "IDEA", "TK"],
	keywordMode: "both",
	calloutChars: ["&", "?", "!", "~", "@", "$", "%", "="],
	showDone: false,
	statusBar: false,
	icon: "list-todo",
	excludedFolders: [],
	scope: "note",
	filters: { keyword: true, callout: true, task: true },
	vaultSort: "modified",
	noteSort: "line",
};

const EXCLUDE_APPLY_DELAY = 800;

const ICON_OPTIONS: Array<[string, string]> = [
	["list-todo", "List todo"],
	["list-checks", "List checks"],
	["alert-triangle", "Alert triangle"],
	["traffic-cone", "Traffic cone"],
	["siren", "Siren"],
	["flag", "Flag"],
	["radar", "Radar"],
];

export class TroubleTagsSettingTab extends PluginSettingTab {
	plugin: TroubleTagsPlugin;
	private excludeTimer: number | null = null;
	private excludeApply: (() => void) | null = null;

	constructor(app: App, plugin: TroubleTagsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	hide(): void {
		// Apply a pending excluded-folders edit now so nothing fires later and no edit is lost.
		if (this.excludeApply) {
			if (this.excludeTimer !== null) window.clearTimeout(this.excludeTimer);
			this.excludeTimer = null;
			const apply = this.excludeApply;
			this.excludeApply = null;
			apply();
		}
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const plugin = this.plugin;

		new Setting(containerEl)
			.setName("Keywords")
			.setDesc("Comma separated. Matched in upper case.")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.keywords.join(", "))
					.setValue(plugin.settings.keywords.join(", "))
					.onChange(async (value) => {
						plugin.settings.keywords = parseKeywords(value);
						await plugin.saveSettings();
						plugin.onMatchSettingsChanged();
					})
			);

		new Setting(containerEl)
			.setName("Keyword match")
			.setDesc("Whether keywords need a hashtag.")
			.addDropdown((dd) =>
				dd
					.addOption("both", "Hashtag and bare")
					.addOption("hashtag", "Hashtag only")
					.addOption("bare", "Bare only")
					.setValue(plugin.settings.keywordMode)
					.onChange(async (value) => {
						plugin.settings.keywordMode = value as KeywordMode;
						await plugin.saveSettings();
						plugin.onMatchSettingsChanged();
					})
			);

		new Setting(containerEl)
			.setName("Callout characters")
			.setDesc("Space separated, single characters at the start of a list item.")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.calloutChars.join(" "))
					.setValue(plugin.settings.calloutChars.join(" "))
					.onChange(async (value) => {
						plugin.settings.calloutChars = parseCalloutChars(value);
						await plugin.saveSettings();
						plugin.onMatchSettingsChanged();
					})
			)
			.addButton((btn) =>
				btn.setButtonText("Import from List Callouts").onClick(async () => {
					const chars = await this.readListCallouts();
					if (!chars) {
						new Notice("List Callouts settings not found");
						return;
					}
					plugin.settings.calloutChars = chars;
					await plugin.saveSettings();
					plugin.onMatchSettingsChanged();
					this.display();
				})
			);

		new Setting(containerEl)
			.setName("Show done items")
			.setDesc("Include completed tasks and struck-through keywords.")
			.addToggle((tg) =>
				tg.setValue(plugin.settings.showDone).onChange(async (value) => {
					plugin.settings.showDone = value;
					await plugin.saveSettings();
					// Done hits are kept in the index; only the view filter changes.
					plugin.getView()?.render();
				})
			);

		new Setting(containerEl)
			.setName("Status bar count")
			.setDesc("Show the number of open items in the status bar.")
			.addToggle((tg) =>
				tg.setValue(plugin.settings.statusBar).onChange(async (value) => {
					plugin.settings.statusBar = value;
					await plugin.saveSettings();
					plugin.applyStatusBar();
				})
			);

		const iconSetting = new Setting(containerEl)
			.setName("Icon")
			.setDesc("Icon of the ribbon button and the panel tab.");
		const preview = iconSetting.controlEl.createSpan({ cls: "trouble-tags-icon-preview" });
		setIcon(preview, plugin.settings.icon);
		iconSetting.addDropdown((dd) => {
			for (const [value, label] of ICON_OPTIONS) dd.addOption(value, label);
			dd.setValue(plugin.settings.icon).onChange(async (value) => {
				plugin.settings.icon = value;
				await plugin.saveSettings();
				setIcon(preview, value);
				await plugin.applyIcon();
			});
		});

		new Setting(containerEl).setName("Vault index").setHeading();

		new Setting(containerEl)
			.setName("Excluded folders")
			.setDesc("One folder path per line. Skipped when building the index.")
			.addTextArea((ta) =>
				ta
					.setValue(plugin.settings.excludedFolders.join("\n"))
					.onChange((value) => {
						// Applying invalidates the index, so wait until typing pauses.
						if (this.excludeTimer !== null) window.clearTimeout(this.excludeTimer);
						this.excludeApply = () => {
							plugin.settings.excludedFolders = value
								.split("\n")
								.map((l) => l.trim())
								.filter((l) => l.length > 0)
								// normalizePath strips leading and trailing slashes; the replace is a fallback.
								.map((l) => normalizePath(l).replace(/^\/+|\/+$/g, ""))
								.filter((l) => l.length > 0);
							void plugin.saveSettings();
							plugin.onMatchSettingsChanged();
						};
						this.excludeTimer = window.setTimeout(() => {
							this.excludeTimer = null;
							const apply = this.excludeApply;
							this.excludeApply = null;
							apply?.();
						}, EXCLUDE_APPLY_DELAY);
					})
			);

		new Setting(containerEl)
			.setName("Rebuild index")
			.setDesc("Discard the cached index. Builds it again right away only if the panel shows the whole vault; otherwise the panel offers a Build index button next time.")
			.addButton((btn) =>
				btn.setButtonText("Rebuild index").onClick(async () => {
					await plugin.runStoreOp(() => plugin.indexStore.invalidate());
					const view = plugin.getView();
					if (view && plugin.settings.scope === "vault") void view.buildIndex();
				})
			);

		new Setting(containerEl)
			.setName("Clear index")
			.setDesc("Delete the cached index.")
			.addButton((btn) =>
				btn.setButtonText("Clear index").onClick(async () => {
					await plugin.runStoreOp(() => plugin.indexStore.invalidate());
					plugin.getView()?.render();
				})
			);
	}

	private async readListCallouts(): Promise<string[] | null> {
		const path = `${this.app.vault.configDir}/plugins/obsidian-list-callouts/data.json`;
		try {
			const adapter = this.app.vault.adapter;
			if (!(await adapter.exists(path))) return null;
			const data = JSON.parse(await adapter.read(path)) as { callouts?: unknown };
			if (!Array.isArray(data.callouts)) return null;
			const chars: string[] = [];
			for (const c of data.callouts) {
				const ch = (c as { char?: unknown } | null)?.char;
				if (typeof ch === "string" && Array.from(ch).length === 1 && chars.indexOf(ch) === -1) chars.push(ch);
			}
			return chars.length > 0 ? chars : null;
		} catch {
			return null;
		}
	}
}
