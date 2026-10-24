// Text helpers shared by brain, memory and context builder.

const STOP = new Set(['và', 'của', 'cho', 'các', 'những', 'một', 'là', 'có', 'được', 'trong', 'với', 'the', 'and', 'for', 'that', 'this', 'with']);

export function tokens(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Distinct tokens worth searching for. */
export function significantTokens(text: string, max = 16): string[] {
  const seen = new Set<string>();
  for (const t of tokens(text)) {
    if (t.length < 3 || STOP.has(t)) continue;
    seen.add(t);
    if (seen.size >= max) break;
  }
  return [...seen];
}

/**
 * FTS5 folds accents but not "đ", so "dai ly" would miss "đại lý". Expand each d/đ
 * of a token into both spellings (capped to keep the query small).
 */
function dVariants(t: string): string[] {
  const idx = [...t].flatMap((c, i) => (c === 'd' || c === 'đ' ? [i] : []));
  if (!idx.length || idx.length > 3) return [t];
  const out: string[] = [];
  for (let mask = 0; mask < 1 << idx.length; mask++) {
    const chars = [...t];
    idx.forEach((pos, bit) => (chars[pos] = mask & (1 << bit) ? 'đ' : 'd'));
    out.push(chars.join(''));
  }
  return out;
}

/** Safe FTS5 query: each token quoted; AND mode prefixes the last token. */
export function ftsQuery(text: string, mode: 'and' | 'or', max = 16): string | null {
  const toks = significantTokens(text, max);
  if (!toks.length) {
    const any = tokens(text).slice(0, max);
    if (!any.length) return null;
    toks.push(...any);
  }
  const q = toks.map((t, i) => {
    const star = mode === 'and' && i === toks.length - 1 ? '*' : '';
    const vs = dVariants(t.replace(/"/g, ''));
    const terms = vs.map((v) => `"${v}"${star}`);
    return terms.length > 1 ? `(${terms.join(' OR ')})` : terms[0]!;
  });
  return q.join(mode === 'and' ? ' AND ' : ' OR ');
}

export function clip(text: string, max: number): string {
  if (max <= 0) return '';
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}
