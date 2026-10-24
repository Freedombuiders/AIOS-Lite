// `[GIÁ]`-style blanks an AI draft or canned reply leaves for the owner to fill. Sending is blocked while any remain.

const RE = /\[[^[\]\r\n]{1,80}\]/g;

export interface PlaceholderRange { text: string; start: number; end: number }

export function findPlaceholders(text: string): PlaceholderRange[] {
  const out: PlaceholderRange[] = [];
  for (const m of text.matchAll(RE)) out.push({ text: m[0], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  return out;
}

export function countPlaceholders(text: string): number {
  return findPlaceholders(text).length;
}

export interface TextPart { text: string; placeholder: boolean }

/** The text cut into plain and placeholder parts (rendered with a <mark> around the latter). */
export function splitByPlaceholders(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let at = 0;
  for (const r of findPlaceholders(text)) {
    if (r.start > at) parts.push({ text: text.slice(at, r.start), placeholder: false });
    parts.push({ text: r.text, placeholder: true });
    at = r.end;
  }
  if (at < text.length) parts.push({ text: text.slice(at), placeholder: false });
  return parts;
}

/** The first placeholder at or after `from`, wrapping around to the start; null when there is none. */
export function nextPlaceholder(text: string, from: number): PlaceholderRange | null {
  const all = findPlaceholders(text);
  if (all.length === 0) return null;
  return all.find((r) => r.end > from) ?? all[0];
}
