/** Pure parsing helpers shared by the collectors (no I/O). */

import { itemIdFor } from '../util.js';
import type { LayerKey, RawComment, RawItem, SourceKind, SourceVia, Metrics } from '../types.js';

export function str(v: unknown): string | undefined {
  if (typeof v === 'string') { const t = v.trim(); return t || undefined; }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

export function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return Number(v);
  return undefined;
}

export function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** First defined value among the given keys (Apify actors mix camelCase and snake_case). */
export function pick(o: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  return undefined;
}

/** ISO from unix seconds, unix milliseconds, numeric string or any Date-parsable string. */
export function toIso(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  let n: number | undefined;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && /^\d{9,16}$/.test(v.trim())) n = Number(v.trim());
  if (n !== undefined) {
    if (!Number.isFinite(n) || n <= 0) return undefined;
    const ms = n < 1e11 ? n * 1000 : n < 1e14 ? n : n / 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  if (typeof v === 'string') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  return undefined;
}

export function collapse(text: string | undefined, max = 4000): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) : t;
}

export function stripHtml(html: string): string {
  return decodeEntities(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' '));
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

export function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

export interface FeedEntry {
  title: string;
  link: string;
  published?: string;
  description: string;
  author?: string;
  views?: number;
}

function tagText(block: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
  const m = re.exec(block);
  if (!m) return undefined;
  const inner = m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
  return decodeEntities(inner).trim();
}

/** RSS 2.0 `<item>` and Atom `<entry>` (also YouTube's media: extensions). */
export function parseFeed(xml: string): FeedEntry[] {
  const out: FeedEntry[] = [];
  const re = /<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const b = m[2];
    const title = stripHtml(tagText(b, 'title') ?? '').trim();
    let link = tagText(b, 'link') ?? '';
    if (!link || link.startsWith('<')) {
      const alt = /<link[^>]*?href=["']([^"']+)["'][^>]*>/i.exec(b);
      link = alt ? decodeEntities(alt[1]) : '';
    }
    if (!link) link = tagText(b, 'guid') ?? '';
    const published = toIso(tagText(b, 'pubDate') ?? tagText(b, 'published') ?? tagText(b, 'updated') ?? tagText(b, 'dc:date'));
    const descRaw = tagText(b, 'media:description') ?? tagText(b, 'description') ?? tagText(b, 'summary') ?? tagText(b, 'content') ?? '';
    const views = /<media:statistics[^>]*\sviews=["'](\d+)["']/i.exec(b);
    const author = tagText(b.replace(/<\/?author>/g, (x) => x), 'name') ?? tagText(b, 'dc:creator');
    if (!title && !link) continue;
    out.push({
      title, link, ...(published ? { published } : {}),
      description: collapse(stripHtml(descRaw), 1500),
      ...(author ? { author: stripHtml(author) } : {}),
      ...(views ? { views: Number(views[1]) } : {}),
    });
  }
  return out;
}

export interface ItemInit {
  layer: LayerKey; kind: SourceKind; sourceName: string; url: string; via: SourceVia;
  sourceUrl?: string; author?: string; title?: string; text?: string; postedAt?: string; postedText?: string;
  metrics?: Metrics; comments?: RawComment[]; media?: RawItem['media']; ad?: RawItem['ad'];
}

/** Builds a RawItem: id from the url, text collapsed, undefined metrics dropped, comments capped. */
export function makeItem(i: ItemInit): RawItem {
  const metrics: Metrics = {};
  for (const [k, v] of Object.entries(i.metrics ?? {})) if (typeof v === 'number' && Number.isFinite(v)) (metrics as Record<string, number>)[k] = v;
  return {
    id: itemIdFor(i.url),
    layer: i.layer, kind: i.kind, sourceName: i.sourceName, url: i.url, via: i.via,
    ...(i.sourceUrl ? { sourceUrl: i.sourceUrl } : {}),
    ...(i.author ? { author: i.author } : {}),
    ...(i.title ? { title: collapse(i.title, 500) } : {}),
    text: collapse(i.text),
    ...(i.postedAt ? { postedAt: i.postedAt } : {}),
    ...(i.postedText ? { postedText: i.postedText } : {}),
    metrics,
    comments: (i.comments ?? []).slice(0, 50),
    ...(i.media ? { media: i.media } : {}),
    ...(i.ad ? { ad: i.ad } : {}),
  };
}

/** Facebook-style comments from Apify `topComments` / `latestComments`-like arrays. */
export function mapComments(raw: unknown): RawComment[] {
  if (!Array.isArray(raw)) return [];
  const out: RawComment[] = [];
  for (const c of raw) {
    const o = obj(c);
    const text = collapse(str(pick(o, 'text', 'commentText', 'comment')) ?? '', 1500);
    if (!text) continue;
    out.push({
      text,
      ...(str(pick(o, 'profileName', 'ownerUsername', 'author', 'username')) ? { author: str(pick(o, 'profileName', 'ownerUsername', 'author', 'username')) } : {}),
      ...(str(pick(o, 'commentUrl', 'url')) ? { url: str(pick(o, 'commentUrl', 'url')) } : {}),
      ...(num(pick(o, 'likesCount', 'likes', 'likeCount')) !== undefined ? { likes: num(pick(o, 'likesCount', 'likes', 'likeCount')) } : {}),
      ...(toIso(pick(o, 'date', 'timestamp', 'createdAt')) ? { postedAt: toIso(pick(o, 'date', 'timestamp', 'createdAt')) } : {}),
    });
  }
  return out;
}

/** Whole days between two dates for actor inputs ("7 days"), at least 1. */
export function windowDays(sinceIso: string, now: Date): number {
  const ms = now.getTime() - new Date(sinceIso).getTime();
  return Math.max(1, Math.ceil(ms / 86_400_000));
}
