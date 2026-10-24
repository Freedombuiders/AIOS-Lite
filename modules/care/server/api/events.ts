/**
 * Care event stream (SSE).
 *
 * Contract:
 *  - Connect without a cursor: one `snapshot` event (rows + `eventSeq`, read in ONE transaction).
 *  - Connect with `after=` / `Last-Event-ID`: replay `(cursor, eventSeq]` from the durable journal
 *    in the same transaction; a cursor the journal no longer covers (pruned, from the future, or
 *    too far behind) yields `resync_required` followed by a fresh `snapshot`.
 *  - Then live events: ONE journal reader per process (`CareEventHub`) polls `care_events`, so
 *    events written by another process (the daemon) arrive too. Clients are fan-out targets.
 *  - Events carry IDs and versions only (a client invalidates and refetches). Payloads are
 *    re-scrubbed through the journal allowlist on the way out.
 *  - Every tick re-evaluates `canRead()` and closes all streams when reading became disallowed.
 *  - Per-client buffer is bounded; a client that cannot keep up is disconnected and resumes via
 *    `Last-Event-ID`. Heartbeat comments keep proxies from idling the connection out.
 */

import { scrubEventPayload } from '../persistence/stores.js';
import type { CareEventRecord } from '../../../_lib/care-kit/types.js';
import type { CareResyncReason, CareWireEvent } from './dto.js';
import type { CareReadModel } from './read-model.js';

export interface SseOptions {
  /** Journal poll period. 0 disables the internal timer (tests drive `tick()` themselves). */
  pollMs: number;
  heartbeatMs: number;
  /** Bytes a client may have queued and unread before it is disconnected. */
  maxBufferBytes: number;
  /** Maximum events replayed from a cursor; further behind means `resync_required`. */
  maxBacklog: number;
}

export const DEFAULT_SSE: SseOptions = { pollMs: 1000, heartbeatMs: 15_000, maxBufferBytes: 256 * 1024, maxBacklog: 1000 };

export interface SseClient {
  /** Last event sequence this client has been sent (or was covered by its snapshot). */
  sentSeq: number;
  lastWriteMs: number;
  /** Returns false when the client's buffer is over its bound (the hub then disconnects it). */
  write(chunk: string): boolean;
  end(): void;
}

