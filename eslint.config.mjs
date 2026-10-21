import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: {
					allowDefaultProject: ["eslint.config.*"],
				},
			},
		},
	},
	{
		ignores: ["main.js", "node_modules/", "scripts/", "test/", "version-bump.mjs", "esbuild.config.mjs", "docs/"],
	},
]);
