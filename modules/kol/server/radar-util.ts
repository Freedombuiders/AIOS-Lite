/** Small pure helpers shared by collectors, pipeline and renderer. */

import { createHash } from 'crypto';

/** Canonical form of a post url: https, no tracking query, no trailing slash, no fragment. */
export function canonicalUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    u.protocol = 'https:';
    u.hash = '';
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|__cft__|__tn__|mibextid|rdid|share_url|ref|s|t)$/i.test(key) || key.startsWith('utm_')) {
        u.searchParams.delete(key);
      }
    }
    u.hostname = u.hostname.replace(/^(m|mbasic|web)\.facebook\.com$/i, 'www.facebook.com').replace(/^twitter\.com$/i, 'x.com');
    let out = u.toString();
    if (out.endsWith('/')) out = out.slice(0, -1);
    return out;
  } catch {
    return url.trim();
  }
}

/** Stable item id: first 16 hex chars of sha1(canonical url). */
export function itemIdFor(url: string): string {
  return createHash('sha1').update(canonicalUrl(url)).digest('hex').slice(0, 16);
}

/** Lowercase, accents and đ removed, whitespace collapsed: for keyword matching. */
export function foldVi(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when `keyword` occurs in `folded` (already foldVi'd) as a whole word or phrase.
 * Short keywords ("ai", "gpt") must stand alone so "tai", "mai" do not match.
 */
export function hasKeyword(folded: string, keyword: string): boolean {
  const k = foldVi(keyword);
  if (!k) return false;
  const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(folded);
}

/** Vietnamese thousands separator: 14556 → "14.556". */
export function fmtInt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '0';
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** Compact Vietnamese count: 2_900_000 → "2,9 triệu", 1_290_000 → "1,29 triệu", 44_000 → "44.000". */
export function fmtCompact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '0';
  if (Math.abs(n) >= 1_000_000) {
    const v = n / 1_000_000;
    const s = (v >= 10 ? v.toFixed(1) : v.toFixed(2)).replace(/\.?0+$/, '').replace('.', ',');
    return `${s} triệu`;
  }
  return fmtInt(n);
}

const WEEKDAYS = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];

/** "2026-10-17" → { dateLabel: "17/10/2026", weekday: "Thứ Bảy", day: "17", monthLabel: "tháng 10/2026", short: "17/10" }. */
export function dayLabels(isoDay: string): { dateLabel: string; weekday: string; day: string; monthLabel: string; short: string } {
  const [y, m, d] = isoDay.split('-').map((x) => Number(x));
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const dd = String(d).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  return { dateLabel: `${dd}/${mm}/${y}`, weekday, day: String(d), monthLabel: `tháng ${m}/${y}`, short: `${dd}/${mm}` };
}

/** Whitespace-collapsed and clipped with an ellipsis. */
export function clip(text: string, max: number): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** Two-letter avatar initials: "Giáo viên" → "GV", "Phụ huynh" → "PH", "Marketing" → "M". */
export function initials(name: string): string {
  const words = name.replace(/[()[\]"'“”]/g, ' ').split(/[\s,]+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0][0].toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** Comment heat of a community/post: Rất nóng ≥100 · Nóng ≥50 · Ấm ≥20 · Yên <20. */
export function heatLevel(comments: number): { level: 0 | 1 | 2 | 3; label: string } {
  if (comments >= 100) return { level: 3, label: 'Rất nóng' };
  if (comments >= 50) return { level: 2, label: 'Nóng' };
  if (comments >= 20) return { level: 1, label: 'Ấm' };
  return { level: 0, label: 'Yên' };
}

/** Every top-level JSON object found in the text (fenced or bare), in order of appearance. */
export function extractJsonObjects(raw: string): unknown[] {
  const candidates: string[] = [];
  for (const m of raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) candidates.push(m[1].trim());
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    for (let j = i; j < raw.length; j++) {
      const ch = raw[j];
      if (inStr) {
        if (ch === '\\') j++;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        candidates.push(raw.slice(i, j + 1));
        i = j;
        break;
      }
    }
  }
  const out: unknown[] = [];
  for (const c of new Set(candidates.map((x) => x.trim()))) {
    try { out.push(JSON.parse(c)); } catch { /* not JSON */ }
  }
  return out;
}

/** Neutralises tags that could close the <untrusted> wrapper early. */
export function escapeUntrusted(text: string): string {
  return text.replace(/<\/?untrusted/gi, (m) => m.replace('<', '‹'));
}