export function sseChunk(id: number | null, event: string, data: unknown): string {
  return `${id !== null ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function toWireEvent(read: CareReadModel, rec: CareEventRecord): CareWireEvent {
  return {
    seq: rec.seq,
    type: rec.eventType,
    accountId: rec.accountId,
    conversationId: rec.conversationId,
    conversationRevision: read.conversationRevision(rec.conversationId),
    payload: scrubEventPayload(rec.payload),
  };
}

const BATCH = 500;
const MAX_BATCHES_PER_TICK = 10;

export class CareEventHub {
  private readonly clients = new Set<SseClient>();
  /** Highest journal sequence this hub has already fanned out; null while nobody is connected. */
  private readSeq: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly read: CareReadModel,
    private readonly canRead: () => boolean,
    private readonly now: () => number,
    private readonly opts: SseOptions,
    private readonly onError?: (err: unknown) => void,
  ) {}

  get clientCount(): number {
    return this.clients.size;
  }

  /**
   * Registers a client whose stream already holds everything up to `client.sentSeq`. The caller
   * must attach synchronously after building the initial chunks (no await in between).
   */
  attach(client: SseClient): void {
    this.clients.add(client);
    if (this.readSeq === null) {
      this.readSeq = client.sentSeq;
    } else if (client.sentSeq < this.readSeq) {
      // Another client already advanced the shared reader past this client's snapshot: catch it up.
      this.catchUp(client, this.readSeq);
    }
    this.ensureTimer();
  }

  detach(client: SseClient): void {
    this.clients.delete(client);
    if (this.clients.size === 0) {
      this.readSeq = null;
      this.stopTimer();
    }
  }

  close(): void {
    for (const c of [...this.clients]) this.disconnect(c);
    this.stopTimer();
    this.readSeq = null;
  }

  private ensureTimer(): void {
    if (this.timer || this.opts.pollMs <= 0) return;
    this.timer = setInterval(() => this.tick(), this.opts.pollMs);
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private disconnect(client: SseClient): void {
    this.clients.delete(client);
    try {
      client.end();
    } catch {
      /* already closed */
    }
    if (this.clients.size === 0) {
      this.readSeq = null;
      this.stopTimer();
    }
  }

  private send(client: SseClient, chunk: string): boolean {
    let ok = false;
    try {
      ok = client.write(chunk);
    } catch {
      ok = false;
    }
    if (!ok) {
      this.disconnect(client);
      return false;
    }
    client.lastWriteMs = this.now();
    return true;
  }

  private catchUp(client: SseClient, upTo: number): void {
    let from = client.sentSeq;
    for (let i = 0; i < MAX_BATCHES_PER_TICK && from < upTo; i += 1) {
      const events = this.read.stores.events.listEventsSince(from, BATCH).filter((e) => e.seq <= upTo);
      if (events.length === 0) break;
      const readable = new Set(this.read.readableAccountIds());
      for (const ev of events) {
        from = ev.seq;
        // A source whose read gate is closed contributes no events (not even IDs); the cursor still moves on.
        if (readable.has(ev.accountId) && !this.send(client, sseChunk(ev.seq, 'care_event', toWireEvent(this.read, ev)))) return;
        client.sentSeq = ev.seq;
      }
    }
  }

  /** One poll: gate check, journal fan-out, heartbeat. Safe to call manually. */
  tick(): void {
    try {
      this.tickUnsafe();
    } catch (err) {
      try {
        this.onError?.(err);
      } catch {
        /* never let logging stop the loop */
      }
    }
  }

  private tickUnsafe(): void {
    if (this.clients.size === 0) {
      this.stopTimer();
      return;
    }
    if (!this.canRead()) {
      for (const c of [...this.clients]) {
        this.send(c, sseChunk(null, 'closed', { reason: 'read_disabled' }));
        this.disconnect(c);
      }
      return;
    }

    for (let batch = 0; batch < MAX_BATCHES_PER_TICK && this.readSeq !== null; batch += 1) {
      const events = this.read.stores.events.listEventsSince(this.readSeq, BATCH);
      if (events.length === 0) break;
      // A hole between what we read and what is retained means the journal was pruned under us.
      if (events[0].seq > this.readSeq + 1) {
        this.broadcastResync('cursor_pruned');
        break;
      }
      const readable = new Set(this.read.readableAccountIds());
      for (const ev of events) {
        const visible = readable.has(ev.accountId);
        const chunk = visible ? sseChunk(ev.seq, 'care_event', toWireEvent(this.read, ev)) : '';
        for (const c of [...this.clients]) {
          if (c.sentSeq >= ev.seq) continue;
          if (!visible) c.sentSeq = ev.seq;
          else if (this.send(c, chunk)) c.sentSeq = ev.seq;
        }
      }
      this.readSeq = events[events.length - 1].seq;
      if (events.length < BATCH) break;
    }

    const t = this.now();
    for (const c of [...this.clients]) {
      if (t - c.lastWriteMs >= this.opts.heartbeatMs) this.send(c, ': heartbeat\n\n');
    }
  }

  private broadcastResync(reason: CareResyncReason): void {
    const eventSeq = this.read.latestEventSeq();
    for (const c of [...this.clients]) {
      if (this.send(c, sseChunk(eventSeq, 'resync_required', { reason, eventSeq }))) c.sentSeq = Math.max(c.sentSeq, eventSeq);
    }
    this.readSeq = eventSeq;
  }
}

/** Bounded client backed by a ReadableStream; `desiredSize < 0` means the consumer fell behind. */
export function createStreamClient(
  initialChunks: string[],
  startSeq: number,
  now: () => number,
  opts: SseOptions,
): { client: SseClient; stream: ReadableStream<Uint8Array>; onCancel: (fn: () => void) => void } {
  const encoder = new TextEncoder();
  const initialBytes = initialChunks.reduce((n, c) => n + encoder.encode(c).byteLength, 0) + 16;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;
  let cancelHook: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c;
        c.enqueue(encoder.encode('retry: 3000\n\n'));
        for (const chunk of initialChunks) c.enqueue(encoder.encode(chunk));
      },
      cancel() {
        closed = true;
        cancelHook?.();
      },
    },
    // The initial replay/snapshot is allowed on top of the bound: only LIVE backlog counts as "slow".
    { highWaterMark: opts.maxBufferBytes + initialBytes, size: (chunk) => chunk?.byteLength ?? 0 },
  );

  const client: SseClient = {
    sentSeq: startSeq,
    lastWriteMs: now(),
    write(chunk) {
      if (closed || !controller) return false;
      controller.enqueue(encoder.encode(chunk));
      return (controller.desiredSize ?? -1) >= 0;
    },
    end() {
      if (closed) return;
      closed = true;
      try {
        controller?.close();
      } catch {
        /* already errored/closed */
      }
    },
  };
  return { client, stream, onCancel: (fn) => (cancelHook = fn) };
}
