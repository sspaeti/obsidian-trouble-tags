# Trouble Tags v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Trouble Tags sidebar so it finds bare and hashtag keywords, list callouts and checkbox tasks in the current note or (on demand) the whole vault, with a mark-done action, on a standard TypeScript plugin scaffold.

**Architecture:** A pure scanner (`scanText`) turns note text into `Hit[]` and is the only matching logic. A view renders hits for one of two scopes; current-note scope rescans from the editor, vault scope reads from an `IndexStore` that persists a JSON index in the plugin folder and is updated incrementally. The plugin class only wires events, settings and commands.

**Tech Stack:** TypeScript 5, esbuild (official sample layout), Obsidian API, `node --test` with Node's built-in type stripping for unit tests (no test framework).

**Spec:** `docs/superpowers/specs/2026-10-20-trouble-tags-v2-design.md`

## Global Constraints

- Plugin id `trouble-tags`, version `1.1.0`, `minAppVersion` `1.4.0`, `isDesktopOnly: false`.
- No Node/Electron APIs in `src/`. No regex lookbehind anywhere.
- No TS runtime-only syntax (`enum`, `namespace`, parameter properties) in `src/scanner.ts` or `src/index-store.ts`, so Node can strip types and run the tests.
- Obsidian guidelines: `this.app` only, `registerEvent`/`registerDomEvent`, `createDiv`/`createSpan`/`empty()`, no inline styles, sentence-case UI text, `setHeading()` for settings headings, no default hotkeys, `Vault.process` for non-active edits.
- Scanning never writes to a note. Only `markDone` writes, and only to the one hit's line.
- Vault index is never built without the user pressing "Build index".
- Never touch `/home/sspaeti/Simon/SecondBrain`. All in-app testing uses `obsidian vault=trouble-tags-testvault ...`.
- Commit after every task with a conventional-commit message.

## Review Focus

1. A single unbalanced `~~` on a line (`~~TODO fix this`) must not mark the keyword done. Test in Task 2.
2. `- [ ] TODO: call bank` must yield two rows (task + keyword) and marking the keyword done must not touch the checkbox. Test in Task 3.
3. Excluded folder `templates` must skip `templates/x.md` but not `templates-old/x.md`. Test in Task 6.
4. A file modified or deleted while the panel is closed must be reflected after the next "Whole vault" switch, without a full rebuild. Test in Task 6.
5. "Mark done" when the line changed since the last scan must show a Notice and rescan, never edit a wrong range. Manual check in Task 8; guard asserted by the `replaceToken` unit test in Task 5.

---

### Task 1: TypeScript scaffold, v1 behaviour preserved

**Files:**
- Create: `package.json`, `tsconfig.json`, `esbuild.config.mjs`, `version-bump.mjs`, `.gitignore`, `.npmrc`, `src/main.ts`
- Modify: `manifest.json` (version `1.1.0`, minAppVersion `1.4.0`), `versions.json` (add `"1.1.0": "1.4.0"`)
- Keep: `main.js` (now build output, still committed)

**Interfaces:**
- Produces: `npm run build` → `main.js`; `npm run dev` watch; `npm test` → `node --test "test/**/*.test.ts"`.

