// Pure helpers for editing Zalo style ranges in the browser. Mirror of the
// range model in src/zalo/rich-text.ts: styles are { st, start, len } over
// the PLAIN text, so every edit of the text has to move them.

export interface ZaloStyle {
  st: string;
  start: number;
  len: number;
  indentSize?: number;
}

export const STYLE_COLORS = [
  { label: 'Đỏ', st: 'c_db342e', css: '#db342e' },
  { label: 'Cam', st: 'c_f27806', css: '#f27806' },
  { label: 'Vàng', st: 'c_f7b503', css: '#f7b503' },
  { label: 'Xanh lá', st: 'c_15a85f', css: '#15a85f' },
  { label: 'Xanh dương', st: 'c_2962ff', css: '#2962ff' },
] as const;

export const SIZE_SMALL = 'f_13';
export const SIZE_BIG = 'f_18';

/** Merge overlapping/touching ranges of the same code (block styles stay separate per line). */
export function mergeStyles(styles: ZaloStyle[]): ZaloStyle[] {
  const sorted = styles.filter((s) => s.len > 0).sort((a, b) => a.start - b.start || a.st.localeCompare(b.st));
  const out: ZaloStyle[] = [];
  const last = new Map<string, ZaloStyle>();
  for (const s of sorted) {
    const prev = last.get(s.st);
    const block = s.st.startsWith('lst_') || s.st.startsWith('ind_');
    if (prev && (block ? s.start < prev.start + prev.len : s.start <= prev.start + prev.len)) {
      prev.len = Math.max(prev.start + prev.len, s.start + s.len) - prev.start;
    } else {
      const copy = { ...s };
      out.push(copy);
      last.set(s.st, copy);
    }
  }
  return out;
}

/**
 * Keep ranges attached to their words while the user types. The edit is
 * recovered by diffing old and new text (common prefix/suffix), which is
 * exact for typing, deleting and pasting a single block.
 *
 * Text typed right after a styled span is NOT styled: a plain textarea has
 * no caret formatting state, and extending would make formatting spread
 * unexpectedly.
 */
export function adjustStylesForEdit(styles: ZaloStyle[], oldText: string, newText: string): ZaloStyle[] {
  if (oldText === newText) return styles;
  let p = 0;
  const max = Math.min(oldText.length, newText.length);
  while (p < max && oldText[p] === newText[p]) p++;
  let suffix = 0;
  while (suffix < max - p && oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]) suffix++;
  const q = oldText.length - suffix; // old text [p, q) was replaced
  const added = newText.length - suffix - p;
  const delta = added - (q - p);

  const mapStart = (x: number) => (x < p ? x : x >= q ? x + delta : p + added);
  const mapEnd = (x: number) => (x <= p ? x : x >= q ? x + delta : p);
  const out: ZaloStyle[] = [];
  for (const s of styles) {
    const start = mapStart(s.start);
    const end = mapEnd(s.start + s.len);
    if (end > start) out.push({ ...s, start, len: end - start });
  }
  return out;
}

/** True when every character of [start, end) is covered by `st`. */
export function isCovered(styles: ZaloStyle[], match: (st: string) => boolean, start: number, end: number): boolean {
  if (end <= start) return false;
  const ranges = styles.filter((s) => match(s.st)).sort((a, b) => a.start - b.start);
  let pos = start;
  for (const r of ranges) {
    if (r.start > pos) break;
    pos = Math.max(pos, r.start + r.len);
    if (pos >= end) return true;
  }
  return pos >= end;
}

/** Remove [start, end) from every range matching `match`, splitting ranges that straddle it. */
export function subtractRange(styles: ZaloStyle[], match: (st: string) => boolean, start: number, end: number): ZaloStyle[] {
  const out: ZaloStyle[] = [];
  for (const s of styles) {
    const sEnd = s.start + s.len;
    if (!match(s.st) || sEnd <= start || s.start >= end) { out.push(s); continue; }
    if (s.start < start) out.push({ ...s, len: start - s.start });
    if (sEnd > end) out.push({ ...s, start: end, len: sEnd - end });
  }
  return out;
}

/** Toggle b/i/u/s (or any single code) over a selection: remove when fully set, else add. */
export function toggleInline(styles: ZaloStyle[], st: string, start: number, end: number): ZaloStyle[] {
  if (end <= start) return styles;
  if (isCovered(styles, (x) => x === st, start, end)) return subtractRange(styles, (x) => x === st, start, end);
  return mergeStyles([...styles, { st, start, len: end - start }]);
}

/** Set one value of an exclusive group (colour `c_` or size `f_`), or clear the group with null. */
export function setExclusive(styles: ZaloStyle[], prefix: 'c_' | 'f_', st: string | null, start: number, end: number): ZaloStyle[] {
  if (end <= start) return styles;
  const cleared = subtractRange(styles, (x) => x.startsWith(prefix), start, end);
  // Clicking the active value again clears it.
  if (st === null || isCovered(styles, (x) => x === st, start, end)) return cleared;
  return mergeStyles([...cleared, { st, start, len: end - start }]);
}

