# Trouble Tags v2 — design

Date: 2026-10-20
Status: approved 2026-10-20

## Intent

Trouble Tags is a sidebar panel (inspired by todo-comments.nvim) that lists "things to come back to" in a note and jumps to them on click. v1 only finds `#TODO`-style hashtags in the active note. In practice the author writes bare `TODO:` far more often than `#TODO`, also uses List Callouts (`- ? question`, `- ! important`, `- = idea`) and plain checkboxes (`- [ ] task`), and wants one place to see all of them, for the current note by default and optionally for the whole vault, so the panel can double as a lightweight TODO app. It must stay lightning fast and do nothing when the panel is closed.

## Goals

1. Find keywords with or without a hashtag: `TODO`, `#TODO`, `TODO:`, `(TODO)`, `## TODO's` all match.
2. Configurable keyword list. Default: `TODO, FIXME, BUG, NOTE, WARN, IDEA, TK`.
3. Three sources, each a toggleable filter in the panel: keywords, list callouts, checkbox tasks.
4. Two scopes: current note (default) and whole vault. Vault scope uses a small persistent index so it opens instantly after the first build.
5. "Mark done" action on a row: keyword `TODO` becomes `~~TODO~~`, task `[ ]` becomes `[x]`. Struck-through keywords and done tasks disappear from the list (unless "show done" is on).
6. Zero work while the panel is closed. Current-note scan is synchronous and sub-10ms for a 5k-line note.
7. Standard Obsidian plugin scaffold (TypeScript, esbuild) so it passes community review and is easy to maintain.

## Non-goals (v1 of this redesign)

- Inline highlighting of keywords in the editor. Possible later as an off-by-default CodeMirror decoration on visible ranges only.
- Due dates, priorities, recurring tasks, or anything the Tasks plugin does.
- Multi-vault or sync of the index. The index is a per-vault local cache and may be deleted at any time.
- SQLite or any native dependency. Plain JSON is enough and keeps the plugin mobile-compatible.
- Tim Ferriss's `ph` marker. Researched, dropped by the author.

## Anti-goals

- Any write to a note that the user did not ask for. Scanning (current note or vault) is strictly read-only via `cachedRead` / `editor.getValue()`. The only code paths that modify a note are the "Mark done" button on a row, and nothing else. The index file lives in the plugin directory, never in the vault's note tree.

- Any scan of the vault triggered by merely opening Obsidian or opening a note. Vault work happens only when the user switches the panel to vault scope.
- A panel that re-renders on every keystroke or flickers. Re-render only when the hit list actually changed.
- Reading the user's notes with anything other than Obsidian's own Vault API.

## Constraints

- Obsidian plugin API, desktop and mobile (`isDesktopOnly: false`). No Node or Electron APIs. No regex lookbehind (older iOS WebKit).
- Follow the official plugin guidelines: no global `app`, `registerEvent` for cleanup, `createDiv`/`createSpan` over innerHTML, sentence-case UI text, CSS classes only, no default hotkeys, `Vault.process` for background edits, Editor API for active-note edits.
- Plugin id stays `trouble-tags`. Version becomes `1.1.0`. `main.js` stays committed and is a release asset.
- The author's personal vault must not be used for testing by the assistant. Testing happens in a throwaway vault.

## Matching rules

All scanning is one pure function `scanText(text, config): Hit[]` with no Obsidian imports, so it is unit-testable with `node --test`.

A `Hit` is `{ line: number, kind: "keyword" | "callout" | "task", label: string, text: string, done: boolean }` where `label` is the keyword (`TODO`), callout char (`?`) or task marker, and `text` is the rest of the line trimmed of leading `:`, `-`, `—` and whitespace, falling back to the whole line.

Frontmatter (a leading `---` block) is skipped. Fenced code blocks are scanned (a `TODO` inside code is still a TODO).

### Keywords