- [ ] **Step 1: Create `package.json`** with `"type": "module"`, scripts `dev: node esbuild.config.mjs`, `build: tsc -noEmit -skipLibCheck && node esbuild.config.mjs production`, `test: node --test "test/**/*.test.ts"`, `version: node version-bump.mjs && git add manifest.json versions.json`. devDependencies: `obsidian@latest`, `typescript@^5.8.3`, `esbuild@0.25.5`, `@types/node@^22.15.17`, `tslib@2.4.0`, `builtin-modules@3.3.0`.
- [ ] **Step 2: Create `tsconfig.json`**: `target ES2021`, `module ESNext`, `moduleResolution bundler`, `strict true`, `noImplicitAny true`, `allowImportingTsExtensions true`, `noEmit true`, `isolatedModules true`, `lib ["DOM","ES2021"]`, `include ["src/**/*.ts","test/**/*.ts"]`.
- [ ] **Step 3: Create `esbuild.config.mjs`** as in the official sample: entry `src/main.ts`, out `main.js`, cjs, target es2021, externals `obsidian, electron, @codemirror/*, @lezer/*` plus `builtin-modules`; `production` arg → minify, no sourcemap, single build; else inline sourcemap + watch.
- [ ] **Step 4: Create `version-bump.mjs`** (sample version: copies `npm_package_version` into `manifest.json` and `versions.json`), `.gitignore` (`node_modules/`, `*.map`, `.DS_Store`), `.npmrc` (`tag-version-prefix=""`).
- [ ] **Step 5: Port `main.js` to `src/main.ts`** 1:1 with types (`import { Plugin, ItemView, WorkspaceLeaf, TFile } from "obsidian"`). Use `this.contentEl` instead of `containerEl.children[1]`. No behaviour change.
- [ ] **Step 6: Install and build**. Run: `npm install && npm run build`. Expected: exit 0, `main.js` regenerated, starts with the esbuild banner.
- [ ] **Step 7: Smoke in test vault**. Run:
  ```bash
  mkdir -p /home/sspaeti/git/obsidian/trouble-tags-testvault/.obsidian/plugins
  ln -sfn /home/sspaeti/git/obsidian/obsidian-trouble-tags /home/sspaeti/git/obsidian/trouble-tags-testvault/.obsidian/plugins/trouble-tags
  obsidian vault=trouble-tags-testvault plugin:enable id=trouble-tags
  obsidian vault=trouble-tags-testvault plugin:reload id=trouble-tags
  obsidian vault=trouble-tags-testvault dev:errors
  ```
  Expected: no errors listed.
- [ ] **Step 8: Commit** `build: move to TypeScript + esbuild scaffold`.

---

### Task 2: Scanner — keywords

**Files:**
- Create: `src/scanner.ts`, `test/scanner.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type HitKind = "keyword" | "callout" | "task";
  export interface Hit {
    line: number;        // 0-based
    kind: HitKind;
    label: string;       // "TODO" | "?" | "task"
    secondary?: string;  // callout char on a task row
    text: string;        // trimmed context, falls back to whole trimmed line
    done: boolean;
    from: number;        // char offset of token start in line
    to: number;          // char offset of token end (exclusive)
  }
  export type KeywordMode = "both" | "hashtag" | "bare";
  export interface MatchSettings { keywords: string[]; keywordMode: KeywordMode; calloutChars: string[] }
  export interface ScanConfig { keywordRe: RegExp | null; calloutRe: RegExp | null; taskRe: RegExp; mode: KeywordMode }
  export function buildScanConfig(s: MatchSettings): ScanConfig
  export function configHash(s: MatchSettings): string   // stable JSON of the three fields
  export function scanText(text: string, cfg: ScanConfig): Hit[]
  export function struckRanges(line: string): Array<[number, number]>
  ```

- [ ] **Step 1: Write failing tests** in `test/scanner.test.ts` (`import { test } from "node:test"; import assert from "node:assert/strict"; import { buildScanConfig, scanText } from "../src/scanner.ts";`). Helper `cfg = buildScanConfig({ keywords: ["TODO","FIXME","BUG","NOTE","WARN","IDEA","TK"], keywordMode: "both", calloutChars: [] })`. Tests (one `test()` each, assert on `hits.map(h => [h.line, h.kind, h.label, h.done, h.from, h.to, h.text])`):
  - `TODO: fix it` → `[[0,"keyword","TODO",false,0,4,"fix it"]]`
  - `#TODO fix it` → label `TODO`, from 0, to 5, text `fix it`
  - `(TODO: why?)` → one hit, text `why?)`
  - `## TODO's` → one hit, from 3, to 7, text `'s` (text = remainder after token with leading `[\s:—–-]+` stripped).
  - `TODO` alone on a line → text falls back to `TODO` (whole trimmed line).
  - `a note about todos` → no hits (lowercase)
  - `TODOS and MYTODO` → no hits
  - `TODO one and FIXME two` → two hits, labels `TODO`,`FIXME`, lines both 0
  - `~~TODO~~ done` → one hit, done `true`
  - `~~TODO: call bank~~` → done `true`
  - `~~TODO fix this` → done `false` (Review Focus 1)
  - `> [!NOTE] title` and `> [!TODO]- folded` → no hits
  - frontmatter: `---\ntags: TODO\n---\nTODO: real` → one hit at line 3
  - code fence: "```\nTODO in code\n```" → one hit
  - mode `hashtag`: `TODO x` no hit, `#TODO x` hit
  - mode `bare`: `#TODO x` no hit, `TODO x` hit
