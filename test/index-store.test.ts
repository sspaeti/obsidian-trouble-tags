import { test } from "node:test";
import assert from "node:assert/strict";
import { IndexStore } from "../src/index-store.ts";
import type { IndexIO } from "../src/index-store.ts";
import { buildScanConfig, configHash } from "../src/scanner.ts";

const settings = { keywords: ["TODO"], keywordMode: "both" as const, calloutChars: [] as string[] };
const scan = buildScanConfig(settings);
const hash = configHash(settings);

function fake(initial: Record<string, { mtime: number; text: string }>) {
  const fs = new Map(Object.entries(initial));
  const st = {
    fs,
    reads: [] as string[],
    indexJson: null as string | null,
    writes: 0,
    deletes: 0,
    yields: 0,
    failing: new Set<string>(),
    onRead: undefined as ((p: string) => void) | undefined,
  };
  const io: IndexIO = {
    listMarkdown: () => [...fs.entries()].map(([path, v]) => ({ path, mtime: v.mtime })),
    readFile: async (p) => {
      st.reads.push(p);
      st.onRead?.(p);
      if (st.failing.has(p)) throw new Error("gone");
      return fs.get(p)!.text;
    },
    readIndex: async () => st.indexJson,
    writeIndex: async (j) => {
      st.writes++;
      st.indexJson = j;
    },
    deleteIndex: async () => {
      st.deletes++;
      st.indexJson = null;
    },
    yieldToUi: async () => {
      st.yields++;
    },
  };
  return { st, io };
}
const mk = (io: IndexIO, excluded: string[] = []) =>
  new IndexStore(io, () => ({ scan, hash, excludedFolders: excluded }));
const three = {
  "a.md": { mtime: 1, text: "TODO: a" },
  "b.md": { mtime: 2, text: "TODO: b" },
  "c.md": { mtime: 3, text: "nothing" },
};

test("build stores all files, writes once, progress ends (3,3)", async () => {
  const { st, io } = fake(three);
  const s = mk(io);
  const prog: Array<[number, number]> = [];
  await s.build((d, t) => prog.push([d, t]));
  assert.equal(Object.keys(s.files!).length, 3);
  assert.deepEqual(
    ["a.md", "b.md", "c.md"].map((p) => s.files![p].hits.length),
    [1, 1, 0],
  );
  assert.equal(st.writes, 1);
  assert.deepEqual(prog[prog.length - 1], [3, 3]);
});

test("load with different config deletes index, reads nothing", async () => {
  const { st, io } = fake(three);
  st.indexJson = JSON.stringify({ version: 1, config: "other", files: {} });
  const s = mk(io);
  await s.load();
  assert.equal(s.files, null);
  assert.equal(st.deletes, 1);
  assert.equal(st.reads.length, 0);
});

test("load with invalid json or version deletes index", async () => {
  const { st, io } = fake(three);
  st.indexJson = "{nope";
  const s = mk(io);
  await s.load();
  assert.equal(s.files, null);
  assert.equal(st.deletes, 1);
  st.indexJson = JSON.stringify({ version: 2, config: hash, files: {} });
  await s.load();
  assert.equal(s.files, null);
  assert.equal(st.deletes, 2);
});

test("load with missing index leaves files null", async () => {
  const { st, io } = fake(three);
  const s = mk(io);
  await s.load();
  assert.equal(s.files, null);
  assert.equal(st.deletes, 0);
});

test("load with matching config restores entries without scanning", async () => {
  const a = fake(three);
  const s1 = mk(a.io);
  await s1.build();
  const b = fake(three);
  b.st.indexJson = a.st.indexJson;
  const s2 = mk(b.io);
  await s2.load();
  assert.deepEqual(s2.files, s1.files);
  assert.equal(b.st.reads.length, 0);
  assert.equal(b.st.deletes, 0);
});

test("refresh rescans only changed, new and removed", async () => {
  const { st, io } = fake(three);
  const s = mk(io);
  await s.build();
  st.reads.length = 0;
  st.fs.set("a.md", { mtime: 10, text: "TODO: a\nTODO: again" });
  st.fs.set("d.md", { mtime: 4, text: "TODO: d" });
  st.fs.delete("b.md");
  await s.refresh();
  assert.deepEqual([...st.reads].sort(), ["a.md", "d.md"]);
  assert.equal(s.files!["a.md"].hits.length, 2);
  assert.equal(s.files!["d.md"].hits.length, 1);
  assert.equal(s.files!["b.md"], undefined);
  assert.equal(s.files!["c.md"].hits.length, 0);
});

