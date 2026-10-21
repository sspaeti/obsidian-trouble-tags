import { scanText } from "./scanner.ts";
import type { Hit, ScanConfig } from "./scanner.ts";

export interface IndexIO {
  listMarkdown(): Array<{ path: string; mtime: number }>;
  readFile(path: string): Promise<string>;
  readIndex(): Promise<string | null>;
  writeIndex(json: string): Promise<void>;
  deleteIndex(): Promise<void>;
  yieldToUi(): Promise<void>;
}

export interface IndexEntry {
  mtime: number;
  hits: Hit[];
}

export interface IndexFile {
  version: 1;
  config: string;
  files: Record<string, IndexEntry>;
}

type ConfigGetter = () => { scan: ScanConfig; hash: string; excludedFolders: string[] };
type StopCheck = () => boolean;

const BATCH = 50;
const YIELD_EVERY = 200;

function excludedBy(path: string, folders: string[]): boolean {
  for (const f of folders) {
    if (f === "") continue;
    if (path === f || path.startsWith(f + "/")) return true;
  }
  return false;
}

function validHit(h: unknown): boolean {
  if (h === null || typeof h !== "object") return false;
  const o = h as Record<string, unknown>;
  return (
    typeof o.line === "number" &&
    typeof o.from === "number" &&
    typeof o.to === "number" &&
    typeof o.label === "string" &&
    typeof o.kind === "string"
  );
}