- [ ] **Step 2: Run** `npm test`. Expected: FAIL, cannot find module `../src/scanner.ts`.
- [ ] **Step 3: Implement `src/scanner.ts`**. Keyword regex (no lookbehind): `new RegExp("(^|[^\\w#])(#?)(" + escaped keywords joined "|" + ")(?!\\w)", "g")`; token start = `m.index + m[1].length`. Skip when `line.slice(start-2, start) === "[!"`. Skip when mode is `hashtag` and `m[2] === ""`, or mode is `bare` and `m[2] === "#"`. `struckRanges`: scan `~~` occurrences left to right, pair them; return `[open+2, close)` pairs; unpaired trailing `~~` ignored. `done` = token range inside any struck range. Frontmatter: if line 0 is `---`, skip through the next line equal to `---`. `text` = remainder after token with `/^[\s:—–-]+/` stripped, else whole trimmed line.
- [ ] **Step 4: Run** `npm test`. Expected: all PASS.
- [ ] **Step 5: Commit** `feat(scanner): keyword matching with bare/hashtag modes and done detection`.

---

### Task 3: Scanner — callouts and tasks

**Files:**
- Modify: `src/scanner.ts`, `test/scanner.test.ts`

**Interfaces:**
- Consumes/produces: same as Task 2. `calloutRe` built from `calloutChars` (escaped into a character class): `^(\s*(?:[-*+]|\d+[.)])\s+(?:\[.\]\s+)?)([chars])\s`. `taskRe`: `^\s*(?:[-*+]|\d+[.)])\s+\[(.)\]\s*(.*)$`. Task hit: `label "task"`, `from/to` = the bracket range `[` … `]` inclusive of brackets (3 chars), `done` = inner char !== " ". Callout hit: `label` = char, `from/to` = the char.

- [ ] **Step 1: Write failing tests** with `calloutChars: ["&","?","!","~","@","$","%","="]`:
  - `- ? why?` → `[0,"callout","?",false,2,3,"why?"]`
  - `* ! important`, `+ = idea`, `1. ! ordered`, `2) $ money` → one callout hit each with the right label
  - `-? nospace` and `- ?nospace` → no hits
  - `- [ ] buy milk` → `[0,"task","task",false,2,5,"buy milk"]`
  - `- [x] bought` → task, done `true`
  - `- [ ] ? question task` → exactly one row: kind `task`, secondary `?`, text `question task`
  - `- [ ] TODO: call bank` → two rows: task (from 2,to 5) and keyword TODO (from 6,to 10) (Review Focus 2)
  - `- ! TODO later` → two rows: callout `!` and keyword `TODO`
  - config with `calloutChars: []` → `calloutRe === null`, `- ? x` yields nothing
