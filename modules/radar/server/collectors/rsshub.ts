/** RSSHub: a local feed bridge that reads Facebook, Instagram, Threads and TikTok without Apify credits. Failures never throw out of the collectors. */

import { loadIntegrationValues } from '../integration-values.js';
import { parseChannel, socialHandle } from '../channels.js';
import type { FbGroupSource, FbPageSource, RawItem, SourceKind, SourceStat } from '../types.js';
import { clip } from '../util.js';
import type { CollectContext, CollectDeps } from './index.js';
import { makeItem, obj, str, stripHtml, toIso } from './parse.js';
import type { Outcome } from './sources.js';

export const DEFAULT_RSSHUB_URL = 'http://127.0.0.1:1200';
const FEED_TIMEOUT_MS = 90_000;
const PROBE_TIMEOUT_MS = 3_000;

export interface RsshubTarget { base: string; key?: string }
/** Runs `fn` under a concurrency cap (the caller owns the limiter). */
export type Limit = <T>(fn: () => Promise<T>) => Promise<T>;
/** One outcome plus the names of inputs that failed or came back empty (candidates for a fallback source). */
export interface RsshubOutcome extends Outcome { retry: Set<string> }

/** Where RSSHub lives: injected (tests; null = off) → integration `base_url` → localhost. */
export function resolveRsshub(deps?: CollectDeps): RsshubTarget | null {
  if (deps && 'rsshubBase' in deps) return deps.rsshubBase ? { base: deps.rsshubBase.replace(/\/+$/, '') } : null;
  let values: Record<string, string> | null = null;
  try { values = loadIntegrationValues('rsshub'); } catch { /* not configured */ }
  const base = values?.base_url?.trim() || DEFAULT_RSSHUB_URL;
  const key = values?.access_key?.trim();
  return { base: base.replace(/\/+$/, ''), ...(key ? { key } : {}) };
}

/** GET /healthz with a short timeout. Never throws. */
export async function rsshubReachable(base: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<boolean> {
  try {
    const s = signal ? AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]) : AbortSignal.timeout(PROBE_TIMEOUT_MS);
    const res = await fetchImpl(`${base.replace(/\/+$/, '')}/healthz`, { signal: s });
    return res.status === 200;
  } catch { return false; }
}

/** Vietnamese reason for a non-200 RSSHub answer, taken from its error body. Never echoes urls or secrets. */
export function rsshubErrorMessage(status: number, body: string): string {
  if (/rate limit exceeded/i.test(body)) return 'RSSHub: bị giới hạn tần suất, cần cookie tài khoản phụ trong RSSHub.';
  if (/ConfigNotFoundError/.test(body)) return 'RSSHub: chưa cấu hình cookie/token cho nền tảng này.';
  const m = /(\w*Error)\b:?\s*([^\n<]{0,120})/.exec(body);
  const detail = m ? clip(`${m[1]}: ${m[2]}`.replace(/https?:\/\/\S+/g, '[url]').trim(), 120) : '';
  return detail ? `RSSHub HTTP ${status} (${detail})` : `RSSHub HTTP ${status}`;
}

interface JsonFeedItem { id?: unknown; url?: unknown; title?: unknown; content_html?: unknown; date_published?: unknown; authors?: unknown }

/** One feed as JSON Feed items. Throws an Error with a Vietnamese message on non-200. */
export async function fetchFeed(ctx: CollectContext, t: RsshubTarget, path: string, limit: number): Promise<JsonFeedItem[]> {
  const f = ctx.deps?.fetchImpl ?? fetch;
  const qs = `format=json&limit=${limit}${t.key ? `&key=${encodeURIComponent(t.key)}` : ''}`;
  const timeout = AbortSignal.timeout(FEED_TIMEOUT_MS);
  const res = await f(`${t.base}${path}?${qs}`, { signal: ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout, headers: { Accept: 'application/json' } });
  if (res.status !== 200) throw new Error(rsshubErrorMessage(res.status, await res.text().catch(() => '')));
  const body = obj(await res.json().catch(() => null));
  return Array.isArray(body.items) ? (body.items as JsonFeedItem[]) : [];
}

