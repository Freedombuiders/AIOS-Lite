// Care event stream (SSE) client: a pure reducer plus a small EventSource driver.
//
// The server sends IDs and versions only. This client never patches rows from an event: it bumps
// "ticks" (list / conversation / resync) and the page refetches through the normal read routes.
// Counters shown in the UI always come from a server response or snapshot, never from local math.

import type { CareConversationCounts, CareResyncReason, CareStreamSnapshot, CareWireEvent } from './dto';

/**
 *  connecting   first connection attempt
 *  live         stream open
 *  reconnecting transport dropped; the browser is retrying with Last-Event-ID (slow banner)
 *  offline      several retries failed or the browser gave up (disconnected banner + retry)
 *  disabled     the server closed the stream because reading Care data was turned off
 */
export type StreamConn = 'connecting' | 'live' | 'reconnecting' | 'offline' | 'disabled';

/** Consecutive failed attempts before "reconnecting" turns into "offline". */
export const OFFLINE_AFTER_FAILURES = 3;

export interface StreamState {
  conn: StreamConn;
  failures: number;
  /** Highest event sequence seen (also set by snapshots); the resume cursor. */
  lastSeq: number | null;
  counts: CareConversationCounts | null;
  accounts: CareStreamSnapshot['accounts'];
  /** Rows from the latest snapshot; the page compares them to what it has loaded. */
  snapshotRows: CareStreamSnapshot['conversations'];
  snapshotTick: number;
  /** Bumped by any event that may change the list order, counters or an unseen row. */
  listTick: number;
  /** Bumped by account-level events (health/status). */
  accountsTick: number;
  /** Per-conversation bump: the open conversation refetches when its own tick moves. */
  convTicks: Record<string, number>;
  /** Bumped when the server said our cursor is unusable: drop all paging state and reload. */
  resyncTick: number;
  resyncReason: CareResyncReason | null;
}

export function initialStreamState(): StreamState {
  return {
    conn: 'connecting', failures: 0, lastSeq: null, counts: null, accounts: [], snapshotRows: [], snapshotTick: 0,
    listTick: 0, accountsTick: 0, convTicks: {}, resyncTick: 0, resyncReason: null,
  };
}

export type StreamAction =
  | { type: 'open' }
  | { type: 'error'; readyState: number }
  | { type: 'snapshot'; data: CareStreamSnapshot }
  | { type: 'event'; data: CareWireEvent }
  | { type: 'resync'; data: { reason: CareResyncReason; eventSeq: number } }
  | { type: 'closed'; reason: string }
  | { type: 'retry' };

const CLOSED = 2; // EventSource.CLOSED

export function streamReducer(s: StreamState, a: StreamAction): StreamState {
  switch (a.type) {
    case 'open':
      return s.conn === 'disabled' ? s : { ...s, conn: 'live', failures: 0 };
    case 'error': {
      if (s.conn === 'disabled') return s;
      const failures = s.failures + 1;
      const conn: StreamConn = a.readyState === CLOSED || failures >= OFFLINE_AFTER_FAILURES ? 'offline' : 'reconnecting';
      return { ...s, conn, failures };
    }
    case 'retry':
      return s.conn === 'disabled' ? s : { ...s, conn: 'connecting', failures: 0 };
    case 'closed':
      return { ...s, conn: 'disabled' };
    case 'snapshot':
      return {
        ...s,
        conn: s.conn === 'disabled' ? s.conn : 'live',
        failures: 0,
        lastSeq: a.data.eventSeq,
        counts: a.data.counts,
        accounts: a.data.accounts,
        snapshotRows: a.data.conversations,
        snapshotTick: s.snapshotTick + 1,
      };
    case 'resync':
      return { ...s, lastSeq: a.data.eventSeq, resyncTick: s.resyncTick + 1, resyncReason: a.data.reason, convTicks: {}, listTick: s.listTick + 1, accountsTick: s.accountsTick + 1 };
    case 'event': {
      const ev = a.data;
      // Replays after a reconnect can repeat what we already handled.
      if (s.lastSeq !== null && ev.seq <= s.lastSeq) return s;
      const next: StreamState = { ...s, lastSeq: ev.seq };
      if (ev.conversationId) {
        next.convTicks = { ...s.convTicks, [ev.conversationId]: (s.convTicks[ev.conversationId] ?? 0) + 1 };
        next.listTick = s.listTick + 1;
      } else {
        next.accountsTick = s.accountsTick + 1;
        next.listTick = s.listTick + 1;
      }
      return next;
    }
  }
}

// ── driver ────────────────────────────────────────────────────────────────────────────────────
export interface EventSourceLike {
  readyState: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onopen: ((ev: any) => any) | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onerror: ((ev: any) => any) | null;
  addEventListener(type: string, listener: (ev: { data: string }) => void): void;
  close(): void;
}

export interface StreamDriverOptions {
  /** Builds the full URL (token included) for a connection that resumes after `after`. */
  buildUrl(after: number | null): string;
  create(url: string): EventSourceLike;
  dispatch(a: StreamAction): void;
  getLastSeq(): number | null;
  /** Manual reopen delay once the browser has given up on its own retries (readyState CLOSED). */
  reopenDelayMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

export interface StreamDriver {
  /** Close and reopen now, resuming after the last known sequence. */
  retry(): void;
  close(): void;
}

function parse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null; // a malformed frame must never take the page down
  }
}

export function startCareStream(opts: StreamDriverOptions): StreamDriver {
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const reopenDelay = opts.reopenDelayMs ?? 4000;
  let es: EventSourceLike | null = null;
  let timer: unknown = null;
  let stopped = false;

  function open(): void {
    if (stopped) return;
    const source = opts.create(opts.buildUrl(opts.getLastSeq()));
    es = source;
    source.onopen = () => opts.dispatch({ type: 'open' });
    source.onerror = () => {
      opts.dispatch({ type: 'error', readyState: source.readyState });
      // The browser retries by itself (with Last-Event-ID) while CONNECTING; only a CLOSED source needs us.
      if (source.readyState === CLOSED && !stopped && timer === null) {
        timer = setTimer(() => {
          timer = null;
          if (es === source) {
            source.close();
            open();
          }
        }, reopenDelay);
      }
    };
    source.addEventListener('snapshot', (ev) => {
      const data = parse<CareStreamSnapshot>(ev.data);
      if (data) opts.dispatch({ type: 'snapshot', data });
    });
    source.addEventListener('care_event', (ev) => {
      const data = parse<CareWireEvent>(ev.data);
      if (data) opts.dispatch({ type: 'event', data });
    });
    source.addEventListener('resync_required', (ev) => {
      const data = parse<{ reason: CareResyncReason; eventSeq: number }>(ev.data);
      if (data) opts.dispatch({ type: 'resync', data });
    });
    source.addEventListener('closed', (ev) => {
      const data = parse<{ reason?: string }>(ev.data);
      // The server will not accept a reconnect while reading is disabled.
      stopped = true;
      source.close();
      opts.dispatch({ type: 'closed', reason: data?.reason ?? 'closed' });
    });
  }

  open();
  return {
    retry() {
      if (stopped) return;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      es?.close();
      opts.dispatch({ type: 'retry' });
      open();
    },
    close() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      es?.close();
      es = null;
    },
  };
}