- [ ] **Step 2: Run** `npm test`. Expected: new tests FAIL.
- [ ] **Step 3: Implement** in `scanText`: per line, first `taskRe`; if matched push task row (secondary = callout char if `calloutRe` matches the same line); else if `calloutRe` matches push callout row; then keyword hits regardless. Keep output sorted by `(line, from)`.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(scanner): list callouts and checkbox tasks`.

---

### Task 4: Settings

**Files:**
- Create: `src/settings.ts`
- Modify: `src/main.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface TroubleTagsSettings extends MatchSettings {
    showDone: boolean; statusBar: boolean; excludedFolders: string[];
    scope: "note" | "vault"; filters: { keyword: boolean; callout: boolean; task: boolean };
  }
  export const DEFAULT_SETTINGS: TroubleTagsSettings  // keywords TODO,FIXME,BUG,NOTE,WARN,IDEA,TK; mode both;
    // calloutChars & ? ! ~ @ $ % =; showDone false; statusBar false; excludedFolders []; scope "note"; filters all true
  export class TroubleTagsSettingTab extends PluginSettingTab
  export function parseKeywords(raw: string): string[]      // split ",", trim, uppercase, drop empty, dedupe
  export function parseCalloutChars(raw: string): string[]  // split whitespace, single chars only, dedupe
  ```
- Plugin exposes `settings: TroubleTagsSettings`, `scanConfig: ScanConfig`, `async saveSettings()`, `onMatchSettingsChanged(): void` (rebuilds `scanConfig`, calls `view?.onConfigChanged()` and `indexStore.invalidate()` from Task 6; until Task 6 exists, just rebuild + view refresh).

- [ ] **Step 1: Write failing tests** `test/settings.test.ts` for `parseKeywords(" todo, Fixme,,tk ")` → `["TODO","FIXME","TK"]` and `parseCalloutChars("? !  = ab")` → `["?","!","="]`. Put both functions in `src/parse.ts` (no obsidian import) and re-export nothing from `settings.ts`; the test imports `../src/parse.ts`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** `src/settings.ts` with the tab in spec order: Keywords (text), Keyword match (dropdown: `both` "Hashtag and bare", `hashtag` "Hashtag only", `bare` "Bare only"), Callout characters (text) + extra button "Import from List Callouts" (reads `${this.app.vault.configDir}/plugins/obsidian-list-callouts/data.json` via `this.app.vault.adapter.exists/read`, takes `callouts[].char`, Notice "List Callouts settings not found" if missing), Show done items (toggle), Status bar count (toggle), heading "Vault index" with Excluded folders (textarea, one per line) and buttons Rebuild index / Clear index (wired in Task 7; until then they call `plugin.onMatchSettingsChanged()`). Every matching change calls `plugin.onMatchSettingsChanged()`.
- [ ] **Step 4: Wire `loadData`/`saveData`** in `main.ts` (`Object.assign({}, DEFAULT_SETTINGS, await this.loadData())`), `addSettingTab`.
- [ ] **Step 5: Run** `npm test && npm run build`. Expected: PASS, build OK. Reload in test vault, open settings tab, `dev:errors` empty.
- [ ] **Step 6: Commit** `feat: settings tab with keywords, callout chars, modes`.

---

### Task 5: Current-note view rewrite (filters, jump, mark done)

**Files:**
- Create: `src/view.ts`, `src/edit.ts`, `test/edit.test.ts`
- Modify: `src/main.ts` (events), `styles.css`

**Interfaces:**
- `src/edit.ts` (no obsidian import):
  ```ts
  export function doneReplacement(hit: Hit, lineText: string): { from: number; to: number; insert: string } | null
  // keyword: token = lineText.slice(from,to); insert "~~" + token + "~~"; null if token no longer matches hit.label (with optional "#")
  // task: expects lineText.slice(from,to) === "[ ]"; insert "[x]"; null otherwise
  // callout: always null
  ```
- `src/view.ts`: `export class TroubleView extends ItemView` with `currentPath: string | null`, `scheduleNoteScan(editor?: Editor)`, `scanNote(file: TFile | null, text?: string)`, `onConfigChanged()`, `render()`, `jumpTo(path: string, line: number)`, `markDone(path: string, hit: Hit)`.
- `main.ts` events: `workspace.on("file-open")` → `view?.scanNote(file)` only if `file?.path !== view.currentPath`; `workspace.on("editor-change", (editor, info))` → if `info.file?.path === view?.currentPath` then `view.scheduleNoteScan(editor)` (250 ms debounce, scans `editor.getValue()`); `vault.on("modify")` → if path matches current and no editor is open for it, rescan from `cachedRead`.

- [ ] **Step 1: Write failing tests** for `doneReplacement`: keyword `TODO` at 0..4 on `TODO: x` → `{0,4,"~~TODO~~"}`; `#TODO` → `"~~#TODO~~"`; line changed (`DONE: x`) → `null`; task on `- [ ] x` → `{2,5,"[x]"}`; task line now `- [x] x` → `null`; callout → `null`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement `src/edit.ts`**.
- [ ] **Step 4: Implement `src/view.ts`** for note scope only: header (filter chips `Keywords`/`Callouts`/`Tasks` toggling `settings.filters` and saving, `Show done` chip, file name), rows (`trouble-tags-row` with label pill `trouble-tags-label-<label>` for keyword, `trouble-tags-label-callout` + char, `trouble-tags-label-task`; line number `:N`; context; hover button `trouble-tags-done` with `setIcon(el, "check")`, hidden for callouts). Skip DOM rebuild when `JSON.stringify(visibleHits)` equals the last rendered key. `jumpTo`: find `MarkdownView` leaf whose `file.path === path` → `editor.setCursor`, `scrollIntoView`, `focus`, `workspace.revealLeaf`; else `workspace.getLeaf(false).openFile(file, { eState: { line } })`. `markDone` (note scope): `editor.getLine(line)` → `doneReplacement` → `editor.replaceRange(insert, {line, ch: from}, {line, ch: to})`; on `null` → `new Notice("Line changed, rescanning")` and rescan.
- [ ] **Step 5: Replace v1 view and events in `main.ts`**; delete the old class. Keep ribbon + toggle command.
- [ ] **Step 6: Add CSS**: chips (`.trouble-tags-chip`, `.is-active`), `IDEA` purple `rgb(168, 85, 247)`, `TK` grey `rgb(156, 163, 175)`, custom keywords `trouble-tags-label-custom-<i>` i = index mod 6 over a 6-colour palette, callout pill neutral `var(--background-modifier-border)` tint, task pill `var(--interactive-accent)` tint, `.trouble-tags-done` visible on `.trouble-tags-row:hover`.
- [ ] **Step 7: Verify** `npm test && npm run build`, reload in test vault, write a note containing every keyword form from Task 2/3 tests, check rows, click → cursor moves, ✓ → text becomes `~~TODO~~` / `[x]`, `dev:errors` empty.
- [ ] **Step 8: Commit** `feat(view): filters, mark done, jump via MarkdownView`.