- Case-sensitive. Keywords are matched in UPPERCASE exactly as configured, so `note` or `Note` in prose never match.
- Match mode setting: `both` (default), `hashtag only`, `bare only`.
- Word boundary on both sides. `TODO's` matches (the `'` is a boundary). `TODOS` and `MYTODO` do not.
- A keyword inside any `~~...~~` strikethrough span on the same line is a done hit: `done: true`. This covers both what "Mark done" writes (`~~TODO~~`) and a hand-struck line (`~~TODO: call bank~~`). Strikethrough spanning multiple lines is not tracked.
- A keyword in an Obsidian callout header (`> [!NOTE]`, `> [!TODO]`, `> [!BUG]`) is not a hit. Bare matching would otherwise list every callout block in the vault and "Mark done" would corrupt the header.
- One line may contain several keyword hits. Each becomes its own row.
- Regex is built once from settings and rebuilt only when settings change.

### List callouts

Same prefix rule as the List Callouts plugin: a bullet (`-`, `*`, `+`) or ordered marker (`1.`, `1)`), an optional checkbox, then one configured character, then a space.

- Configured characters setting, default `& ? ! ~ @ $ % =` (the List Callouts defaults plus `=`, which the author uses for ideas).
- Settings tab has an "Import from List Callouts" button that reads `.obsidian/plugins/obsidian-list-callouts/data.json` through the Vault adapter and copies its characters. If that file is missing, show a Notice and leave settings unchanged.
- Callouts have no done state in v1.

### Checkbox tasks

- `^\s*(?:[-*+]|\d+[.)])\s+\[(.)\]\s+(.*)`. ` ` is open, anything else is done.
- Done tasks are hidden unless the "Show done" toggle is on.
- A task line that also starts with a callout char (`- [ ] ? text`) yields one row of kind `task` with the callout char as a secondary label. Keyword hits on the same line are still separate rows.

## Scopes

### Current note (default)

- Triggered by `workspace.on("file-open")`. If the opened file's path equals the one already shown, do nothing.
- While the note is edited, `workspace.on("editor-change")` debounced at 250 ms rescans from `editor.getValue()` (no disk read).
- Non-markdown or no file: show "No file" state.
- If the serialized hit list equals the previous one, skip the DOM update.
- All listeners early-return when the panel view is not open.

### Vault

- Switched by a scope toggle in the panel header (icon button, "Current note" / "Whole vault"). The last chosen scope is remembered across restarts.
- Switching to vault scope with no index shows a "Build index" button; nothing scans until it is pressed. Pressing it builds the index: iterate `vault.getMarkdownFiles()`, skip excluded folders, `cachedRead` each file, run `scanText`, keep only files with at least one hit. Show a progress line ("Indexing 1234/8000") and render results as they arrive in batches of 200 files, yielding to the event loop between batches so the UI stays responsive.
- Index is written to `<plugin dir>/index.json` through `this.app.vault.adapter` (not `data.json`, which stays settings-only). Shape:

```json
{ "version": 1, "config": "<hash of matching settings>", "files": { "path.md": { "mtime": 0, "hits": [] } } }
```

- On plugin load, `index.json` is read asynchronously but nothing is scanned. If `config` does not match current settings the index is discarded.
- On switching to vault scope with an index present: compare `file.stat.mtime` of every markdown file to the cached mtime, rescan only new or changed files, drop deleted ones. This is a metadata-only pass and takes milliseconds for thousands of files.
- Keeping it fresh: `vault.on("modify" | "delete" | "rename")` update the one affected entry if the panel is open in vault scope. If the panel is closed or in current-note scope, the path is added to a dirty set and rescanned on the next switch to vault scope.
- Writes to `index.json` are debounced at 2 s and skipped if nothing changed.
- Vault view groups rows by file, newest `mtime` first, collapsible per file, with the file name as header and hit count. Rows above 500 are hidden behind a "Show more" row.
- Settings has "Excluded folders" (one per line, default empty) and a "Rebuild index" button.

## Panel UI

Top to bottom:

1. Header row: scope toggle, three filter chips (Keywords, Callouts, Tasks) that persist their on/off state, "Show done" toggle, and the active file name (current-note scope only).
2. Rows. Each row: colored label pill, optional secondary pill, line number (current scope) or file name (vault scope), the text, and on hover a check button ("Mark done").
3. Empty state: "Nothing found" and, in vault scope before the index exists, a "Build index" button instead of auto-building.