/** JSON Feed item → RawItem (no metrics, no comments: RSSHub has neither). */
export function mapFeedItem(raw: JsonFeedItem, layer: CollectContext['layer'], kind: SourceKind, sourceName: string, sourceUrl?: string): RawItem | null {
  const url = str(raw.url) ?? str(raw.id);
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const html = str(raw.content_html) ?? '';
  let text = stripHtml(html).replace(/\s+/g, ' ').trim();
  if (kind === 'threads') text = text.replace(/^@[\w.]+\s*:\s*/, '');
  const title = str(raw.title);
  const author = str(obj(Array.isArray(raw.authors) ? raw.authors[0] : null).name)?.replace(/^@/, '');
  return makeItem({
    layer, kind, via: 'rsshub', sourceName, ...(sourceUrl ? { sourceUrl } : {}), url, author,
    text: text || title || '', postedAt: toIso(raw.date_published),
    media: /<video|\.mp4\b/i.test(html) ? 'video' : /<img\b/i.test(html) ? 'image' : 'text',
  });
}

const stat = (kind: SourceKind, name: string, url?: string): SourceStat => ({ kind, name, ...(url ? { url } : {}), via: 'rsshub', ok: false, count: 0 });
const newOutcome = (): RsshubOutcome => ({ items: [], sources: [], notes: [], costUsd: 0, retry: new Set() });
const errText = (e: unknown) => clip(e instanceof Error ? e.message.replace(/https?:\/\/\S+/g, '[url]') : 'lỗi không xác định', 160);

/** One feed → items + stat. `key` identifies the input in `retry` when it failed or was empty. */
async function readOne(
  ctx: CollectContext, t: RsshubTarget, out: RsshubOutcome, path: string, limit: number,
  kind: SourceKind, name: string, url: string | undefined, sourceUrl: string | undefined,
): Promise<RawItem[]> {
  const s = stat(kind, name, url);
  out.sources.push(s);
  try {
    const raw = await fetchFeed(ctx, t, path, limit);
    const items = raw.map((r) => mapFeedItem(r, ctx.layer, kind, name, sourceUrl)).filter((x): x is RawItem => !!x).slice(0, limit);
    s.ok = true; s.count = items.length;
    if (!items.length) out.retry.add(name);
    out.items.push(...items);
    return items;
  } catch (e) {
    s.error = errText(e);
    out.retry.add(name);
    return [];
  }
}

