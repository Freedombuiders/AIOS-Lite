// Canned replies ("câu trả lời nhanh"): the `/` trigger in the composer, filtering and insertion. Pure.

import type { CareApiChannel, CareCannedReplyDto } from './dto';

export interface SlashTrigger {
  /** Index of the `/` in the text. */
  start: number;
  /** What was typed after it (no spaces). */
  query: string;
}

/** Lower-case, accent-free form used for matching ("Cảm ơn" matches "cam on"). */
export function normalizeText(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');
}

/** A `/` that opens a line (start of the text or right after a newline), with only shortcut characters after it up to the caret. */
export function detectSlash(text: string, caret: number): SlashTrigger | null {
  const end = Math.max(0, Math.min(caret, text.length));
  const lineStart = text.lastIndexOf('\n', end - 1) + 1;
  const segment = text.slice(lineStart, end);
  const m = /^\/([A-Za-z0-9_-]{0,32})$/.exec(segment);
  return m ? { start: lineStart, query: m[1] } : null;
}

/** Shortcut-prefix matches first, then shortcut / title substring matches; the saved order breaks ties. */
export function filterCanned(items: CareCannedReplyDto[], query: string): CareCannedReplyDto[] {
  const q = normalizeText(query.trim().replace(/^\//, ''));
  const sorted = [...items].sort((a, b) => a.sort - b.sort || a.shortcut.localeCompare(b.shortcut));
  if (!q) return sorted;
  const rank = (c: CareCannedReplyDto): number => {
    const sc = normalizeText(c.shortcut);
    if (sc.startsWith(q)) return 0;
    if (sc.includes(q)) return 1;
    if (normalizeText(c.title).includes(q)) return 2;
    return 3;
  };
  return sorted.filter((c) => rank(c) < 3).sort((a, b) => rank(a) - rank(b));
}

/** Email replies use the longer variant when the reply has one. */
export function cannedBody(item: CareCannedReplyDto, channel: CareApiChannel): string {
  return channel === 'email' && item.emailBody && item.emailBody.trim() ? item.emailBody : item.body;
}

export interface Inserted { text: string; caret: number }

/** Replaces the `/query` the user typed (or inserts at the caret when the menu was opened with the button). */
export function applyCanned(text: string, caret: number, trigger: SlashTrigger | null, body: string): Inserted {
  if (trigger) {
    const next = text.slice(0, trigger.start) + body + text.slice(caret);
    return { text: next, caret: trigger.start + body.length };
  }
  const at = Math.max(0, Math.min(caret, text.length));
  // Button insert on a non-empty line goes on its own line so it never glues onto what was typed.
  const needsBreak = at > 0 && text[at - 1] !== '\n';
  const insert = (needsBreak ? '\n' : '') + body;
  return { text: text.slice(0, at) + insert + text.slice(at), caret: at + insert.length };
}
