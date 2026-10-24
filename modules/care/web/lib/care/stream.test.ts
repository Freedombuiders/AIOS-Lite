import { describe, expect, it } from 'vitest';
import type { CareStreamSnapshot, CareWireEvent } from './dto';
import {
  initialStreamState, OFFLINE_AFTER_FAILURES, startCareStream, streamReducer, type EventSourceLike, type StreamAction, type StreamState,
} from './stream';

const snap = (eventSeq: number): CareStreamSnapshot => ({
  eventSeq, counts: { total: 2, waiting: 1, unread: 1 }, accounts: [{ id: 'a1', channel: 'zalo', healthStatus: 'healthy', updatedAtMs: 1 }],
  conversations: [{ id: 'c1', accountId: 'a1', revision: 2, lastActivityMs: 5, waiting: true, remoteUnreadCount: 1 }],
});
const ev = (seq: number, conversationId: string | null = 'c1'): CareWireEvent => ({
  seq, type: 'message.created', accountId: 'a1', conversationId, conversationRevision: conversationId ? seq : null, payload: {},
});
const run = (actions: StreamAction[], from: StreamState = initialStreamState()) => actions.reduce(streamReducer, from);

describe('stream reducer', () => {
  it('snapshot sets server counters and the resume cursor, and goes live', () => {
    const s = run([{ type: 'snapshot', data: snap(7) }]);
    expect(s.conn).toBe('live');
    expect(s.lastSeq).toBe(7);
    expect(s.counts).toEqual({ total: 2, waiting: 1, unread: 1 });
    expect(s.snapshotRows[0].id).toBe('c1');
    expect(s.snapshotTick).toBe(1);
  });

  it('events bump the list tick and only their own conversation tick', () => {
    const s = run([{ type: 'snapshot', data: snap(7) }, { type: 'event', data: ev(8, 'c1') }, { type: 'event', data: ev(9, 'c2') }]);
    expect(s.lastSeq).toBe(9);
    expect(s.listTick).toBe(2);
    expect(s.convTicks).toEqual({ c1: 1, c2: 1 });
  });

  it('account-level events (no conversation) bump the accounts tick', () => {
    const s = run([{ type: 'event', data: ev(1, null) }]);
    expect(s.accountsTick).toBe(1);
    expect(s.convTicks).toEqual({});
  });

  it('replayed events at or below the cursor are ignored', () => {
    const s = run([{ type: 'snapshot', data: snap(10) }, { type: 'event', data: ev(10) }, { type: 'event', data: ev(9) }]);
    expect(s.listTick).toBe(0);
    expect(s.lastSeq).toBe(10);
  });

  it('resync_required resets conversation ticks, bumps resyncTick and moves the cursor to the server head', () => {
    const s = run([
      { type: 'snapshot', data: snap(10) }, { type: 'event', data: ev(11) },
      { type: 'resync', data: { reason: 'cursor_pruned', eventSeq: 500 } },
      { type: 'snapshot', data: snap(500) },
    ]);
    expect(s.resyncTick).toBe(1);
    expect(s.resyncReason).toBe('cursor_pruned');
    expect(s.convTicks).toEqual({});
    expect(s.lastSeq).toBe(500);
    expect(s.conn).toBe('live');
    // an event right after the new head is applied, one at the head is not
    expect(run([{ type: 'event', data: ev(500) }], s).listTick).toBe(s.listTick);
    expect(run([{ type: 'event', data: ev(501) }], s).listTick).toBe(s.listTick + 1);
  });

  it('transport errors show the slow state first and offline after repeated failures', () => {
    let s = run([{ type: 'open' }]);
    expect(s.conn).toBe('live');
    s = run([{ type: 'error', readyState: 0 }], s);
    expect(s.conn).toBe('reconnecting');
    for (let i = 1; i < OFFLINE_AFTER_FAILURES; i += 1) s = run([{ type: 'error', readyState: 0 }], s);
    expect(s.conn).toBe('offline');
    s = run([{ type: 'open' }], s);
    expect(s.conn).toBe('live');
    expect(s.failures).toBe(0);
  });

  it('a browser that gave up (CLOSED) is offline immediately', () => {
    expect(run([{ type: 'error', readyState: 2 }]).conn).toBe('offline');
  });

  it('read_disabled closes for good: later opens and errors do not revive it', () => {
    const s = run([{ type: 'closed', reason: 'read_disabled' }, { type: 'open' }, { type: 'error', readyState: 0 }, { type: 'retry' }]);
    expect(s.conn).toBe('disabled');
  });
});

