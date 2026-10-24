/** `GET /api/m/care/events?after=` — see events.ts for the stream contract. */

import type { Hono } from 'hono';
import type { CareResyncReason } from './dto.js';
import { createStreamClient, sseChunk, toWireEvent, type CareEventHub, type SseOptions } from './events.js';
import { invalidCursor } from './errors.js';
import type { CareApiContext } from './context.js';

export interface EventsContext {
  api: CareApiContext;
  hub(): CareEventHub;
  sse: SseOptions;
}

function parseSeq(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (!/^\d{1,15}$/.test(raw)) throw invalidCursor();
  return Number(raw);
}

export function registerEventRoutes(sub: Hono, ev: EventsContext): void {
  sub.get('/events', (c) => {
    const m = ev.api.model();
    // Last-Event-ID is what a reconnecting EventSource sends; it wins over the original ?after=.
    const cursor = parseSeq(c.req.header('last-event-id')) ?? parseSeq(c.req.query('after'));

    // Rows, eventSeq and the replay window come from ONE read transaction.
    const initial = m.read(() => {
      const latest = m.latestEventSeq();
      const chunks: string[] = [];
      let needSnapshot = cursor === null;
      let resync: CareResyncReason | null = null;

      if (cursor !== null) {
        if (cursor > latest) resync = 'cursor_ahead';
        else if (cursor < latest) {
          const oldest = m.oldestEventSeq();
          if (oldest === null || oldest > cursor + 1) resync = 'cursor_pruned';
          else if (latest - cursor > ev.sse.maxBacklog) resync = 'backlog_too_large';
          else {
            let from = cursor;
            while (from < latest) {
              const batch = m.stores.events.listEventsSince(from, 500).filter((e) => e.seq <= latest);
              if (batch.length === 0) break;
              const readable = new Set(m.readableAccountIds());
              for (const rec of batch) {
                if (readable.has(rec.accountId)) chunks.push(sseChunk(rec.seq, 'care_event', toWireEvent(m, rec)));
                from = rec.seq;
              }
            }
          }
        }
      }
      if (resync) {
        chunks.push(sseChunk(latest, 'resync_required', { reason: resync, eventSeq: latest }));
        needSnapshot = true;
      }
      if (needSnapshot) chunks.push(sseChunk(latest, 'snapshot', m.streamSnapshot()));
      return { latest, chunks };
    });

    const { client, stream, onCancel } = createStreamClient(initial.chunks, initial.latest, ev.api.now, ev.sse);
    const hub = ev.hub();
    hub.attach(client);
    const drop = (): void => hub.detach(client);
    onCancel(drop);
    c.req.raw.signal?.addEventListener('abort', drop, { once: true });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  });
}
