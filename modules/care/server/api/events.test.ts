import { afterEach, describe, expect, it, vi } from 'vitest';
import { twoHandleFixture, TEST_KEY } from '../test-fixtures.js';
import { createTestCareDatabase } from '../persistence/index.js';
import { T0, appendEvent, makeApi, readStream, seedChat, sseEvents, wrapApi, zaloAccount, type ApiFixture } from './test-helpers.js';

let api: ApiFixture | null = null;
let cleanup: Array<() => void> = [];
afterEach(() => {
  api?.close();
  api = null;
  cleanup.forEach((fn) => fn());
  cleanup = [];
});

async function open(a: ApiFixture, query = '', headers: Record<string, string> = {}) {
  const res = await a.get(`/api/m/care/events${query}`, { headers });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  return { res, reader: res.body!.getReader() };
}

describe('GET /events snapshot and live tail', () => {
  it('sends a snapshot whose eventSeq matches the rows, then only newer events (IDs/versions, no bodies)', async () => {
    api = makeApi();
    const z = zaloAccount(api.stores);
    const conv = seedChat(api.stores, z, 'peer:1', 'Khach hang A', [{ at: T0, text: 'SECRET BODY TEXT' }]);
    appendEvent(api.stores, z.id, conv.id, 1, { messageId: 'm1' });
    appendEvent(api.stores, z.id, conv.id, 2, { messageId: 'm2' });

    const { reader } = await open(api);
    const first = await readStream(reader, (t) => t.includes('event: snapshot'));
    const [snap] = sseEvents(first.text);
    expect(snap.event).toBe('snapshot');
    expect(snap.data.eventSeq).toBe(2);
    expect(snap.id).toBe('2');
    expect(snap.data.counts).toEqual({ total: 1, waiting: 1, unread: 1 });
    expect(snap.data.conversations).toEqual([
      { id: conv.id, accountId: z.id, revision: conv.revision, lastActivityMs: T0, waiting: true, remoteUnreadCount: 1 },
    ]);
    expect(snap.data.accounts[0]).toMatchObject({ id: z.id, channel: 'zalo' });
    expect(first.text).not.toContain('SECRET BODY TEXT');
    expect(first.text).not.toContain('Khach hang A');

    // Events already covered by the snapshot are NOT replayed; a new one arrives on the next tick.
    const e3 = appendEvent(api.stores, z.id, conv.id, 3, { messageId: 'm3' });
    api.handle.hub()!.tick();
    const live = await readStream(reader, (t) => t.includes('event: care_event'));
    const events = sseEvents(live.text).filter((e) => e.event === 'care_event');
    expect(events.map((e) => e.data.seq)).toEqual([3]);
    expect(events[0]).toMatchObject({ id: '3', data: { type: 'message.created', accountId: z.id, conversationId: conv.id, conversationRevision: conv.revision } });
    expect(events[0].data.payload).toEqual({ messageId: 'm3' });
    expect(e3.seq).toBe(3);
    await reader.cancel();
    expect(api.handle.hub()!.clientCount).toBe(0);
  });

  it('re-scrubs journal payloads on the way out (a row with text columns smuggled in raw)', async () => {
    api = makeApi();
    const z = zaloAccount(api.stores);
    const conv = seedChat(api.stores, z, 'peer:1', 'T', [{ at: T0 }]);
    const { reader } = await open(api);
    await readStream(reader, (t) => t.includes('snapshot'));
    api.db
      .prepare(`INSERT INTO care_events (event_id, account_id, conversation_id, event_type, epoch, payload_json, created_at) VALUES ('raw-1', ?, ?, 'message.created', 1, ?, 1)`)
      .run(z.id, conv.id, JSON.stringify({ messageId: 'm9', text: 'LEAKED BODY', subject: 'LEAKED SUBJECT' }));
    api.handle.hub()!.tick();
    const live = await readStream(reader, (t) => t.includes('care_event'));
    expect(live.text).toContain('m9');
    expect(live.text).not.toContain('LEAKED');
    await reader.cancel();
  });

  it('delivers events written by another handle (cross-process journal tail) through one reader for all clients', async () => {
    const fx = twoHandleFixture();
    cleanup.push(() => fx.close());
    const z = zaloAccount(fx.storesA);
    const conv = seedChat(fx.storesA, z, 'peer:1', 'T', [{ at: T0 }]);
    api = wrapApi(fx.storesA, fx.a);
    const spy = vi.spyOn(fx.storesA.events, 'listEventsSince');

    const c1 = await open(api);
    const c2 = await open(api);
    await readStream(c1.reader, (t) => t.includes('snapshot'));
    await readStream(c2.reader, (t) => t.includes('snapshot'));
    expect(api.handle.hub()!.clientCount).toBe(2);

    // The daemon (handle B) appends; the API process (handle A) only polls the journal.
    appendEvent(fx.storesB, z.id, conv.id, 1, { messageId: 'from-daemon' });
    spy.mockClear();
    api.handle.hub()!.tick();
    expect(spy).toHaveBeenCalledTimes(1); // ONE reader, fan-out to both clients

    for (const c of [c1, c2]) {
      const got = await readStream(c.reader, (t) => t.includes('care_event'));
      expect(sseEvents(got.text).filter((e) => e.event === 'care_event').map((e) => e.data.payload.messageId)).toEqual(['from-daemon']);
    }
    // Nothing new: a second tick sends nothing more
    api.handle.hub()!.tick();
    const idle = await readStream(c1.reader, (t) => t.includes('care_event'), 150);
    expect(idle.text).not.toContain('care_event');
    await c1.reader.cancel();
    await c2.reader.cancel();
    expect(api.handle.hub()!.clientCount).toBe(0);
  });

  it('catches a late-joining client up to the shared reader without duplicates', async () => {
    api = makeApi();
    const z = zaloAccount(api.stores);
    const conv = seedChat(api.stores, z, 'peer:1', 'T', [{ at: T0 }]);
    const c1 = await open(api);
    await readStream(c1.reader, (t) => t.includes('snapshot'));
    appendEvent(api.stores, z.id, conv.id, 1);
    api.handle.hub()!.tick(); // reader moves to seq 1
    // c2 connects with a cursor BEHIND the shared reader position
    const c2 = await open(api, '?after=0');
    const replay = await readStream(c2.reader, (t) => t.includes('care_event'));
    expect(sseEvents(replay.text).filter((e) => e.event === 'care_event').map((e) => e.data.seq)).toEqual([1]);
    appendEvent(api.stores, z.id, conv.id, 2);
    api.handle.hub()!.tick();
    const more = await readStream(c2.reader, (t) => t.includes('"seq":2'));
    expect(sseEvents(more.text).map((e) => e.data.seq)).toEqual([2]);
    await c1.reader.cancel();
    await c2.reader.cancel();
  });
});

