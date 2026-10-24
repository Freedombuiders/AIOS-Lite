/**
 * `GET /messages/:id/media?i=N`: the stored copy of image N of a message (application/media-cache.ts).
 * 404 for an unknown, deleted or unreadable message, a non-image attachment, and an image that could not be copied;
 * the inbox then shows the attachment's metadata chip instead.
 */

import type { Hono } from 'hono';
import type { CareApiContext } from './context.js';
import { notFound } from './errors.js';
import { idParam, intParam } from './util.js';

export function registerMediaRoutes(sub: Hono, ctx: CareApiContext): void {
  sub.get('/messages/:id/media', async (c) => {
    if (!ctx.media) throw notFound();
    const msg = ctx.model().stores.messages.getMessage(idParam(c.req.param('id')));
    if (!msg || !ctx.canReadSource(msg.accountId)) throw notFound();
    const index = intParam(c.req.query('i'), 'i', { min: 0, max: 99, fallback: 0 });
    const media = await ctx.media.get(msg, index);
    if (!media) throw notFound();
    return new Response(new Uint8Array(media.bytes), {
      headers: {
        'Content-Type': media.mimeType,
        'Content-Length': String(media.bytes.length),
        'Cache-Control': 'private, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    });
  });
}