Row click: jump to the line. For the active note use the markdown view for that path and `editor.setCursor` + `scrollIntoView`. For another file (vault scope) or a note open in reading mode, `workspace.getLeaf(false).openFile(file, { eState: { line } })`.

Mark done:
- Keyword: wrap the matched keyword token (including `#` if present) in `~~`.
- Task: replace `[ ]` with `[x]`.
- Active note: `editor.replaceRange` on the exact character range. Other files: `Vault.process` with a callback that re-finds the line by its text. If the line no longer contains the hit, show a Notice and rescan instead of editing.
- Callouts: no done action; the button is hidden.

Colors: keep the existing five keyword colors. `IDEA` purple, `TK` grey. Custom keywords beyond the defaults cycle through a fixed 6-color palette. Callout rows use the configured char as label with a neutral tint. Tasks use the accent color.

Builder notes: `Hit` carries the character offset of the matched token so "Mark done" can use `replaceRange`. `#TODO` in bare-only mode is not a hit. The index stores done hits too, so toggling "Show done" needs no rescan.

Optional status bar item (setting, off by default): shows the current note's open hit count, click toggles the panel. Mobile has no status bar, so it is simply absent there.

## Settings tab

Order, no top-level heading:

1. Keywords (text, comma separated). Default `TODO, FIXME, BUG, NOTE, WARN, IDEA, TK`.
2. Keyword match (dropdown): Hashtag and bare / Hashtag only / Bare only.
3. Callout characters (text, space separated). Default `& ? ! ~ @ $ % =`. Button: Import from List Callouts.
4. Show done items (toggle, off).
5. Status bar count (toggle, off).
6. Heading "Vault index": Excluded folders (textarea), Rebuild index (button), Clear index (button).

Changing any matching setting rebuilds the regexes, rescans the current note, and invalidates the vault index. An invalidated or cleared index puts vault scope back into the "Build index" state; it never triggers a vault scan on its own.

## Project layout and tooling

Match the official sample plugin:

```
src/main.ts          plugin, view, settings tab
src/scanner.ts       scanText and regex builders, no obsidian import
src/index-store.ts   vault index: build, refresh, load, save
test/scanner.test.ts node --test unit tests for every matching rule above
esbuild.config.mjs, tsconfig.json, package.json, version-bump.mjs
main.js              built output, committed
manifest.json, versions.json, styles.css, README.md, LICENSE
```

`npm run dev` watches, `npm run build` type-checks and bundles, `npm test` runs the scanner tests. README is updated with the new features, settings, and a note that the index file is a disposable cache.

## Verification

- Unit tests for the scanner cover: every keyword form listed under Goals, lowercase non-matches, `~~` done detection, hashtag-only and bare-only modes, callout prefixes for bullets, ordered lists and checkboxes, task open/done, frontmatter skipping, a line with keyword plus callout plus task.
- Manual check in the throwaway vault `/home/sspaeti/git/obsidian/trouble-tags-testvault` (exists, empty; the builder generates test notes there and symlinks this repo into its `.obsidian/plugins/trouble-tags`) via the Obsidian CLI (`obsidian vault=<test vault> plugin:reload id=trouble-tags`, `dev:errors`, `dev:screenshot`) for: panel open/close, scope toggle, index build on a vault with a few hundred generated notes, mark done in active and non-active files, jump to line in editing and reading mode.
- Timing: log nothing by default. During development, measure `scanText` on a 5k-line note and the vault refresh pass with `performance.now()` and remove the logs before release.

## Left to the builder

- Exact DOM structure and CSS beyond the classes already in `styles.css`.
- Debounce values may be tuned between 150 ms and 500 ms.
- Batch size and yielding strategy during the initial index build.
- Whether `index.json` compresses hit text or stores it as-is (storing as-is is fine up to tens of thousands of hits).
- Palette colors for custom keywords.