---

### Task 6: IndexStore (vault index, pure logic)

**Files:**
- Create: `src/index-store.ts`, `test/index-store.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface IndexIO {
    listMarkdown(): Array<{ path: string; mtime: number }>;
    readFile(path: string): Promise<string>;
    readIndex(): Promise<string | null>;   // null when missing
    writeIndex(json: string): Promise<void>;
    deleteIndex(): Promise<void>;
    yieldToUi(): Promise<void>;           // setTimeout 0 in app, no-op in tests
  }
  export interface IndexEntry { mtime: number; hits: Hit[] }
  export interface IndexFile { version: 1; config: string; files: Record<string, IndexEntry> }
  export class IndexStore {
    constructor(io: IndexIO, getConfig: () => { scan: ScanConfig; hash: string; excludedFolders: string[] })
    files: Record<string, IndexEntry> | null;   // null = no index
    readonly dirty: Set<string>;
    load(): Promise<void>;
    build(onProgress?: (done: number, total: number) => void): Promise<void>;
    refresh(): Promise<void>;                     // mtime diff + dirty set, only when files !== null
    updateFile(path: string, mtime: number, text?: string): Promise<boolean>;
    removeFile(path: string): boolean;
    renameFile(oldPath: string, newPath: string): void;
    markDirty(path: string): void;
    invalidate(): Promise<void>;
    isExcluded(path: string): boolean;            // folder boundary: path === f || path.startsWith(f + "/")
    save(): Promise<void>;                        // skips write when unchanged since last save
  }
  ```
  Entries exist only for files with ≥1 hit; files scanned with zero hits are not stored but their absence is fine because `refresh` compares mtimes against the stored set and rescans any file not in it... — to avoid rescanning every empty file on each refresh, store zero-hit files too as `{ mtime, hits: [] }`. Pin that: **all scanned files are stored**, hits may be empty.