class FakeES implements EventSourceLike {
  static all: FakeES[] = [];
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;
  private handlers = new Map<string, Array<(ev: { data: string }) => void>>();
  constructor(public url: string) { FakeES.all.push(this); }
  addEventListener(type: string, fn: (ev: { data: string }) => void): void { this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]); }
  close(): void { this.closed = true; this.readyState = 2; }
  emit(type: string, data: unknown): void { for (const h of this.handlers.get(type) ?? []) h({ data: typeof data === 'string' ? data : JSON.stringify(data) }); }
}

function harness() {
  FakeES.all = [];
  let state = initialStreamState();
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const driver = startCareStream({
    buildUrl: (after) => (after === null ? '/api/m/care/events' : `/api/m/care/events?after=${after}`),
    create: (url) => new FakeES(url),
    dispatch: (a) => { state = streamReducer(state, a); },
    getLastSeq: () => state.lastSeq,
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimer: (h) => { (h as { live: boolean }).live = false; },
  });
  return { driver, get state() { return state; }, timers, es: () => FakeES.all[FakeES.all.length - 1] };
}

describe('stream driver', () => {
  it('first connect has no cursor; frames become actions', () => {
    const h = harness();
    expect(h.es().url).toBe('/api/m/care/events');
    h.es().onopen?.({});
    h.es().emit('snapshot', snap(3));
    h.es().emit('care_event', ev(4));
    expect(h.state.lastSeq).toBe(4);
    expect(h.state.conn).toBe('live');
    expect(h.state.convTicks.c1).toBe(1);
  });

  it('malformed frames never throw or change state', () => {
    const h = harness();
    h.es().emit('care_event', '{not json');
    h.es().emit('snapshot', 'null-ish???');
    expect(h.state.lastSeq).toBeNull();
  });

  it('resync_required is surfaced', () => {
    const h = harness();
    h.es().emit('resync_required', { reason: 'backlog_too_large', eventSeq: 99 });
    expect(h.state.resyncTick).toBe(1);
    expect(h.state.lastSeq).toBe(99);
  });

  it('while the browser is still retrying (CONNECTING) the driver does not open a second source', () => {
    const h = harness();
    h.es().readyState = 0;
    h.es().onerror?.({});
    expect(FakeES.all).toHaveLength(1);
    expect(h.state.conn).toBe('reconnecting');
  });

  it('a CLOSED source is reopened after the delay, resuming after the last seq', () => {
    const h = harness();
    h.es().emit('snapshot', snap(12));
    const first = h.es();
    first.readyState = 2;
    first.onerror?.({});
    expect(h.state.conn).toBe('offline');
    expect(h.timers).toHaveLength(1);
    h.timers[0].fn();
    expect(first.closed).toBe(true);
    expect(FakeES.all).toHaveLength(2);
    expect(h.es().url).toBe('/api/m/care/events?after=12');
  });

  it('manual retry closes the old source and resumes from the cursor', () => {
    const h = harness();
    h.es().emit('snapshot', snap(5));
    const first = h.es();
    h.driver.retry();
    expect(first.closed).toBe(true);
    expect(h.es().url).toBe('/api/m/care/events?after=5');
    expect(h.state.conn).toBe('connecting');
  });

  it('a closed event (read disabled) stops reconnecting', () => {
    const h = harness();
    h.es().emit('closed', { reason: 'read_disabled' });
    expect(h.state.conn).toBe('disabled');
    h.driver.retry();
    expect(FakeES.all).toHaveLength(1);
  });

  it('close() cancels a pending reopen', () => {
    const h = harness();
    h.es().readyState = 2;
    h.es().onerror?.({});
    h.driver.close();
    expect(h.timers[0].live).toBe(false);
  });
});