/** Path of a Facebook group feed, or null when the link cannot be read (share/g/ links hide the group id). */
export function rsshubGroupPath(url: string): string | null {
  const c = parseChannel(url, 'fb_group');
  if (!c || c.platform !== 'fb_group' || /\/share\/g\//.test(c.url)) return null;
  return `/facebook/group/${encodeURIComponent(c.handle)}`;
}

/** Path of a Facebook page feed (profile.php?id=N → the numeric id). */
export function rsshubPagePath(url: string): string | null {
  const c = parseChannel(url, 'fb_page');
  return c && c.platform === 'fb_page' ? `/facebook/page/${encodeURIComponent(c.handle)}` : null;
}

/** One Facebook group; null when the link is unsupported. */
export async function collectRsshubGroup(ctx: CollectContext, t: RsshubTarget, group: FbGroupSource): Promise<RsshubOutcome | null> {
  const path = rsshubGroupPath(group.url);
  if (!path) return null;
  const out = newOutcome();
  ctx.log(`Nhóm ${group.name}: đọc qua RSSHub…`);
  await readOne(ctx, t, out, path, ctx.layerConfig.maxPerSource, 'fb_group', group.name, group.url, group.url);
  if (group.members) for (const s of out.sources) s.members = group.members;
  return out;
}

export async function collectRsshubPages(ctx: CollectContext, t: RsshubTarget, pages: FbPageSource[], lim: Limit): Promise<RsshubOutcome> {
  const out = newOutcome();
  ctx.log(`Fanpage đối thủ: đọc ${pages.length} trang qua RSSHub…`);
  await Promise.all(pages.map((p) => lim(async () => {
    const path = rsshubPagePath(p.url);
    if (!path) { out.sources.push({ ...stat('fb_page', p.name, p.url), error: 'Link trang không đọc được qua RSSHub.' }); out.retry.add(p.name); return; }
    await readOne(ctx, t, out, path, ctx.layerConfig.maxPerSource, 'fb_page', p.name, p.url, p.url);
  })));
  return out;
}

/** Instagram handles (links or names). `retry` holds `@handle` names. */
export async function collectRsshubInstagram(ctx: CollectContext, t: RsshubTarget, handles: string[], lim: Limit): Promise<RsshubOutcome> {
  const out = newOutcome();
  const list = [...new Set(handles.map((h) => socialHandle(h, 'instagram')).filter(Boolean))];
  ctx.log(`Instagram: đọc ${list.length} tài khoản qua RSSHub…`);
  await Promise.all(list.map((h) => lim(() => {
    const url = `https://www.instagram.com/${h}/`;
    return readOne(ctx, t, out, `/instagram/user/${encodeURIComponent(h)}`, ctx.layerConfig.maxPerSource, 'instagram', `@${h}`, url, url);
  })));
  return out;
}

export async function collectRsshubThreadsAccounts(ctx: CollectContext, t: RsshubTarget, accounts: string[], lim: Limit): Promise<RsshubOutcome> {
  const out = newOutcome();
  const list = [...new Set(accounts.map((a) => socialHandle(a, 'threads')).filter(Boolean))];
  ctx.log(`Threads: đọc ${list.length} tài khoản qua RSSHub…`);
  await Promise.all(list.map((h) => lim(() => {
    const url = `https://www.threads.net/@${h}`;
    return readOne(ctx, t, out, `/threads/${encodeURIComponent(h)}`, Math.max(10, ctx.layerConfig.maxPerSource), 'threads', `@${h}`, url, url);
  })));
  return out;
}

/** Threads keyword searches. `retry` holds the raw queries. */
export async function collectRsshubThreadsQueries(ctx: CollectContext, t: RsshubTarget, queries: string[], lim: Limit): Promise<RsshubOutcome> {
  const out = newOutcome();
  const qs = [...new Set(queries.map((q) => q.trim()).filter(Boolean))].slice(0, 20);
  ctx.log(`Threads: tìm ${qs.length} từ khoá qua RSSHub…`);
  await Promise.all(qs.map((q) => lim(async () => {
    await readOne(ctx, t, out, `/threads/search/${encodeURIComponent(q)}`, Math.max(10, ctx.layerConfig.maxPerSource), 'threads', `Threads: ${q}`, undefined, undefined);
    // Name → query, so the caller can hand failures to Apify. Only errors (not empty results) count as failed for searches.
    out.retry.delete(`Threads: ${q}`);
    const s = out.sources.find((x) => x.name === `Threads: ${q}`);
    if (s && !s.ok) out.retry.add(q);
  })));
  return out;
}

export async function collectRsshubTiktokAccounts(ctx: CollectContext, t: RsshubTarget, accounts: string[], lim: Limit): Promise<RsshubOutcome> {
  const out = newOutcome();
  const list = [...new Set(accounts.map((a) => socialHandle(a, 'tiktok')).filter(Boolean))];
  ctx.log(`TikTok: đọc ${list.length} tài khoản qua RSSHub…`);
  await Promise.all(list.map((h) => lim(() => {
    const url = `https://www.tiktok.com/@${h}`;
    return readOne(ctx, t, out, `/tiktok/user/@${encodeURIComponent(h)}`, ctx.layerConfig.maxPerSource, 'tiktok', `@${h}`, url, url);
  })));
  return out;
}
