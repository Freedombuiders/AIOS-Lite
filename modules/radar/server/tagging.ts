/** Keyword-based tagging: pure functions, no I/O, no LLM. */

import { foldVi, hasKeyword } from './util.js';
import type { AdDetails, AdView, BuyType, RadarConfig, RawComment, RawItem, TopicDef } from './types.js';

/** Topic keys of the layer whose keywords occur in the text (a post can have several). */
export function topicsFor(text: string, topics: TopicDef[]): string[] {
  const folded = foldVi(text);
  if (!folded) return [];
  const out: string[] = [];
  for (const t of topics) {
    if (t.keywords.some((k) => hasKeyword(folded, k))) out.push(t.key);
  }
  return out;
}

export function isAboutAI(text: string, aiKeywords: string[]): boolean {
  const folded = foldVi(text);
  return aiKeywords.some((k) => hasKeyword(folded, k));
}

/** Title + text + comments of an item as one string, for keyword matching. */
export function itemSearchText(item: RawItem): string {
  return [item.title ?? '', item.text, ...item.comments.map((c) => c.text)].join(' \n ');
}

/** Buy-signal type of a comment, or null. Material is checked first ("cho mình xin" beats "mình"). */
export function classifyBuyComment(text: string, buy: RadarConfig['buyKeywords']): BuyType | null {
  const folded = foldVi(text);
  if (!folded || folded.length < 3) return null;
  const match = (list: string[]) => list.some((k) => hasKeyword(folded, k));
  if (match(buy.material)) return 'material';
  if (match(buy.price)) return 'price';
  if (match(buy.intent)) return 'intent';
  return null;
}

/** Comments that advertise an account for sale: "bán", "inbox mình", "zalo", "slot", a price per month. */
export function isSellerComment(text: string): boolean {
  const folded = foldVi(text);
  if (!folded) return false;
  let score = 0;
  if (/(^|[^a-z0-9])(ban|can ban|nhan ban|cung cap)([^a-z0-9]|$)/.test(folded)) score += 1;
  if (/(^|[^a-z0-9])(inbox|ib|nhan tin|lien he|lh|zalo|sdt|telegram|tele)([^a-z0-9]|$)/.test(folded)) score += 1;
  if (/(^|[^a-z0-9])slot([^a-z0-9]|$)/.test(folded)) score += 1;
  if (/\d+\s*(k|nghin|ngan|tr|trieu|d|vnd)?\s*\/\s*(thang|th|nam|tuan)/.test(folded)) score += 2;
  if (/(bao hanh|uy tin|gia re|chinh chu)/.test(folded)) score += 1;
  return score >= 2;
}

export interface BuyCandidate {
  itemId: string;
  type: BuyType;
  text: string;
  url?: string;
  author?: string;
  seller: boolean;
}

/** Every buy-signal comment of the items, sellers separated out. */
export function buyCandidates(items: RawItem[], buy: RadarConfig['buyKeywords']): BuyCandidate[] {
  const out: BuyCandidate[] = [];
  for (const item of items) {
    for (const c of item.comments) {
      const seller = isSellerComment(c.text);
      const type = classifyBuyComment(c.text, buy);
      if (!type && !seller) continue;
      out.push({ itemId: item.id, type: type ?? 'intent', text: c.text, url: c.url ?? item.url, author: c.author, seller });
    }
  }
  return out;
}

const REL_UNITS: [RegExp, number][] = [
  [/(\d+)\s*(giây|giay|s)\b/i, 1000],
  [/(\d+)\s*(phút|phut|p|m|min)\b/i, 60_000],
  [/(\d+)\s*(giờ|gio|h|hr|hours?)\b/i, 3_600_000],
  [/(\d+)\s*(ngày|ngay|d|days?)\b/i, 86_400_000],
  [/(\d+)\s*(tuần|tuan|w|weeks?)\b/i, 7 * 86_400_000],
];

/** Age in ms from a relative label such as "6 giờ", "1 ngày", "3h"; null when unknown. */
export function ageFromPostedText(postedText: string): number | null {
  const t = postedText.trim();
  if (!t) return null;
  if (/^(vừa xong|vua xong|just now|now)$/i.test(t)) return 0;
  if (/hôm qua|hom qua|yesterday/i.test(t)) return 86_400_000;
  for (const [re, ms] of REL_UNITS) {
    const m = t.match(re);
    if (m) return Number(m[1]) * ms;
  }
  return null;
}

/** Posted within the 24 hours before `now`; unknown times count as inside (the scan window already bounded them). */
export function within24h(postedAt: string | undefined, postedText: string | undefined, now: Date): boolean {
  if (postedAt) {
    const t = Date.parse(postedAt);
    if (Number.isFinite(t)) return now.getTime() - t <= 24 * 3_600_000 + 60_000;
  }
  if (postedText) {
    const age = ageFromPostedText(postedText);
    if (age !== null) return age <= 24 * 3_600_000;
  }
  return true;
}