describe('GET /events replay, Last-Event-ID, resync', () => {
  function seed(a: ApiFixture, n: number) {
    const z = zaloAccount(a.stores);
    const conv = seedChat(a.stores, z, 'peer:1', 'T', [{ at: T0 }]);
    for (let i = 1; i <= n; i += 1) appendEvent(a.stores, z.id, conv.id, i, { messageId: `m${i}` });
    return { z, conv };
  }

  it('replays exactly (after, eventSeq] with no snapshot when the cursor is covered', async () => {
    api = makeApi();
    seed(api, 5);
    const { reader } = await open(api, '?after=2');
    const got = await readStream(reader, (t) => (t.match(/event: care_event/g) ?? []).length >= 3);
    const evs = sseEvents(got.text);
    expect(evs.map((e) => e.event)).toEqual(['care_event', 'care_event', 'care_event']);
    expect(evs.map((e) => e.data.seq)).toEqual([3, 4, 5]);
    await reader.cancel();
  });

  it('prefers Last-Event-ID over ?after= on reconnect', async () => {
    api = makeApi();
    seed(api, 5);
    const { reader } = await open(api, '?after=0', { 'Last-Event-ID': '4' });
    const got = await readStream(reader, (t) => t.includes('"seq":5'));
    expect(sseEvents(got.text).map((e) => e.data.seq)).toEqual([5]);
    await reader.cancel();
  });

  it('answers a caught-up cursor with nothing but live events', async () => {
    api = makeApi();
    const { z, conv } = seed(api, 3);
    const { reader } = await open(api, '?after=3');
    const none = await readStream(reader, (t) => t.includes('event:'), 150);
    expect(none.text).not.toContain('event:');
    appendEvent(api.stores, z.id, conv.id, 4);
    api.handle.hub()!.tick();
    const live = await readStream(reader, (t) => t.includes('"seq":4'));
    expect(sseEvents(live.text).map((e) => e.data.seq)).toEqual([4]);
    await reader.cancel();
  });

  it('answers resync_required (then a fresh snapshot) when the cursor was pruned', async () => {
    api = makeApi();
    seed(api, 5);
    api.db.prepare('DELETE FROM care_events WHERE seq <= 3').run();
    const { reader } = await open(api, '?after=1');
    const got = await readStream(reader, (t) => t.includes('event: snapshot'));
    const evs = sseEvents(got.text);
    expect(evs.map((e) => e.event)).toEqual(['resync_required', 'snapshot']);
    expect(evs[0].data).toEqual({ reason: 'cursor_pruned', eventSeq: 5 });
    expect(evs[1].data.eventSeq).toBe(5);
    // resuming from the new position works again
    await reader.cancel();
    const again = await open(api, '?after=5');
    const quiet = await readStream(again.reader, (t) => t.includes('event:'), 120);
    expect(quiet.text).not.toContain('resync_required');
    await again.reader.cancel();
  });

  it('treats a fully pruned journal, a future cursor and a huge backlog as resync cases', async () => {
    api = makeApi();
    seed(api, 4);
    api.db.prepare('DELETE FROM care_events').run();
    const emptied = await open(api, '?after=2');
    expect(sseEvents((await readStream(emptied.reader, (t) => t.includes('snapshot'))).text)[0].data.reason).toBe('cursor_pruned');
    await emptied.reader.cancel();

    const ahead = await open(api, '?after=999');
    const aheadEvs = sseEvents((await readStream(ahead.reader, (t) => t.includes('snapshot'))).text);
    expect(aheadEvs[0]).toMatchObject({ event: 'resync_required', data: { reason: 'cursor_ahead' } });
    await ahead.reader.cancel();

    const small = makeApi({ sse: { maxBacklog: 2 } });
    seed(small, 6);
    const far = await open(small, '?after=1');
    expect(sseEvents((await readStream(far.reader, (t) => t.includes('snapshot'))).text)[0].data.reason).toBe('backlog_too_large');
    await far.reader.cancel();
    small.close();
  });

  it('rejects a malformed cursor', async () => {
    api = makeApi();
    for (const q of ['?after=abc', '?after=-1', '?after=1.5']) {
      const res = await api.get(`/api/m/care/events${q}`);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('INVALID_CURSOR');
    }
    const header = await api.get('/api/m/care/events', { headers: { 'Last-Event-ID': 'zzz' } });
    expect(header.status).toBe(400);
  });

  it('tells a live client to resync when the journal is pruned underneath the shared reader', async () => {
    api = makeApi();
    const { z, conv } = seed(api, 2);
    const { reader } = await open(api);
    await readStream(reader, (t) => t.includes('snapshot'));
    // Events 3..6 appear, then 3..5 are pruned before the reader looked at them
    for (let i = 3; i <= 6; i += 1) appendEvent(api.stores, z.id, conv.id, i);
    api.db.prepare('DELETE FROM care_events WHERE seq BETWEEN 3 AND 5').run();
    api.handle.hub()!.tick();
    const got = await readStream(reader, (t) => t.includes('resync_required'));
    expect(sseEvents(got.text)[0]).toMatchObject({ event: 'resync_required', data: { reason: 'cursor_pruned', eventSeq: 6 } });
    await reader.cancel();
  });
});

