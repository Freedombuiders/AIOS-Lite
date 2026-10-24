import type { IngestContext } from './ingest.js';

export interface StickerMedia { staticUrl: string; webpUrl: string | null }
const cache = new Map<string, { media: StickerMedia; expires: number }>();
const pending = new Map<string, Promise<StickerMedia>>();

export function stickerId(body: string): number | null {
  try {
    const value = JSON.parse(body)?.id;
    const id = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch { return null; }
}

function httpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; }
  catch { return null; }
}

/** SDK sticker lookup is read-only; cache and coalesce requests across open chats. */
export async function resolveSticker(ctx: IngestContext, id: number): Promise<StickerMedia> {
  const key = `${ctx.accountId}:${id}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.media;
  const inflight = pending.get(key);
  if (inflight) return inflight;
  const task = (async () => {
    if (ctx.limiter && !ctx.limiter.consume(ctx.accountId, 'query').ok) throw new Error('Đã hết lượt tải sticker, thử lại sau');
    const details = await ctx.api.getStickersDetail([id]);
    const detail = details.find((item) => Number(item.id) === id) ?? details[0];
    const staticUrl = httpUrl(detail?.stickerUrl);
    const webpUrl = httpUrl(detail?.stickerWebpUrl);
    if (!staticUrl && !webpUrl) throw new Error('Không tìm thấy ảnh sticker');
    const media = { staticUrl: staticUrl ?? webpUrl!, webpUrl };
    if (cache.size >= 500) cache.delete(cache.keys().next().value!);
    cache.set(key, { media, expires: Date.now() + 60 * 60_000 });
    return media;
  })();
  pending.set(key, task);
  try { return await task; } finally { pending.delete(key); }
}
