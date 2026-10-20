import { App } from "obsidian";
import type { IndexIO } from "./index-store";

export function createIndexIO(app: App, indexPath: string): IndexIO {
	const adapter = app.vault.adapter;
	return {
		listMarkdown: () => app.vault.getMarkdownFiles().map((f) => ({ path: f.path, mtime: f.stat.mtime })),
		readFile: async (path) => {
			const file = app.vault.getFileByPath(path);
			if (!file) throw new Error("File not found: " + path);
			return app.vault.cachedRead(file);
		},
		readIndex: async () => ((await adapter.exists(indexPath)) ? adapter.read(indexPath) : null),
		writeIndex: (json) => adapter.write(indexPath, json),
		deleteIndex: async () => {
			if (await adapter.exists(indexPath)) await adapter.remove(indexPath);
		},
		yieldToUi: () => new Promise((r) => window.setTimeout(r, 0)),
	};
}
