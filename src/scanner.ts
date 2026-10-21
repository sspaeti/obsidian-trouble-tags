export type HitKind = "keyword" | "callout" | "task";

export interface Hit {
  line: number;
  kind: HitKind;
  label: string;
  secondary?: string;
  text: string;
  done: boolean;
  from: number;
  to: number;
}

export type KeywordMode = "both" | "hashtag" | "bare";

export interface MatchSettings {
  keywords: string[];
  keywordMode: KeywordMode;
  calloutChars: string[];
}

export interface ScanConfig {
  keywordRe: RegExp | null;
  calloutRe: RegExp | null;
  taskRe: RegExp;
  mode: KeywordMode;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

export function buildScanConfig(s: MatchSettings): ScanConfig {
  const kws = s.keywords.filter((k) => k.length > 0).map(escapeRe);
  const keywordRe =
    kws.length > 0
      ? new RegExp("(^|[^\\w#])(#?)(" + kws.join("|") + ")(?!\\w)", "g")
      : null;
  const chars = s.calloutChars.filter((c) => c.length > 0).map(escapeRe);
  const calloutRe =
    chars.length > 0
      ? new RegExp(
          "^(\\s*(?:[-*+]|\\d+[.)])\\s+(?:\\[.\\]\\s+)?)((?:" + chars.join("|") + "))\\s",
        )
      : null;
  const taskRe = /^\s*(?:[-*+]|\d+[.)])\s+\[(.)\]\s*(.*)$/;
  return { keywordRe, calloutRe, taskRe, mode: s.keywordMode };
}

export function configHash(s: MatchSettings): string {
  return JSON.stringify({
    keywords: s.keywords,
    keywordMode: s.keywordMode,
    calloutChars: s.calloutChars,
  });
}

export function struckRanges(line: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let i = 0;
  while (true) {
    const open = line.indexOf("~~", i);
    if (open < 0) break;
    const close = line.indexOf("~~", open + 2);
    if (close < 0) break;
    out.push([open + 2, close]);
    i = close + 2;
  }
  return out;
}

function cleanText(s: string): string {
  return s.replace(/~~/g, "").trim();
}

export function scanText(text: string, cfg: ScanConfig): Hit[] {
  const hits: Hit[] = [];
  const lines = text.split(/\r?\n/);
  let start = 0;
  if (lines[0] === "---") {
    for (let j = 1; j < lines.length; j++) {
      if (lines[j] === "---") {
        start = j + 1;
        break;
      }
    }
  }
  const kwRe = cfg.keywordRe ? new RegExp(cfg.keywordRe.source, "g") : null;
  const coRe = cfg.calloutRe ? new RegExp(cfg.calloutRe.source) : null;
  const tkRe = new RegExp(cfg.taskRe.source);
  for (let n = start; n < lines.length; n++) {
    const line = lines[n];
    const co = coRe ? coRe.exec(line) : null;
    const tk = tkRe.exec(line);
    if (tk) {
      const from = line.indexOf("[");
      hits.push({
        line: n,
        kind: "task",
        label: "task",
        secondary: co ? co[2] : undefined,
        text: cleanText(co ? line.slice(co[1].length + co[2].length) : tk[2]),
        done: tk[1] !== " ",
        from,
        to: from + 3,
      });
    } else if (co) {
      const from = co[1].length;
      hits.push({
        line: n,
        kind: "callout",
        label: co[2],
        text: cleanText(line.slice(from + co[2].length)),
        done: false,
        from,
        // A callout char may be an emoji (two UTF-16 units).
        to: from + co[2].length,
      });
    }
    if (kwRe) {
      kwRe.lastIndex = 0;
      let struck: Array<[number, number]> | null = null;
      let m: RegExpExecArray | null;
      while ((m = kwRe.exec(line)) !== null) {
        const from = m.index + m[1].length;
        const to = from + m[2].length + m[3].length;
        if (line.slice(from - 2, from) === "[!") continue;
        if (cfg.mode === "hashtag" && m[2] === "") continue;
        if (cfg.mode === "bare" && m[2] === "#") continue;
        if (struck === null) struck = struckRanges(line);
        const rest = cleanText(line.slice(to).replace(/^[\s:—–-]+/, ""));
        const done = struck.some((r) => from >= r[0] && to <= r[1]);
        hits.push({
          line: n,
          kind: "keyword",
          label: m[3],
          text: rest !== "" ? rest : cleanText(line),
          done,
          from,
          to,
        });
      }
    }
  }
  return hits.sort((a, b) => a.line - b.line || a.from - b.from);
}