/** Lines overlapped by the selection, as [start, end) of the line text (newline excluded). */
export function selectedLines(text: string, selStart: number, selEnd: number): Array<[number, number]> {
  const lines: Array<[number, number]> = [];
  let pos = 0;
  for (const line of text.split('\n')) {
    const end = pos + line.length;
    // A collapsed caret picks the line it sits in; a range stops at a line it
    // only touches by its trailing newline.
    const hit = selStart === selEnd ? selStart >= pos && selStart <= end : selStart < end && selEnd > pos;
    if (hit && end > pos) lines.push([pos, end]);
    pos = end + 1;
  }
  return lines;
}

/** Toggle a bullet/numbered list over whole lines of the selection. */
export function toggleList(styles: ZaloStyle[], text: string, st: 'lst_1' | 'lst_2', selStart: number, selEnd: number): ZaloStyle[] {
  const lines = selectedLines(text, selStart, selEnd);
  if (lines.length === 0) return styles;
  const allSet = lines.every(([a, b]) => isCovered(styles, (x) => x === st, a, b));
  let next = styles;
  for (const [a, b] of lines) {
    next = subtractRange(next, (x) => x === 'lst_1' || x === 'lst_2', a, b);
  }
  if (allSet) return next;
  // One range per line: Zalo treats each list style range as one block.
  return [...next, ...lines.map(([a, b]) => ({ st, start: a, len: b - a }))].sort((x, y) => x.start - y.start);
}

// ── Preview model ─────────────────────────────────────────────────────

export interface RichRun {
  text: string;
  codes: string[];
}

export interface RichLine {
  runs: RichRun[];
  /** Bullet/number prefix when the line is a list item. */
  marker: string;
}

const INLINE = /^(b|i|u|s|c_[0-9a-f]{6}|f_\d+)$/i;

/** Split text into lines of runs that each carry the inline codes active over them. */
export function buildRichLines(text: string, styles: ZaloStyle[]): RichLine[] {
  const lines: RichLine[] = [];
  let pos = 0;
  let numbered = 0;
  for (const raw of text.split('\n')) {
    const lineStart = pos;
    const lineEnd = pos + raw.length;
    pos = lineEnd + 1;

    const list = styles.find((s) => (s.st === 'lst_1' || s.st === 'lst_2') && s.start < Math.max(lineEnd, lineStart + 1) && s.start + s.len > lineStart);
    let marker = '';
    if (list?.st === 'lst_1') { marker = '•'; numbered = 0; }
    else if (list?.st === 'lst_2') { marker = `${++numbered}.`; }
    else numbered = 0;

    const cuts = new Set<number>([lineStart, lineEnd]);
    for (const s of styles) {
      if (!INLINE.test(s.st)) continue;
      if (s.start > lineStart && s.start < lineEnd) cuts.add(s.start);
      const e = s.start + s.len;
      if (e > lineStart && e < lineEnd) cuts.add(e);
    }
    const points = [...cuts].sort((a, b) => a - b);
    const runs: RichRun[] = [];
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i];
      const b = points[i + 1];
      const codes = styles.filter((s) => INLINE.test(s.st) && s.start <= a && s.start + s.len >= b).map((s) => s.st.toLowerCase());
      runs.push({ text: text.slice(a, b), codes });
    }
    lines.push({ runs, marker });
  }
  return lines;
}

/** Inline CSS for a run's codes. */
export function runStyle(codes: string[]): Record<string, string> {
  const css: Record<string, string> = {};
  const deco: string[] = [];
  for (const c of codes) {
    if (c === 'b') css.fontWeight = '700';
    else if (c === 'i') css.fontStyle = 'italic';
    else if (c === 'u') deco.push('underline');
    else if (c === 's') deco.push('line-through');
    else if (c.startsWith('c_')) css.color = `#${c.slice(2)}`;
    else if (c.startsWith('f_')) css.fontSize = `${Math.round((Number(c.slice(2)) / 15) * 100) / 100}em`;
  }
  if (deco.length) css.textDecoration = deco.join(' ');
  return css;
}

// ── Spintax helper for "Gộp thành spintax" ───────────────────────────

/** True when the whole text is one top-level {a|b|…} group. */
export function isWholeSpintax(text: string): boolean {
  if (!text.startsWith('{') || !text.endsWith('}') || text.startsWith('{{')) return false;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return i === text.length - 1 && text.includes('|');
  }
  return false;
}

/** Add `variant` as one more option: extend an existing whole-text group, otherwise wrap both. */
export function addToSpintax(
  base: { text: string; styles: ZaloStyle[] },
  variant: { text: string; styles: ZaloStyle[] },
): { text: string; styles: ZaloStyle[] } {
  if (isWholeSpintax(base.text)) {
    const at = base.text.length - 1; // position of the closing brace
    return {
      text: `${base.text.slice(0, at)}|${variant.text}}`,
      styles: mergeStyles([
        ...base.styles.map((s) => ({ ...s, len: Math.min(s.len, at - s.start) })).filter((s) => s.len > 0),
        ...variant.styles.map((s) => ({ ...s, start: s.start + at + 1 })),
      ]),
    };
  }
  return {
    text: `{${base.text}|${variant.text}}`,
    styles: mergeStyles([
      ...base.styles.map((s) => ({ ...s, start: s.start + 1 })),
      ...variant.styles.map((s) => ({ ...s, start: s.start + base.text.length + 2 })),
    ]),
  };
}
