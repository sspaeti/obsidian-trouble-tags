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

const BATCH = 50;
const YIELD_EVERY = 200;

export class IndexStore {
  files: Record<string, IndexEntry> | null = null;
  readonly dirty: Set<string> = new Set();
  private io: IndexIO;
  private getConfig: ConfigGetter;
  private lastWritten: string | null = null;

  constructor(io: IndexIO, getConfig: ConfigGetter) {
    this.io = io;
    this.getConfig = getConfig;
  }

  isExcluded(path: string): boolean {
    for (const f of this.getConfig().excludedFolders) {
      if (f === "") continue;
      if (path === f || path.startsWith(f + "/")) return true;
    }
    return false;
  }

  async load(): Promise<void> {
    const raw = await this.io.readIndex();
    if (raw === null) {
      this.files = null;
      return;
    }
    let ok = false;
    let parsed: IndexFile | null = null;
    try {
      const p = JSON.parse(raw);
      if (
        p !== null &&
        typeof p === "object" &&
        p.version === 1 &&
        p.config === this.getConfig().hash &&
        p.files !== null &&
        typeof p.files === "object" &&
        !Array.isArray(p.files)
      ) {
        parsed = p as IndexFile;
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (ok && parsed) {
      this.files = parsed.files;
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

  async build(onProgress?: (done: number, total: number) => void): Promise<void> {
    const cfg = this.getConfig();
    const list = this.io.listMarkdown().filter((f) => !this.isExcluded(f.path));
    const files: Record<string, IndexEntry> = {};
    this.dirty.clear();
    const total = list.length;
    let done = 0;
    for (let i = 0; i < total; i += BATCH) {
      const batch = list.slice(i, i + BATCH);
      await this.scanBatch(batch, cfg.scan, files);
      const before = done;
      done += batch.length;
      onProgress?.(done, total);
      if (Math.floor(done / YIELD_EVERY) > Math.floor(before / YIELD_EVERY)) {
        await this.io.yieldToUi();
      }
    }
    this.files = files;
    await this.save();
  }

  async refresh(): Promise<void> {
    const files = this.files;
    if (files === null) return;
    const cfg = this.getConfig();
    const current = this.io.listMarkdown().filter((f) => !this.isExcluded(f.path));
    const present = new Set(current.map((f) => f.path));
    const dirtySnapshot = new Set(this.dirty);
    const stale = current.filter((f) => {
      const e = files[f.path];
      return !e || e.mtime !== f.mtime || dirtySnapshot.has(f.path);
    });
    let changed = false;
    for (let i = 0; i < stale.length; i += BATCH) {
      const processed = await this.scanBatch(stale.slice(i, i + BATCH), cfg.scan, files);
      if (processed.length > 0) changed = true;
      for (const p of processed) this.dirty.delete(p);
    }
    for (const p of Object.keys(files)) {
      if (!present.has(p)) {
        delete files[p];
        changed = true;
      }
    }
    for (const p of dirtySnapshot) if (!present.has(p)) this.dirty.delete(p);
    if (changed) await this.save();
  }

  async updateFile(path: string, mtime: number, text?: string): Promise<boolean> {
    if (this.files === null || this.isExcluded(path)) return false;
    const cfg = this.getConfig();
    const body = text ?? (await this.io.readFile(path));
    if (this.files === null) return false;
    this.files[path] = { mtime, hits: scanText(body, cfg.scan) };
    return true;
  }

  removeFile(path: string): boolean {
    if (this.files === null || !(path in this.files)) return false;
    delete this.files[path];
    return true;
  }

  renameFile(oldPath: string, newPath: string): void {
    if (this.files === null || !(oldPath in this.files)) return;
    const entry = this.files[oldPath];
    delete this.files[oldPath];
    if (!this.isExcluded(newPath)) this.files[newPath] = entry;
    if (this.dirty.delete(oldPath) && !this.isExcluded(newPath)) this.dirty.add(newPath);
  }

  markDirty(path: string): void {
    this.dirty.add(path);
  }

  async invalidate(): Promise<void> {
    this.files = null;
    this.dirty.clear();
    this.lastWritten = null;
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
