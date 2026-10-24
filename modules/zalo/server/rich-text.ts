/**
 * Zalo rich text ("RTF") helpers, ported from ZaloCRM's shared/zalo-rich-text.ts.
 *
 * Zalo describes formatting as a list of ranges over the PLAIN text, never as
 * HTML: { st: 'b', start: 0, len: 5 } bolds the first five characters. Every
 * string transformation (trim, variable substitution, spintax) therefore
 * moves the ranges; the helpers here keep them in step.
 *
 * Valid `st` codes (zca-js TextStyle, plus what Zalo renders in practice):
 *   b / i / u / s    bold, italic, underline, strike-through
 *   c_RRGGBB         text colour (zca-js ships db342e f27806 f7b503 15a85f)
 *   f_NN             font size (zca-js ships f_13 small and f_18 big)
 *   lst_1 / lst_2    bullet / numbered list
 *   ind_$            indent (carries `indentSize`)
 */

/** One Zalo text style range (zca-js `Style`). */
export interface ZaloStyle {
  st: string;
  start: number;
  len: number;
  indentSize?: number;
}

export const ZALO_COLORS = {
  red: 'c_db342e',
  orange: 'c_f27806',
  yellow: 'c_f7b503',
  green: 'c_15a85f',
  blue: 'c_2962ff',
} as const;

export const ZALO_SIZE_SMALL = 'f_13';
export const ZALO_SIZE_BIG = 'f_18';

// An unknown code makes Zalo reject the whole message, so this is an
// allow-list, not a sanity check.
const VALID_ST = /^(b|i|u|s|lst_[12]|ind_\$|c_[0-9a-fA-F]{6}|f_\d{1,3})$/;

// Styles that describe a line block: two adjacent ranges are two blocks, not one.
const BLOCK_ST = /^(lst_[12]|ind_\$)$/;

const MAX_INDENT = 16;

/**
 * Filter raw styles (HTTP body, JSON column, agent output) down to what Zalo
 * accepts: unknown codes, non-integers and empty or out-of-range spans are
 * dropped, an overflowing tail is clamped rather than discarded, overlapping
 * or touching ranges of the same inline style are merged, and the result is
 * sorted by position.
 */
export function normalizeZaloStyles(raw: unknown, textLength: number): ZaloStyle[] {
  if (!Array.isArray(raw) || textLength <= 0) return [];
  const clean: ZaloStyle[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { st, start, len, indentSize } = item as Record<string, unknown>;
    if (typeof st !== 'string' || !VALID_ST.test(st)) continue;
    if (!Number.isInteger(start) || !Number.isInteger(len)) continue;
    const s = start as number;
    const l = len as number;
    if (s < 0 || s >= textLength || l <= 0) continue;
    const style: ZaloStyle = { st: st.startsWith('c_') ? st.toLowerCase() : st, start: s, len: Math.min(l, textLength - s) };
    if (st === 'ind_$') {
      const n = typeof indentSize === 'number' && Number.isInteger(indentSize) ? indentSize : 1;
      style.indentSize = Math.min(Math.max(n, 1), MAX_INDENT);
    }
    clean.push(style);
  }
  return mergeStyles(clean);
}

function mergeStyles(styles: ZaloStyle[]): ZaloStyle[] {
  const sorted = [...styles].sort((a, b) => a.start - b.start || a.st.localeCompare(b.st) || b.len - a.len);
  const out: ZaloStyle[] = [];
  const lastByKey = new Map<string, ZaloStyle>();
  for (const s of sorted) {
    const key = s.st === 'ind_$' ? `ind_$:${s.indentSize ?? 1}` : s.st;
    const prev = lastByKey.get(key);
    const end = s.start + s.len;
    if (prev && (BLOCK_ST.test(s.st) ? s.start < prev.start + prev.len : s.start <= prev.start + prev.len)) {
      prev.len = Math.max(prev.start + prev.len, end) - prev.start;
      continue;
    }
    const copy = { ...s };
    out.push(copy);
    lastByKey.set(key, copy);
  }
  return out.sort((a, b) => a.start - b.start || a.st.localeCompare(b.st));
}

