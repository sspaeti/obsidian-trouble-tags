export function parseKeywords(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const k = part.trim().toUpperCase();
    if (k.length > 0 && out.indexOf(k) === -1) out.push(k);
  }
  return out;
}

export function parseCalloutChars(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(/\s+/)) {
    if (Array.from(part).length === 1 && out.indexOf(part) === -1) out.push(part);
  }
  return out;
}