/** "Video" | "Bài viết tặng tài liệu" | "Bài viết dài" | "Bài viết" | "Tin" | "Quảng cáo" … */
export function typeLabel(item: Pick<RawItem, 'kind' | 'media' | 'text' | 'title' | 'comments'>): string {
  if (item.kind === 'ad') return 'Quảng cáo';
  if (item.kind === 'news') return 'Tin';
  if (item.media === 'video' || item.kind === 'youtube' || item.kind === 'tiktok') return 'Video';
  const folded = foldVi(`${item.title ?? ''} ${item.text}`);
  const giveaway = /(comment|binh luan|cmt)\b.{0,40}\b(nhan|gui|xin)/.test(folded) || /\b(tang|free)\b.{0,30}\b(tai lieu|ebook|prompt|file|template|mau)\b/.test(folded);
  const loops = item.comments.length >= 5 && item.comments.filter((c) => c.text.trim().length <= 12).length / item.comments.length >= 0.6;
  if (giveaway || (loops && /\b(tai lieu|prompt|ebook)\b/.test(folded))) return 'Bài viết tặng tài liệu';
  if (item.text.length > 1200) return 'Bài viết dài';
  if (item.kind === 'fb_group') return 'Bài nhóm';
  return 'Bài viết';
}

// ── Ads ─────────────────────────────────────────────────────────────────

export function adFunnel(ad: Pick<AdDetails, 'ctaType' | 'ctaText' | 'landingUrl' | 'bodyText' | 'linkDescription' | 'title'>): { funnel: AdView['funnel']; label: string } {
  const cta = `${ad.ctaType ?? ''} ${ad.ctaText ?? ''}`;
  const url = (ad.landingUrl ?? '').toLowerCase();
  const body = foldVi(`${ad.bodyText ?? ''} ${ad.title ?? ''} ${ad.linkDescription ?? ''}`);
  if (/MESSAGE_PAGE|MESSENGER|SEND_MESSAGE|WHATSAPP/i.test(cta) || /messenger\.com|m\.me\/|wa\.me\//.test(url) || /nhan tin|messenger/.test(foldVi(ad.ctaText ?? ''))) {
    return { funnel: 'messenger', label: 'Messenger' };
  }
  if (/docs\.google\.com\/forms|forms\.gle|typeform|jotform/.test(url)) return { funnel: 'form', label: 'Google Form' };
  if (/zoom\.us|zoom\.com/.test(url) || /\bzoom\b/.test(foldVi(ad.ctaText ?? ''))) return { funnel: 'zoom', label: 'Zoom free' };
  if (/\bcomment\b|binh luan/.test(foldVi(ad.ctaText ?? '')) || /\b(comment|binh luan)\b.{0,20}\b(nhan|de nhan|xin)/.test(body)) {
    return { funnel: 'comment', label: 'Comment' };
  }
  if (/^https?:\/\//.test(url)) return { funnel: 'web', label: 'Web' };
  if (/\bzoom\b/.test(body)) return { funnel: 'zoom', label: 'Zoom free' };
  return { funnel: 'unknown', label: 'Không rõ' };
}

export function adFormatLabel(displayFormat: string | undefined): string {
  const f = (displayFormat ?? '').toUpperCase();
  if (/IMAGE|CAROUSEL|DCO/.test(f)) return 'Ảnh, carousel';
  if (/VIDEO/.test(f)) return 'Video';
  return 'Không ghi';
}

/** Whole days an ad has been running (at least 1 when it has a start date). */
export function daysRunning(startDate: string | undefined, now: Date, endDate?: string): number {
  if (!startDate) return 0;
  const start = Date.parse(startDate);
  if (!Number.isFinite(start)) return 0;
  const end = endDate && Number.isFinite(Date.parse(endDate)) ? Math.min(Date.parse(endDate), now.getTime()) : now.getTime();
  return Math.max(1, Math.floor((end - start) / 86_400_000));
}

const BOOK_KEYWORDS = ['sách', 'ebook', 'e-book', 'cuốn sách', 'sách điện tử', 'sách ai', 'tài liệu pdf'];

export function sellsBook(text: string): boolean {
  const folded = foldVi(text);
  return BOOK_KEYWORDS.some((k) => hasKeyword(folded, k));
}

/** "docs.google.com", "zalo.me"… or "Messenger" for message CTAs, "Không có" when nothing. */
export function landingLabel(ad: Pick<AdDetails, 'landingUrl' | 'ctaType'>, funnel: AdView['funnel']): string {
  if (funnel === 'messenger') return 'Messenger';
  if (!ad.landingUrl) return 'Không có';
  try {
    return new URL(ad.landingUrl).hostname.replace(/^www\./, '');
  } catch {
    return ad.landingUrl.slice(0, 40);
  }
}

export function commentCount(item: Pick<RawItem, 'metrics' | 'comments'>): number {
  return item.metrics.comments ?? item.comments.length;
}

export type { RawComment };
