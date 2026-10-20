import { App, MarkdownView } from "obsidian";

export function findMarkdownView(app: App, path: string): MarkdownView | null {
	for (const leaf of app.workspace.getLeavesOfType("markdown")) {
		const view = leaf.view;
		if (view instanceof MarkdownView && view.file?.path === path) return view;
	}
	return null;
}