/**
 * `.trim()` that keeps the ranges aligned: shifts `start` by the number of
 * leading characters cut and clamps the tail. A bare trim would slide every
 * range left and colour the wrong words.
 */
export function trimRich(text: string, styles: ZaloStyle[]): { text: string; styles: ZaloStyle[] } {
  const trimmed = text.trim();
  if (trimmed === text) return { text, styles: normalizeZaloStyles(styles, text.length) };
  if (!trimmed) return { text: '', styles: [] };
  const offset = text.indexOf(trimmed);
  const shifted: ZaloStyle[] = [];
  for (const s of styles) {
    // A range may cover the trimmed whitespace: clamp it to the new bounds.
    const start = Math.max(0, s.start - offset);
    const end = Math.min(trimmed.length, s.start + s.len - offset);
    if (end > start) shifted.push({ ...s, start, len: end - start });
  }
  return { text: trimmed, styles: normalizeZaloStyles(shifted, trimmed.length) };
}

/**
 * Re-anchor ranges after the text `[from, to)` was replaced by `newLen`
 * characters. A range that touches the replaced span covers the whole
 * replacement; ranges after it move by the length difference.
 */
export function shiftStyles(styles: ZaloStyle[], from: number, to: number, newLen: number): ZaloStyle[] {
  const delta = newLen - (to - from);
  const out: ZaloStyle[] = [];
  for (const s of styles) {
    const end = s.start + s.len;
    let start: number;
    let stop: number;
    if (end <= from) { start = s.start; stop = end; }
    else if (s.start >= to) { start = s.start + delta; stop = end + delta; }
    else {
      start = Math.min(s.start, from);
      stop = end > to ? end + delta : from + newLen;
    }
    if (stop > start) out.push({ ...s, start, len: stop - start });
  }
  return out;
}

/**
 * One piece of a rewritten text, in output order. `copy` pieces are
 * unchanged characters (offsets map 1:1); `replace` pieces stand for a span
 * of the old text that was swapped for `newLen` new characters. Old spans
 * that appear in no piece were deleted.
 */
export interface RemapPiece {
  kind: 'copy' | 'replace';
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newLen: number;
}

/**
 * Carry styles through a rewrite described by `pieces`. A style over a
 * replaced span covers the whole replacement, a style over a deleted span
 * shrinks or disappears, a style over copied text follows it exactly.
 */
export function remapStyles(styles: ZaloStyle[], pieces: RemapPiece[], newTextLength: number): ZaloStyle[] {
  const out: ZaloStyle[] = [];
  for (const s of styles) {
    const sEnd = s.start + s.len;
    const covered: Array<[number, number]> = [];
    for (const p of pieces) {
      const lo = Math.max(s.start, p.oldStart);
      const hi = Math.min(sEnd, p.oldEnd);
      if (lo >= hi) continue;
      if (p.kind === 'copy') covered.push([p.newStart + (lo - p.oldStart), p.newStart + (hi - p.oldStart)]);
      else if (p.newLen > 0) covered.push([p.newStart, p.newStart + p.newLen]);
    }
    covered.sort((a, b) => a[0] - b[0]);
    let cur: [number, number] | null = null;
    const flush = () => {
      if (cur && cur[1] > cur[0]) out.push({ ...s, start: cur[0], len: cur[1] - cur[0] });
    };
    for (const iv of covered) {
      if (cur && iv[0] <= cur[1]) cur[1] = Math.max(cur[1], iv[1]);
      else { flush(); cur = [iv[0], iv[1]]; }
    }
    flush();
  }
  return normalizeZaloStyles(out, newTextLength);
}

/**
 * Group mentions over the same text. Kept in step with `trimRichMentions` below: a mention that does not fit entirely
 * inside the final text is dropped (a half-cut @name would tag the wrong characters).
 */