describe('GET /events lifecycle', () => {
  it('disconnects a slow client (bounded buffer) and lets it resume via Last-Event-ID', async () => {
    api = makeApi({ sse: { maxBufferBytes: 1200 } });
    const z = zaloAccount(api.stores);
    const conv = seedChat(api.stores, z, 'peer:1', 'T', [{ at: T0 }]);
    const slow = await open(api); // never reads
    const healthy = await open(api);
    await readStream(healthy.reader, (t) => t.includes('snapshot'));

    // Ten ticks of three events: the healthy client drains between ticks, the slow one piles up.
    let seen = '';
    for (let tick = 0; tick < 10; tick += 1) {
      for (let i = 1; i <= 3; i += 1) appendEvent(api.stores, z.id, conv.id, tick * 3 + i, { messageId: `message-number-${tick * 3 + i}` });
      api.handle.hub()!.tick();
      seen += (await readStream(healthy.reader, (t) => t.includes(`"seq":${(tick + 1) * 3}`))).text;
    }
    expect(sseEvents(seen).filter((e) => e.event === 'care_event')).toHaveLength(30);
    expect(api.handle.hub()!.clientCount).toBe(1); // only the slow client was dropped

    // The slow stream ends cleanly after what it had buffered; it resumes from its last id.
    const drained = await readStream(slow.reader, () => false, 400);
    expect(drained.ended).toBe(true);
    const lastSeen = [...sseEvents(drained.text)].filter((e) => e.event === 'care_event').pop()?.id ?? '0';
    expect(Number(lastSeen)).toBeLessThan(30);
    const resumed = await open(api, '', { 'Last-Event-ID': lastSeen });
    const replay = await readStream(resumed.reader, (t) => t.includes('"seq":30'));
    const seqs = sseEvents(replay.text).map((e) => e.data.seq);
    expect(seqs[0]).toBe(Number(lastSeen) + 1);
    expect(seqs[seqs.length - 1]).toBe(30);
    await healthy.reader.cancel();
    await resumed.reader.cancel();
  });

  it('closes the stream when the read gate flips off, and stays closed to new connections', async () => {
    api = makeApi();
    zaloAccount(api.stores);
    const { reader } = await open(api);
    await readStream(reader, (t) => t.includes('snapshot'));
    api.gate.canRead = false;
    api.handle.hub()!.tick();
    const closing = await readStream(reader, () => false, 500);
    expect(sseEvents(closing.text)).toEqual([{ id: null, event: 'closed', data: { reason: 'read_disabled' } }]);
    expect(closing.ended).toBe(true);
    expect(api.handle.hub()!.clientCount).toBe(0);
    expect((await api.get('/api/m/care/events')).status).toBe(403);
  });

  it('sends heartbeats on idle streams and uses a real timer when pollMs > 0', async () => {
    api = makeApi({ sse: { heartbeatMs: 1000 } });
    zaloAccount(api.stores);
    const { reader } = await open(api);
    await readStream(reader, (t) => t.includes('snapshot'));
    api.clock.now += 500;
    api.handle.hub()!.tick();
    expect((await readStream(reader, (t) => t.includes('heartbeat'), 100)).text).not.toContain('heartbeat');
    api.clock.now += 700;
    api.handle.hub()!.tick();
    expect((await readStream(reader, (t) => t.includes('heartbeat'))).text).toContain(': heartbeat');
    await reader.cancel();
    api.close();

    // Timer-driven reader (pollMs > 0): an event appended later is delivered without a manual tick
    const timed = makeApi({ sse: { pollMs: 20 } });
    api = timed;
    const z = zaloAccount(timed.stores);
    const conv = seedChat(timed.stores, z, 'peer:1', 'T', [{ at: T0 }]);
    const stream = await open(timed);
    await readStream(stream.reader, (t) => t.includes('snapshot'));
    appendEvent(timed.stores, z.id, conv.id, 1, { messageId: 'timer' });
    const got = await readStream(stream.reader, (t) => t.includes('timer'), 1500);
    expect(got.text).toContain('timer');
    await stream.reader.cancel();
    expect(timed.handle.hub()!.clientCount).toBe(0);
  });

  it('close() disconnects every stream and a bad store never kills the reader', async () => {
    api = makeApi();
    const z = zaloAccount(api.stores);
    const conv = seedChat(api.stores, z, 'peer:1', 'T', [{ at: T0 }]);
    const { reader } = await open(api);
    await readStream(reader, (t) => t.includes('snapshot'));
    const spy = vi.spyOn(api.stores.events, 'listEventsSince').mockImplementationOnce(() => {
      throw new Error('disk I/O error with /secret/path');
    });
    api.handle.hub()!.tick();
    expect(api.errors).toHaveLength(1);
    spy.mockRestore();
    appendEvent(api.stores, z.id, conv.id, 1);
    api.handle.hub()!.tick();
    expect((await readStream(reader, (t) => t.includes('care_event'))).text).toContain('care_event');
    api.handle.close();
    expect((await readStream(reader, () => false, 300)).ended).toBe(true);
  });
});