test("refresh rescans dirty file with unchanged mtime and clears dirty", async () => {
  const { st, io } = fake(three);
  const s = mk(io);
  await s.build();
  st.reads.length = 0;
  s.markDirty("a.md");
  await s.refresh();
  assert.deepEqual(st.reads, ["a.md"]);
  assert.equal(s.dirty.size, 0);
});

test("refresh on null files reads nothing", async () => {
  const { st, io } = fake(three);
  const s = mk(io);
  await s.refresh();
  assert.equal(st.reads.length, 0);
  assert.equal(s.files, null);
});

test("isExcluded respects folder boundary", () => {
  const { io } = fake({});
  const s = mk(io, ["templates", ""]);
  assert.equal(s.isExcluded("templates/x.md"), true);
  assert.equal(s.isExcluded("templates-old/x.md"), false);
  assert.equal(s.isExcluded("templates"), true);
  assert.equal(s.isExcluded("a.md"), false);
});

test("excluded files absent after build and removed on refresh", async () => {
  const { st, io } = fake({
    "templates/x.md": { mtime: 1, text: "TODO: x" },
    "templates-old/y.md": { mtime: 1, text: "TODO: y" },
    "z.md": { mtime: 1, text: "TODO: z" },
  });
  let excluded: string[] = [];
  const s = new IndexStore(io, () => ({ scan, hash, excludedFolders: excluded }));
  await s.build();
  assert.equal(Object.keys(s.files!).length, 3);
  excluded = ["templates"];
  await s.refresh();
  assert.deepEqual(Object.keys(s.files!).sort(), ["templates-old/y.md", "z.md"]);
  const mark = st.reads.length;
  const t = mk(io, ["templates"]);
  await t.build();
  assert.equal(t.files!["templates/x.md"], undefined);
  assert.equal(st.reads.slice(mark).includes("templates/x.md"), false);
});

test("renameFile moves entry; excluded target drops it", async () => {
  const { io } = fake(three);
  const s = mk(io, ["tpl"]);
  await s.build();
  s.markDirty("a.md");
  s.renameFile("a.md", "n.md");
  assert.equal(s.dirty.has("a.md"), false);
  assert.equal(s.dirty.has("n.md"), true);
  assert.equal(s.files!["a.md"], undefined);
  assert.equal(s.files!["n.md"].hits.length, 1);
  s.renameFile("n.md", "tpl/n.md");
  assert.equal(s.files!["n.md"], undefined);
  assert.equal(s.files!["tpl/n.md"], undefined);
});

test("updateFile uses given text without readFile", async () => {
  const { st, io } = fake(three);
  const s = mk(io, ["tpl"]);
  assert.equal(await s.updateFile("a.md", 5, "TODO: x"), false); // no index
  await s.build();
  st.reads.length = 0;
  assert.equal(await s.updateFile("c.md", 9, "TODO: now"), true);
  assert.equal(st.reads.length, 0);
  assert.equal(s.files!["c.md"].mtime, 9);
  assert.equal(s.files!["c.md"].hits.length, 1);
  assert.equal(await s.updateFile("tpl/q.md", 1, "TODO: q"), false);
  assert.equal(s.files!["tpl/q.md"], undefined);
});

test("removeFile reports whether entry existed", async () => {
  const { io } = fake(three);
  const s = mk(io);
  await s.build();
  assert.equal(s.removeFile("a.md"), true);
  assert.equal(s.removeFile("a.md"), false);
});

test("invalidate clears files and deletes index", async () => {
  const { st, io } = fake(three);
  const s = mk(io);
  await s.build();
  s.markDirty("a.md");
  await s.invalidate();
  assert.equal(s.files, null);
  assert.equal(s.dirty.size, 0);
  assert.equal(st.deletes, 1);
});

test("save twice with no changes writes once", async () => {
  const { st, io } = fake(three);
  const s = mk(io);
  await s.build();
  await s.save();
  await s.save();
  assert.equal(st.writes, 1);
});

test("build with 250 files yields to UI and ends (250,250)", async () => {
  const many: Record<string, { mtime: number; text: string }> = {};
  for (let i = 0; i < 250; i++) many[`f${i}.md`] = { mtime: i, text: "TODO: x" };
  const { st, io } = fake(many);
  const s = mk(io);
  let last: [number, number] = [0, 0];
  await s.build((d, t) => (last = [d, t]));
  assert.equal(st.yields, 1);
  assert.deepEqual(last, [250, 250]);
});