export interface ZaloMentionRange {
  uid: string;
  pos: number;
  len: number;
  /** 0 = a user, 1 = @all. */
  type: 0 | 1;
}

/**
 * `trimRich` plus mentions: trims the text, keeps the style ranges aligned and shifts every mention by the number of
 * leading characters cut. A mention that touches trimmed whitespace (or is otherwise invalid) is dropped.
 */
export function trimRichMentions(
  text: string,
  styles: ZaloStyle[],
  mentions: ZaloMentionRange[],
): { text: string; styles: ZaloStyle[]; mentions: ZaloMentionRange[] } {
  const trimmedStyles = trimRich(text, styles);
  const trimmed = trimmedStyles.text;
  const offset = trimmed ? text.indexOf(trimmed) : 0;
  const out: ZaloMentionRange[] = [];
  for (const m of mentions) {
    if (!Number.isInteger(m.pos) || !Number.isInteger(m.len) || m.len <= 0) continue;
    const pos = m.pos - offset;
    if (pos < 0 || pos + m.len > trimmed.length) continue;
    out.push({ ...m, pos });
  }
  return { text: trimmed, styles: trimmedStyles.styles, mentions: out };
}

// ── Markdown → rich (for agent-written variants) ──────────────────────

const MD_MARKERS: Array<{ mark: string; styles: string[] }> = [
  { mark: '***', styles: ['b', 'i'] },
  { mark: '**', styles: ['b'] },
  { mark: '__', styles: ['u'] },
  { mark: '~~', styles: ['s'] },
  { mark: '*', styles: ['i'] },
];

function findClosing(text: string, mark: string, from: number): number {
  let idx = text.indexOf(mark, from);
  while (idx !== -1) {
    // A closing marker follows a non-space and (for '*') is not half of '**'.
    const prev = text[idx - 1];
    const next = text[idx + mark.length];
    const stuck = mark === '*' && (next === '*' || prev === '*');
    if (idx > from && prev !== undefined && !/\s/.test(prev) && !stuck) return idx;
    idx = text.indexOf(mark, idx + 1);
  }
  return -1;
}

function parseMarkdown(src: string): { text: string; styles: ZaloStyle[] } {
  let text = '';
  const styles: ZaloStyle[] = [];
  let i = 0;
  while (i < src.length) {
    let matched = false;
    for (const { mark, styles: codes } of MD_MARKERS) {
      if (!src.startsWith(mark, i)) continue;
      const after = src[i + mark.length];
      // An opening marker hugs its content: "* item" and "2 * 3" stay literal.
      if (after === undefined || /\s/.test(after)) continue;
      const close = findClosing(src, mark, i + mark.length);
      if (close === -1) continue;
      const inner = parseMarkdown(src.slice(i + mark.length, close));
      if (!inner.text) continue;
      const base = text.length;
      text += inner.text;
      for (const code of codes) styles.push({ st: code, start: base, len: inner.text.length });
      for (const s of inner.styles) styles.push({ ...s, start: s.start + base });
      i = close + mark.length;
      matched = true;
      break;
    }
    if (!matched) { text += src[i]; i++; }
  }
  return { text, styles };
}

/**
 * Convert the light markdown an agent tends to write (**bold**, *italic*,
 * __underline__, ~~strike~~, "# heading") into plain text plus Zalo ranges.
 * Braces are left alone, so `{name}` and `{a|b}` survive for renderTemplate.
 */
export function markdownToRich(markdown: string): { text: string; styles: ZaloStyle[] } {
  // Headings become a bold line; Zalo has no heading style.
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n').map((l) => {
    const h = l.match(/^#{1,4}\s+(.*)$/);
    return h ? `**${h[1].replace(/\*\*/g, '')}**` : l;
  });
  const parsed = parseMarkdown(lines.join('\n'));
  return trimRich(parsed.text, normalizeZaloStyles(parsed.styles, parsed.text.length));
}