- [ ] **Step 1: Write failing tests** with an in-memory `IndexIO` fake (`Map<string,{mtime,text}>`, `indexJson: string|null`):
  - `build` with 3 files, 2 containing `TODO` → `files` has 3 entries, hits counts 1,1,0; `writeIndex` called once; progress called with `(3,3)` last.
  - `load` with stored JSON whose `config` differs → `files === null` and `deleteIndex` called.
  - `load` with matching config → entries restored, no scan (`readFile` not called).
  - `refresh`: bump mtime of one file and change text, add a new file, delete one → only the two read; deleted entry gone. (Review Focus 4)
  - `markDirty("a.md")` then `refresh` with unchanged mtime → `a.md` still re-read.
  - `isExcluded` with `["templates"]`: `templates/x.md` true, `templates-old/x.md` false, `templates` true. (Review Focus 3) Excluded files are absent after `build` and removed on `refresh`.
  - `renameFile` moves entry; `updateFile(path, mtime, text)` uses given text without `readFile`.
  - `invalidate` → `files === null`, `deleteIndex` called.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement `src/index-store.ts`**. `build`: iterate `listMarkdown()` minus excluded, process in batches of 50 with `Promise.all`, `yieldToUi()` after each 200 files, progress callback per batch, then `save()`.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(index): persistent vault index with incremental refresh`.

---

### Task 7: Vault scope in the view and plugin wiring

**Files:**
- Modify: `src/view.ts`, `src/main.ts`, `src/settings.ts` (wire Rebuild/Clear), `styles.css`

**Interfaces:**
- `main.ts` creates `this.indexStore = new IndexStore(obsidianIO, () => ({ scan: this.scanConfig, hash: configHash(this.settings), excludedFolders: this.settings.excludedFolders }))` where `obsidianIO` maps to `this.app.vault.getMarkdownFiles()` (`file.stat.mtime`), `this.app.vault.cachedRead(file)`, and `this.app.vault.adapter.{exists,read,write,remove}` on `${this.manifest.dir}/index.json`; `yieldToUi` = `new Promise(r => setTimeout(r, 0))`. `onload` calls `indexStore.load()` without awaiting.
- View gains `scope` (from settings), `setScope(s)`, `renderVault()`, `buildIndex()`.

- [ ] **Step 1: Scope toggle** in header: two-state icon button (`file-text` / `folder-open`, aria-label "Current note" / "Whole vault"), persists `settings.scope`. Switching to vault: if `indexStore.files === null` render empty state with a `Build index` button; else `await indexStore.refresh()` then `renderVault()`.
- [ ] **Step 2: `buildIndex()`**: shows progress line `Indexing N/M`, calls `indexStore.build(progress)`, re-renders every progress tick (throttled to once per 100 ms), then `renderVault()`.
- [ ] **Step 3: `renderVault()`**: group entries with ≥1 visible hit by path, sort by `mtime` desc, per-file collapsible header (`trouble-tags-file`, name + count, click toggles `is-collapsed`), rows as in note scope but with the file basename in place of the line number. After 500 rows render a `Show more` row that reveals the next 500. Row click → `jumpTo(path, line)`. ✓ → `markDone(path, hit)`.
- [ ] **Step 4: `markDone` for non-active files**: `this.app.vault.process(file, data => { lines = data.split("\n"); r = doneReplacement(hit, lines[hit.line]); if (!r) { changed = false; return data } ... })`; if not changed → Notice "Line changed, rescanning" + `indexStore.updateFile(path, mtime)` + re-render. After a successful edit call `indexStore.updateFile(path, Date.now(), newData)` and re-render.
- [ ] **Step 5: Events in `main.ts`**: `vault.on("modify", f)` → if view open and scope vault: `indexStore.updateFile(f.path, f.stat.mtime)` then re-render if changed; else `indexStore.markDirty(f.path)`. `vault.on("delete")` → `removeFile` (or markDirty when closed — removeFile is cheap, always do it). `vault.on("rename")` → `renameFile`. All guarded by `indexStore.files !== null`. `save()` debounced 2 s after any store change (`setTimeout` tracked and cleared in `onunload`).
- [ ] **Step 6: Settings buttons**: Rebuild index → `invalidate()` then `buildIndex()` if the view is open in vault scope, else just invalidate. Clear index → `invalidate()` and re-render view. `onMatchSettingsChanged` → rebuild `scanConfig`, `view.onConfigChanged()`, `indexStore.invalidate()`.
- [ ] **Step 7: CSS** for `.trouble-tags-file`, `.is-collapsed`, `.trouble-tags-progress`, `.trouble-tags-more`.
- [ ] **Step 8: Verify** `npm test && npm run build`; in the test vault (notes from Task 8 step 1 can be created now if needed) switch scope → button shown → press → list appears; edit a note → entry updates; close panel, delete a note, reopen → gone; `dev:errors` empty.
- [ ] **Step 9: Commit** `feat: whole-vault scope backed by index store`.

---

### Task 8: Status bar, test vault fixtures, docs, release prep

**Files:**
- Modify: `src/main.ts`, `README.md`, `manifest.json` (description), `styles.css`
- Create: `scripts/make-test-notes.mjs` (dev helper, not shipped)

- [ ] **Step 1: `scripts/make-test-notes.mjs`**: writes into `/home/sspaeti/git/obsidian/trouble-tags-testvault`: `fixtures/all-forms.md` (every line from the Task 2/3 tests, one per line, plus a `> [!NOTE]` callout and a frontmatter block), `fixtures/strike.md`, `templates/excluded.md` (contains `TODO`), and `generated/note-001.md … note-300.md` each with 40 lines of lorem and 0–3 random `TODO:`/`- ? q`/`- [ ] t` lines. Run it: `node scripts/make-test-notes.mjs`. Expected: 303 files created.
- [ ] **Step 2: Status bar**: in `onload`, if `settings.statusBar` → `this.statusEl = this.addStatusBarItem()`, text `⚠ N` where N = open (not done) hits of the current note, updated by the view after each note scan via `plugin.updateStatus(n)`; click toggles the panel. Toggling the setting creates/removes the element without reload.
- [ ] **Step 3: README**: rewrite usage (keywords with/without `#`, callouts, tasks, scope toggle, Build index, mark done), settings table, "index.json is a disposable cache in the plugin folder", development section (`npm install`, `npm run dev`, `npm test`), keep the trouble.nvim credit and the other-plugin link. Update `manifest.json` description: "Lists TODO/FIXME/NOTE keywords, list callouts and open tasks of the current note or the whole vault in a sidebar."
- [ ] **Step 4: Manual verification in test vault** via CLI (`obsidian vault=trouble-tags-testvault ...`): `plugin:reload`, `dev:errors` (empty), `open path=fixtures/all-forms.md`, `dev:dom selector=".trouble-tags-row" total` (expected: number of non-done rows in the fixture with all filters on), `dev:screenshot path=/home/sspaeti/git/obsidian/obsidian-trouble-tags/images/trouble-plugin-v2.png`, then Build index via UI, `dev:dom selector=".trouble-tags-file" total` ≥ 100, `eval code="performance.now()"` around a reload is not meaningful, instead temporarily log `scanText` time for `all-forms.md` and remove the log. Mark-done on a changed line: edit the line in the editor without the panel rescanning (type fast, click ✓ within the debounce) → Notice appears, file unchanged (Review Focus 5).
- [ ] **Step 5: Final build and commit** `npm run build && npm test`; `git add -A`; commit `feat: trouble tags 1.1.0 — bare keywords, callouts, tasks, vault index`. Do not tag or release; the author does that.