// Keeps only well-formed entries of a parsed index file.
function validEntries(raw: Record<string, unknown>): Record<string, IndexEntry> {
  const out: Record<string, IndexEntry> = {};
  for (const path of Object.keys(raw)) {
    const e = raw[path];
    if (e === null || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    if (typeof o.mtime !== "number" || !Array.isArray(o.hits)) continue;
    if (!o.hits.every(validHit)) continue;
    out[path] = { mtime: o.mtime, hits: o.hits as Hit[] };
  }
  return out;
}

export class IndexStore {
  files: Record<string, IndexEntry> | null = null;
  /** Incremented on every change to `files`; cheap change detection for renders. */
  revision = 0;
  readonly dirty: Set<string> = new Set();
  private io: IndexIO;
  private getConfig: ConfigGetter;
  private lastWritten: string | null = null;

  constructor(io: IndexIO, getConfig: ConfigGetter) {
    this.io = io;
    this.getConfig = getConfig;
  }

  isExcluded(path: string): boolean {
    return excludedBy(path, this.getConfig().excludedFolders);
  }

  async load(): Promise<void> {
    const raw = await this.io.readIndex();
    if (raw === null) {
      this.files = null;
      this.revision++;
      return;
    }
    let files: Record<string, unknown> | null = null;
    try {
      const p: unknown = JSON.parse(raw);
      if (p !== null && typeof p === "object") {
        const o = p as Record<string, unknown>;
        const f = o.files;
        if (o.version === 1 && o.config === this.getConfig().hash && f !== null && typeof f === "object" && !Array.isArray(f)) {
          files = f as Record<string, unknown>;
        }
      }
    } catch {
      files = null;
    }
    this.revision++;
    if (files) {
      this.files = validEntries(files);
      this.lastWritten = raw;
    } else {
      this.files = null;
      await this.io.deleteIndex();
    }
  }

  // Reads and scans a batch; files whose read fails are skipped. Returns processed paths.
  private async scanBatch(
    batch: Array<{ path: string; mtime: number }>,
    scan: ScanConfig,
    out: Record<string, IndexEntry>,
  ): Promise<string[]> {
    const results = await Promise.all(
      batch.map(async (f) => {
        try {
          return { f, hits: scanText(await this.io.readFile(f.path), scan) };
        } catch {
          return null;
        }
      }),
    );
    const processed: string[] = [];
    for (const r of results) {
      if (r === null) continue;
      out[r.f.path] = { mtime: r.f.mtime, hits: r.hits };
      processed.push(r.f.path);
    }
    return processed;
  }

  /** Full scan. When `shouldStop` returns true the pass is abandoned: nothing is kept or saved. */
  async build(onProgress?: (done: number, total: number) => void, shouldStop?: StopCheck): Promise<void> {
    const cfg = this.getConfig();
    const excluded = cfg.excludedFolders;
    const list = this.io.listMarkdown().filter((f) => !excludedBy(f.path, excluded));
    const files: Record<string, IndexEntry> = {};
    this.dirty.clear();
    const total = list.length;
    let done = 0;
    for (let i = 0; i < total; i += BATCH) {
      if (shouldStop?.()) return;
      const batch = list.slice(i, i + BATCH);
      await this.scanBatch(batch, cfg.scan, files);
      const before = done;
      done += batch.length;
      onProgress?.(done, total);
      if (Math.floor(done / YIELD_EVERY) > Math.floor(before / YIELD_EVERY)) {
        await this.io.yieldToUi();
      }
    }
    if (shouldStop?.()) return;
    this.files = files;
    this.revision++;
    await this.save();
  }

  /** Metadata pass. When `shouldStop` returns true the pass is abandoned: entries stay as they were, nothing is saved. */
  async refresh(shouldStop?: StopCheck): Promise<void> {
    const files = this.files;
    if (files === null) return;
    const cfg = this.getConfig();
    const excluded = cfg.excludedFolders;
    const current = this.io.listMarkdown().filter((f) => !excludedBy(f.path, excluded));
    const present = new Set(current.map((f) => f.path));
    const dirtySnapshot = new Set(this.dirty);
    const stale = current.filter((f) => {
      const e = files[f.path];
      return !e || e.mtime !== f.mtime || dirtySnapshot.has(f.path);
    });
    // Scanned into a side table and applied only once the pass completes.
    const updates: Record<string, IndexEntry> = {};
    const processed: string[] = [];
    for (let i = 0; i < stale.length; i += BATCH) {
      if (shouldStop?.()) return;
      processed.push(...(await this.scanBatch(stale.slice(i, i + BATCH), cfg.scan, updates)));
    }
    if (shouldStop?.() || this.files !== files) return;
    let changed = processed.length > 0;
    for (const p of processed) {
      files[p] = updates[p];
      this.dirty.delete(p);
    }
    for (const p of Object.keys(files)) {
      if (!present.has(p)) {
        delete files[p];
        changed = true;
      }
    }
    for (const p of dirtySnapshot) if (!present.has(p)) this.dirty.delete(p);
    if (changed) {
      this.revision++;
      await this.save();
    }
  }

  async updateFile(path: string, mtime: number, text?: string): Promise<boolean> {
    if (this.files === null || this.isExcluded(path)) return false;
    const cfg = this.getConfig();
    const body = text ?? (await this.io.readFile(path));
    if (this.files === null) return false;
    this.files[path] = { mtime, hits: scanText(body, cfg.scan) };
    this.revision++;
    return true;
  }

  removeFile(path: string): boolean {
    if (this.files === null || !(path in this.files)) return false;
    delete this.files[path];
    this.revision++;
    return true;
  }

  renameFile(oldPath: string, newPath: string): void {
    if (this.files === null || !(oldPath in this.files)) return;
    const entry = this.files[oldPath];
    delete this.files[oldPath];
    if (!this.isExcluded(newPath)) this.files[newPath] = entry;
    if (this.dirty.delete(oldPath) && !this.isExcluded(newPath)) this.dirty.add(newPath);
    this.revision++;
  }

  markDirty(path: string): void {
    this.dirty.add(path);
  }

  async invalidate(): Promise<void> {
    this.files = null;
    this.dirty.clear();
    this.lastWritten = null;
    this.revision++;
    await this.io.deleteIndex();
  }

  async save(): Promise<void> {
    if (this.files === null) return;
    const file: IndexFile = { version: 1, config: this.getConfig().hash, files: this.files };
    const json = JSON.stringify(file);
    if (json === this.lastWritten) return;
    await this.io.writeIndex(json);
    this.lastWritten = json;
  }
}
