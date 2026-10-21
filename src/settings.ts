import { App, Notice, PluginSettingTab, Setting, normalizePath, requireApiVersion, setIcon } from "obsidian";
import type { SettingControl, SettingDefinitionItem } from "obsidian";
import type TroubleTagsPlugin from "./main";
import type { MatchSettings } from "./scanner";
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

interface ControlRow {
	name: string;
	desc: string;
	/** Bound to a settings key through getControlValue / setControlValue. */
	control: SettingControl;
}

interface RenderRow {
	name: string;
	desc: string;
	render: (setting: Setting) => void;
}

type Row = ControlRow | RenderRow;

interface Section {
	heading?: string;
	rows: Row[];
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/**
 * One row list feeds both renderers: getSettingDefinitions() for Obsidian
 * 1.13+ (settings search) and display() for older versions.
 */
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

	private sections(): Section[] {
		return [
			{
				rows: [
					{
						name: "Keywords",
						desc: "Comma separated. Matched in upper case.",
						render: (setting) => this.renderKeywords(setting),
					},
					{
						name: "Keyword match",
						desc: "Whether keywords need a hashtag.",
						control: {
							type: "dropdown",
							key: "keywordMode",
							options: { both: "Hashtag and bare", hashtag: "Hashtag only", bare: "Bare only" },
						},
					},
					{
						name: "Callout characters",
						desc: "Space separated, single characters at the start of a list item.",
						render: (setting) => this.renderCalloutChars(setting),
					},
					{
						name: "Show done items",
						desc: "Include completed tasks and struck-through keywords.",
						control: { type: "toggle", key: "showDone" },
					},
					{
						name: "Status bar count",
						desc: "Show the number of open items in the status bar.",
						control: { type: "toggle", key: "statusBar" },
					},
					{
						name: "Icon",
						desc: "Icon of the ribbon button and the panel tab.",
						render: (setting) => this.renderIcon(setting),
					},
				],
			},
			{
				heading: "Vault index",
				rows: [
					{
						name: "Excluded folders",
						desc: "One folder path per line. Skipped when building the index.",
						render: (setting) => this.renderExcludedFolders(setting),
					},
					{
						name: "Rebuild index",
						desc: "Discard the cached index. Builds it again right away only if the panel shows the whole vault; otherwise the panel offers a Build index button next time.",
						render: (setting) => {
							setting.addButton((btn) =>
								btn.setButtonText("Rebuild index").onClick(async () => {
									const plugin = this.plugin;
									await plugin.runStoreOp(() => plugin.indexStore.invalidate());
									const view = plugin.getView();
									if (view && plugin.settings.scope === "vault") void view.buildIndex();
								})
							);
						},
					},
					{
						name: "Clear index",
						desc: "Delete the cached index.",
						render: (setting) => {
							setting.addButton((btn) =>
								btn.setButtonText("Clear index").onClick(async () => {
									const plugin = this.plugin;
									await plugin.runStoreOp(() => plugin.indexStore.invalidate());
									plugin.getView()?.render();
								})
							);
						},
					},
				],
			},
		];
	}

	// Obsidian 1.13+: rendered declaratively and indexed for settings search.
	getSettingDefinitions(): SettingDefinitionItem[] {
		return this.sections().map((section) => ({
			type: "group",
			heading: section.heading,
			items: section.rows.map((row) =>
				"control" in row
					? { name: row.name, desc: row.desc, control: row.control }
					: { name: row.name, desc: row.desc, render: (setting: Setting) => { row.render(setting); } }
			),
		}));
	}

	// Obsidian < 1.13: not called when getSettingDefinitions() returns rows.
	display(): void {
		this.renderAll();
	}

	private renderAll(): void {
		const { containerEl } = this;
		containerEl.empty();
		for (const section of this.sections()) {
			if (section.heading) new Setting(containerEl).setName(section.heading).setHeading();
			for (const row of section.rows) {
				const setting = new Setting(containerEl).setName(row.name).setDesc(row.desc);
				if ("render" in row) row.render(setting);
				else this.addControl(setting, row.control);
			}
		}
	}

	private addControl(setting: Setting, control: SettingControl): void {
		const { key } = control;
		const value = this.getControlValue(key);
		const save = (v: unknown) => { void this.setControlValue(key, v); };
		switch (control.type) {
			case "toggle":
				setting.addToggle((tg) => tg.setValue(value === true).onChange(save));
				break;
			case "dropdown":
				setting.addDropdown((dd) => {
					for (const [k, label] of Object.entries(control.options)) dd.addOption(k, label);
					dd.setValue(asString(value)).onChange(save);
				});
				break;
			case "text":
				setting.addText((t) => t.setPlaceholder(control.placeholder ?? "").setValue(asString(value)).onChange(save));
				break;
			case "textarea":
				setting.addTextArea((t) => t.setPlaceholder(control.placeholder ?? "").setValue(asString(value)).onChange(save));
				break;
			default:
				break;
		}
	}

	/** Re-render the tab after a change made outside a control. */
	private refresh(): void {
		if (requireApiVersion("1.13.0")) this.update();
		else this.renderAll();
	}

	getControlValue(key: string): unknown {
		const s = this.plugin.settings;
		switch (key) {
			case "keywordMode": return s.keywordMode;
			case "showDone": return s.showDone;
			case "statusBar": return s.statusBar;
			case "icon": return s.icon;
			default: return undefined;
		}
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const plugin = this.plugin;
		const s = plugin.settings;
		switch (key) {
			case "keywordMode":
				if (value === "both" || value === "hashtag" || value === "bare") s.keywordMode = value;
				await plugin.saveSettings();
				plugin.onMatchSettingsChanged();
				return;
			case "showDone":
				s.showDone = value === true;
				await plugin.saveSettings();
				// Done hits are kept in the index; only the view filter changes.
				plugin.getView()?.render();
				return;
			case "statusBar":
				s.statusBar = value === true;
				await plugin.saveSettings();
				plugin.applyStatusBar();
				return;
			case "icon":
				s.icon = asString(value) || DEFAULT_SETTINGS.icon;
				await plugin.saveSettings();
				await plugin.applyIcon();
				return;
			default:
				return;
		}
	}

	private renderKeywords(setting: Setting): void {
		const plugin = this.plugin;
		setting.addText((text) =>
			text
				.setPlaceholder(DEFAULT_SETTINGS.keywords.join(", "))
				.setValue(plugin.settings.keywords.join(", "))
				.onChange(async (value) => {
					plugin.settings.keywords = parseKeywords(value);
					await plugin.saveSettings();
					plugin.onMatchSettingsChanged();
				})
		);
	}

	private renderCalloutChars(setting: Setting): void {
		const plugin = this.plugin;
		setting
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
					this.refresh();
				})
			);
	}

	private renderIcon(setting: Setting): void {
		const plugin = this.plugin;
		const preview = setting.controlEl.createSpan({ cls: "trouble-tags-icon-preview" });
		setIcon(preview, plugin.settings.icon);
		setting.addDropdown((dd) => {
			for (const [value, label] of ICON_OPTIONS) dd.addOption(value, label);
			dd.setValue(plugin.settings.icon).onChange(async (value) => {
				setIcon(preview, value);
				await this.setControlValue("icon", value);
			});
		});
	}

	private renderExcludedFolders(setting: Setting): void {
		const plugin = this.plugin;
		setting.addTextArea((ta) =>
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