test("build skips a file whose read fails and still saves once", async () => {
  const { st, io } = fake(three);
  st.failing.add("b.md");
  const s = mk(io);
  await s.build();
  assert.deepEqual(Object.keys(s.files!).sort(), ["a.md", "c.md"]);
  assert.equal(st.writes, 1);
});

test("refresh survives a failing read", async () => {
  const { st, io } = fake(three);
  const s = mk(io);
  await s.build();
  st.fs.set("a.md", { mtime: 50, text: "TODO: new" });
  st.fs.set("d.md", { mtime: 4, text: "TODO: d" });
  st.failing.add("a.md");
  await s.refresh();
  assert.equal(s.files!["d.md"].hits.length, 1);
  assert.equal(s.files!["a.md"].mtime, 1);
});

test("markDirty during refresh reads is preserved", async () => {
  const { st, io } = fake({ ...three, "z.md": { mtime: 1, text: "x" } });
  const s = mk(io);
  await s.build();
  s.markDirty("a.md");
  st.onRead = () => s.markDirty("z.md");
  await s.refresh();
  assert.equal(s.dirty.has("z.md"), true);
  assert.equal(s.dirty.has("a.md"), false);
});

test("no-change refresh does not write", async () => {
  const { st, io } = fake(three);
  const s = mk(io);
  await s.build();
  await s.refresh();
  assert.equal(st.writes, 1);
});

test("build stopped after the first batch keeps files null and does not write", async () => {
  const many: Record<string, { mtime: number; text: string }> = {};
  for (let i = 0; i < 120; i++) many[`n${i}.md`] = { mtime: i, text: "TODO: x" };
  const { st, io } = fake(many);
  const s = mk(io);
  let batches = 0;
  await s.build(() => { batches++; }, () => batches >= 1);
  assert.equal(batches, 1);
  assert.equal(s.files, null);
  assert.equal(st.writes, 0);
});

test("refresh stopped after the first batch leaves entries unchanged and does not write", async () => {
  const many: Record<string, { mtime: number; text: string }> = {};
  for (let i = 0; i < 120; i++) many[`n${i}.md`] = { mtime: i, text: "TODO: x" };
  const { st, io } = fake(many);
  const s = mk(io);
  await s.build();
  const before = JSON.stringify(s.files);
  const rev = s.revision;
  for (let i = 0; i < 120; i++) st.fs.set(`n${i}.md`, { mtime: 1000 + i, text: "nothing" });
  st.fs.delete("n0.md");
  st.reads.length = 0;
  await s.refresh(() => st.reads.length >= 50);
  assert.equal(st.reads.length, 50);
  assert.equal(JSON.stringify(s.files), before);
  assert.equal(s.revision, rev);
  assert.equal(st.writes, 1);
});

test("load drops malformed entries and keeps the rest", async () => {
  const { st, io } = fake(three);
  const good = { mtime: 1, hits: [{ line: 0, kind: "keyword", label: "TODO", text: "a", done: false, from: 0, to: 4 }] };
  st.indexJson = JSON.stringify({
    version: 1,
    config: hash,
    files: {
      "a.md": good,
      "b.md": { mtime: 2, hits: "nope" },
      "c.md": { mtime: "3", hits: [] },
      "d.md": { mtime: 4, hits: [{ line: "0", kind: "keyword", label: "TODO", from: 0, to: 4 }] },
    },
  });
  const s = mk(io);
  await s.load();
  assert.deepEqual(Object.keys(s.files!), ["a.md"]);
  assert.deepEqual(s.files!["a.md"], good);
  assert.equal(st.deletes, 0);
});

test("revision increases on every mutation", async () => {
  const { io } = fake(three);
  const s = mk(io);
  const revs = [s.revision];
  await s.build();
  revs.push(s.revision);
  await s.updateFile("a.md", 9, "TODO: z");
  revs.push(s.revision);
  s.renameFile("a.md", "z.md");
  revs.push(s.revision);
  s.removeFile("z.md");
  revs.push(s.revision);
  await s.invalidate();
  revs.push(s.revision);
  for (let i = 1; i < revs.length; i++) assert.ok(revs[i] > revs[i - 1]);
});