describe('snapshot transaction', () => {
  it('reads rows and eventSeq from one snapshot even while another handle appends', async () => {
    const fx = twoHandleFixture();
    cleanup.push(() => fx.close());
    const z = zaloAccount(fx.storesA);
    const conv = seedChat(fx.storesA, z, 'peer:1', 'T', [{ at: T0 }]);
    appendEvent(fx.storesA, z.id, conv.id, 1);
    api = wrapApi(fx.storesA, fx.a);
    const model = (await import('./read-model.js')).CareReadModel;
    const m = new model(fx.a, fx.storesA);

    const seen = m.read(() => {
      const before = m.latestEventSeq();
      // Another process commits an event AND a new conversation in the middle of the read.
      appendEvent(fx.storesB, z.id, conv.id, 2);
      seedChat(fx.storesB, z, 'peer:2', 'Late', [{ at: T0 + 5 }]);
      const snap = m.streamSnapshot();
      return { before, snap };
    });
    expect(seen.before).toBe(1);
    expect(seen.snap.eventSeq).toBe(1); // not 2: the same snapshot
    expect(seen.snap.conversations).toHaveLength(1);
    // Outside the transaction the new state is visible, so a client replaying from eventSeq gets event 2
    const next = m.streamSnapshot();
    expect(next.eventSeq).toBe(2);
    expect(next.conversations).toHaveLength(2);
  });
});

describe('journal sequence behaviour', () => {
  it('does not leave sequence gaps for a rolled-back or duplicate append (so a gap really means pruning)', () => {
    const t = createTestCareDatabase(':memory:', TEST_KEY);
    const z = zaloAccount(t.stores);
    appendEvent(t.stores, z.id, null, 1);
    t.stores.events.appendEvent({ eventId: 'dup', accountId: z.id, eventType: 'x', payload: {} });
    expect(() => t.stores.events.appendEvent({ eventId: 'dup', accountId: z.id, eventType: 'x', payload: {} })).toThrow();
    const after = appendEvent(t.stores, z.id, null, 2);
    expect(after.seq).toBe(3);
    t.close();
  });
});
