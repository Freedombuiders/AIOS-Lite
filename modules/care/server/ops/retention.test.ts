import { afterEach, describe, expect, it } from 'vitest';
import { wrapApi, readStream, sseEvents } from '../api/test-helpers.js';
import { createManualClock } from '../runtime/clock.js';
import { chatMessage, memoryFixture, TEST_KEY, type MemoryFixture } from '../test-fixtures.js';
import { decryptCareFieldStrict } from '../persistence/crypto.js';
import {
  DEFAULT_RETENTION_POLICY,
  normalizeRetentionPolicy,
  pruneCareData,
  pruneEventJournal,
  pruneSourceJournal,
  readRetentionPolicy,
  redactErasedContent,
  runCareRetention,
  runRetentionLoop,
  strictestPolicy,
  writeRetentionPolicy,
} from './retention.js';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const BASE = 1_700_000_000_000;

const open: Array<() => void> = [];
afterEach(() => open.splice(0).forEach((c) => c()));
function fx(): MemoryFixture {
  const f = memoryFixture();
  open.push(f.close);
  return f;
}
const count = (f: MemoryFixture, table: string, where = '1=1') => (f.raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;

/** A live message plus a source-journal row (and legacy link) describing it. */
function messageWithJournal(f: MemoryFixture, key: string, text: string) {
  const res = f.ingest.ingestNormalizedMessage(chatMessage(f.account, { externalConversationKey: key, nativeMessageId: `n-${key}`, text }));
  const messageId = res.messageId!;
  f.stores.legacyLinks.linkLegacy(messageId, 'message', 'zalo', 'zalo_messages', `z-${key}`);
  const seq = f.stores.journal.appendSourceJournal({
    accountId: f.account.id,
    sourceKind: 'zalo',
    sourceTable: 'zalo_messages',
    sourceId: `z-${key}`,
    operation: 'insert',
    payload: { text },
  });
  return { messageId, seq };
}

describe('redaction outranks retention pins (guide section 3)', () => {
  it('a pin protects a live payload from the normal purge, but a deleted message is redacted even while pinned', () => {
    const f = fx();
    const a = messageWithJournal(f, 'a', 'SECRET ONE');
    const b = messageWithJournal(f, 'b', 'SECRET TWO');
    f.stores.bridge.pin(f.account.id, 'migration-run-1', a.seq);

    // control: the existing TTL purge honours the pin and removes nothing
    expect(f.stores.journal.purgePayloadsBefore(Date.now() + DAY)).toBe(0);
    expect(f.stores.journal.readPayload(a.seq)).toEqual({ text: 'SECRET ONE' });

    f.stores.messages.softDeleteMessage(a.messageId);
    const report = redactErasedContent(f.raw, Date.now(), DEFAULT_RETENTION_POLICY);
    expect(report.journalPayloads).toBe(1);
    expect(f.stores.journal.readPayload(a.seq)).toBeNull();
    // the unrelated pinned row is untouched; the deleted one keeps its minimal metadata so a consumer can resume
    expect(f.stores.journal.readPayload(b.seq)).toEqual({ text: 'SECRET TWO' });
    expect(f.raw.prepare('SELECT seq, account_id, source_table, source_id, operation, source_version FROM care_source_journal WHERE seq = ?').get(a.seq)).toEqual({
      seq: a.seq,
      account_id: f.account.id,
      source_table: 'zalo_messages',
      source_id: 'z-a',
      operation: 'insert',
      source_version: 1,
    });
    expect(f.stores.bridge.listPins(f.account.id)).toHaveLength(1);
  });

  it('a TTL purges message bodies, journal payloads (pinned or not) and event replay payloads', () => {
    const f = fx();
    const a = messageWithJournal(f, 'a', 'SECRET ONE');
    f.stores.bridge.pin(f.account.id, 'migration-run-1', a.seq);
    const ev = f.stores.events.appendEvent({ eventId: 'e1', accountId: f.account.id, eventType: 'message.created', payload: { messageId: a.messageId }, replay: { text: 'REPLAY BODY' } });
    expect(f.stores.events.getEventBySeq(ev.seq)).toBeTruthy();

    const policy = normalizeRetentionPolicy({ messageTtlMs: 2 * HOUR });
    // "now" is 3h after the rows were written, far past the message's own sent_at
    const report = redactErasedContent(f.raw, Date.now() + 3 * HOUR, policy);
    expect(report).toMatchObject({ ttlMessages: 1, journalPayloads: 1, replayPayloads: 1 });

    const row = f.raw.prepare('SELECT body_enc, metadata_enc, is_deleted, tombstone, native_message_id FROM care_messages WHERE id = ?').get(a.messageId) as Record<string, unknown>;
    expect(row).toMatchObject({ body_enc: '', metadata_enc: '', is_deleted: 1, tombstone: 1, native_message_id: 'n-a' });
    expect(f.stores.journal.readPayload(a.seq)).toBeNull();
    expect(f.raw.prepare('SELECT replay_enc FROM care_events WHERE seq = ?').get(ev.seq)).toEqual({ replay_enc: null });
    expect(f.stores.bridge.listPins(f.account.id)).toHaveLength(1);
    // idempotent
    expect(redactErasedContent(f.raw, Date.now() + 3 * HOUR, policy)).toMatchObject({ ttlMessages: 0, journalPayloads: 0, replayPayloads: 0, deletedMessageIntents: 0 });
  });

  it('terminal delivery intents of a deleted message are removed with their attempts; open ones are kept', () => {
    const f = fx();
    const m = messageWithJournal(f, 'a', 'x');
    const conv = f.stores.conversations.getConversationByExternalKey(f.account.id, 'a')!;
    const mk = (id: string, status: string, canonical: string | null) => {
      f.raw
        .prepare(
          `INSERT INTO care_delivery_intents (id, account_id, conversation_id, client_request_id, actor, purpose, status, channel, payload_enc, payload_hash,
             adapter_retry_token, owner_epoch, canonical_message_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'manual', 'care', ?, 'zalo', 'x', 'h', ?, 1, ?, 1, 1)`,
        )
        .run(id, f.account.id, conv.id, `req-${id}`, status, `tok-${id}`, canonical);
      f.raw.prepare(`INSERT INTO care_delivery_attempts (id, intent_id, account_id, attempt_no, request_token, owner_epoch, started_at) VALUES (?, ?, ?, 1, ?, 1, 1)`).run(`att-${id}`, id, f.account.id, `tok-${id}`);
    };
    mk('i-sent', 'sent', m.messageId);
    mk('i-uncertain', 'uncertain', m.messageId);
    f.stores.messages.softDeleteMessage(m.messageId);
    const report = redactErasedContent(f.raw, Date.now(), DEFAULT_RETENTION_POLICY);
    expect(report.deletedMessageIntents).toBe(1);
    expect(count(f, 'care_delivery_intents', "id = 'i-sent'")).toBe(0);
    expect(count(f, 'care_delivery_attempts', "intent_id = 'i-sent'")).toBe(0);
    expect(count(f, 'care_delivery_intents', "id = 'i-uncertain'")).toBe(1);
  });
});

describe('pruning goes strictly oldest-first and keeps the SSE resync check valid', () => {
  function seedEvents(f: MemoryFixture, createdAt: number[]) {
    createdAt.forEach((at, i) => {
      const e = f.stores.events.appendEvent({ eventId: `ev-${i + 1}`, accountId: f.account.id, eventType: 'message.created', payload: { messageId: `m${i + 1}` } });
      f.raw.prepare('UPDATE care_events SET created_at = ? WHERE seq = ?').run(at, e.seq);
    });
  }
  const seqs = (f: MemoryFixture) => (f.raw.prepare('SELECT seq FROM care_events ORDER BY seq').all() as Array<{ seq: number }>).map((r) => r.seq);

  it('deletes a contiguous prefix, stops at the first young row even if later rows are old, and keeps the newest', () => {
    const f = fx();
    seedEvents(f, [1, 2, 3, 4, 5, 6].map((i) => BASE + i * HOUR));
    // row 3 is out of order (young): everything after it must stay, even the old-looking row 4
    f.raw.prepare('UPDATE care_events SET created_at = ? WHERE seq = 3').run(BASE + 100 * HOUR);
    expect(pruneEventJournal(f.raw, BASE + 5.5 * HOUR)).toBe(2);
    expect(seqs(f)).toEqual([3, 4, 5, 6]);

    f.raw.prepare('UPDATE care_events SET created_at = ?').run(BASE);
    expect(pruneEventJournal(f.raw, BASE + DAY)).toBe(3);
    expect(seqs(f)).toEqual([6]); // the newest survives
    expect(pruneEventJournal(f.raw, BASE + DAY)).toBe(0);
  });

  it('batches without ever leaving a hole', () => {
    const f = fx();
    seedEvents(f, Array.from({ length: 10 }, (_, i) => BASE + i));
    expect(pruneEventJournal(f.raw, BASE + DAY, 4)).toBe(4);
    expect(seqs(f)).toEqual([5, 6, 7, 8, 9, 10]);
  });

  it('a cursor behind the retained range gets cursor_pruned; one right at the edge resumes without a gap', async () => {
    const f = fx();
    seedEvents(f, [1, 2, 3, 4, 5, 6].map((i) => BASE + i * HOUR));
    expect(pruneEventJournal(f.raw, BASE + 4.5 * HOUR)).toBe(4); // keeps seq 5, 6
    expect(seqs(f)).toEqual([5, 6]);

    const api = wrapApi(f.stores, f.raw, {}, () => undefined);
    open.push(() => api.handle.close());

    const behind = await api.get('/api/m/care/events?after=2');
    const r1 = behind.body!.getReader();
    const t1 = await readStream(r1, (t) => t.includes('event: snapshot'));
    expect(sseEvents(t1.text).find((e) => e.event === 'resync_required')?.data).toMatchObject({ reason: 'cursor_pruned' });
    await r1.cancel();

    const edge = await api.get('/api/m/care/events?after=4');
    const r2 = edge.body!.getReader();
    const t2 = await readStream(r2, (t) => t.includes('"seq":6'));
    const evs = sseEvents(t2.text);
    expect(evs.some((e) => e.event === 'resync_required')).toBe(false);
    expect(evs.filter((e) => e.event === 'care_event').map((e) => e.data.seq)).toEqual([5, 6]);
    await r2.cancel();
  });

  it('source journal: stops at a consumer pin and at an active bridge applied position; the newest row is never removed', () => {
    const f = fx();
    const other = f.stores.accounts.createAccount({ channel: 'email', connectorKind: 'fake', nativeAccountId: 'mail-2', label: 'm', desiredState: 'active', writeOwner: 'core' });
    const add = (accountId: string, n: number) => Array.from({ length: n }, (_, i) => f.stores.journal.appendSourceJournal({ accountId, sourceKind: 'zalo', sourceTable: 't', sourceId: `r${i}`, operation: 'insert', payload: { n: i } }));
    const rowsA = add(f.account.id, 6); // pinned at its 4th row
    const rowsB = add(other.id, 5); // active bridge, applied up to its 2nd row
    f.stores.bridge.pin(f.account.id, 'replayer', rowsA[3]);
    f.raw
      .prepare(`INSERT INTO care_bridge_state (care_account_id, source_kind, source_account_id, status, watermark_s0, applied_seq, created_at, updated_at) VALUES (?, 'email', 'x', 'backfilled', 0, ?, 1, 1)`)
      .run(other.id, rowsB[1]);

    const deleted = pruneSourceJournal(f.raw, Date.now() + DAY);
    expect(deleted).toBe(3 + 2);
    const left = (accountId: string) => (f.raw.prepare('SELECT seq FROM care_source_journal WHERE account_id = ? ORDER BY seq').all(accountId) as Array<{ seq: number }>).map((r) => r.seq);
    expect(left(f.account.id)).toEqual(rowsA.slice(3));
    expect(left(other.id)).toEqual(rowsB.slice(2));

    // pins released and the bridge done: everything older goes, but MAX(seq) (the "now" watermark) stays
    f.stores.bridge.unpin(f.account.id, 'replayer');
    f.raw.prepare(`UPDATE care_bridge_state SET status = 'disabled' WHERE care_account_id = ?`).run(other.id);
    pruneSourceJournal(f.raw, Date.now() + DAY);
    expect(left(f.account.id)).toEqual([]);
    expect(left(other.id)).toEqual([rowsB[4]]);
    expect(f.stores.journal.maxSeq()).toBe(rowsB[4]);
  });
});

describe('scheduled retention', () => {
  it('prunes finished history by window and keeps anything still open', () => {
    const f = fx();
    const old = BASE;
    const now = BASE + 400 * DAY;
    const insertJob = (id: string, status: string) =>
      f.raw
        .prepare(`INSERT INTO care_jobs (id, account_id, job_type, payload_enc, status, owner_epoch, due_at, created_at, updated_at) VALUES (?, ?, 'cleanup', 'x', ?, 1, ?, ?, ?)`)
        .run(id, f.account.id, status, old, old, old);
    insertJob('j-done', 'completed');
    insertJob('j-failed', 'failed');
    insertJob('j-pending', 'pending');
    insertJob('j-claimed', 'claimed');

    const msg = messageWithJournal(f, 'a', 'x');
    const conv = f.stores.conversations.getConversationByExternalKey(f.account.id, 'a')!;
    const run = f.stores.agentRuns.beginRun({ accountId: f.account.id, conversationId: conv.id, triggerMessageId: msg.messageId, contextRevision: 1, policyRevision: 'p', agentId: 'cskh', mode: 'draft' });
    f.stores.agentRuns.completeRun(run.run.id, { status: 'skipped', skipReason: 'observe_only' });
    f.raw.prepare('UPDATE care_agent_runs SET updated_at = ?').run(old);
    const running = f.stores.agentRuns.beginRun({ accountId: f.account.id, conversationId: conv.id, triggerMessageId: msg.messageId, contextRevision: 2, policyRevision: 'p', agentId: 'cskh', mode: 'draft' });
    f.raw.prepare('UPDATE care_agent_runs SET updated_at = ? WHERE id = ?').run(old, running.run.id);

    f.raw.prepare(`INSERT INTO care_backlog_holds (item_kind, item_id, account_id, status, held_at, cutoff_at, reason, held_by, resolved_at, resolved_by) VALUES ('job','h1',?, 'released', ?, ?, 'r','t', ?, 't')`).run(f.account.id, old, old, old);
    f.raw.prepare(`INSERT INTO care_backlog_holds (item_kind, item_id, account_id, status, held_at, cutoff_at, reason, held_by) VALUES ('job','h2',?, 'held', ?, ?, 'r','t')`).run(f.account.id, old, old);

    const result = runCareRetention(f.raw, { nowMs: now, policy: DEFAULT_RETENTION_POLICY });
    expect(result.pruned).toMatchObject({ jobs: 2, agentRuns: 1, resolvedHolds: 1 });
    expect((f.raw.prepare('SELECT id FROM care_jobs ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id)).toEqual(['j-claimed', 'j-pending']);
    expect(count(f, 'care_agent_runs', "status = 'running'")).toBe(1);
    expect(count(f, 'care_backlog_holds', "status = 'held'")).toBe(1);
  });

  it('dry run reports the counts and changes nothing', () => {
    const f = fx();
    f.raw
      .prepare(`INSERT INTO care_jobs (id, account_id, job_type, payload_enc, status, owner_epoch, due_at, created_at, updated_at) VALUES ('j1', ?, 'cleanup', 'x', 'completed', 1, 1, 1, 1)`)
      .run(f.account.id);
    const dry = runCareRetention(f.raw, { nowMs: BASE, dryRun: true, policy: DEFAULT_RETENTION_POLICY });
    expect(dry.pruned.jobs).toBe(1);
    expect(count(f, 'care_jobs')).toBe(1);
    expect(runCareRetention(f.raw, { nowMs: BASE, policy: DEFAULT_RETENTION_POLICY }).pruned.jobs).toBe(1);
    expect(count(f, 'care_jobs')).toBe(0);
  });

  it('policy: defaults are conservative, too-small windows are refused, persisted policy round-trips, stricter wins', () => {
    const f = fx();
    expect(DEFAULT_RETENTION_POLICY.messageTtlMs).toBeNull();
    expect(normalizeRetentionPolicy({ eventsMs: 5, jobsMs: Number.NaN, messageTtlMs: 10 })).toEqual(DEFAULT_RETENTION_POLICY);
    expect(readRetentionPolicy(f.raw)).toEqual(DEFAULT_RETENTION_POLICY);
    const saved = writeRetentionPolicy(f.raw, { messageTtlMs: 30 * DAY, jobsMs: 2 * DAY });
    expect(readRetentionPolicy(f.raw)).toEqual(saved);
    const strict = strictestPolicy(saved, normalizeRetentionPolicy({ messageTtlMs: 7 * DAY, jobsMs: 20 * DAY }));
    expect(strict).toMatchObject({ messageTtlMs: 7 * DAY, jobsMs: 2 * DAY });
    expect(strictestPolicy(DEFAULT_RETENTION_POLICY, DEFAULT_RETENTION_POLICY).messageTtlMs).toBeNull();
  });

  it('the scheduler runs on the injected clock, stops on abort, and reports a failing pass without the raw error', async () => {
    const f = fx();
    const clock = createManualClock(BASE);
    const results: number[] = [];
    const errors: unknown[] = [];
    const ctl = new AbortController();
    const done = runRetentionLoop({ db: f.raw, clock, intervalMs: HOUR, onResult: (r) => results.push(r.atMs), onError: (e) => errors.push(e) }, ctl.signal);
    await Promise.resolve();
    expect(results).toEqual([BASE]);
    await clock.advance(HOUR);
    expect(results).toEqual([BASE, BASE + HOUR]);

    f.raw.exec('DROP TABLE care_jobs');
    f.raw.exec('CREATE TABLE care_jobs (id TEXT)'); // a pass that now fails
    await clock.advance(HOUR);
    expect(errors).toHaveLength(1);
    expect(JSON.stringify(errors[0])).not.toContain('node_modules');
    ctl.abort();
    await done;
  });
});

describe('pruneCareData also removes old terminal delivery history', () => {
  it('drops terminal intents past the attempts window and keeps open/uncertain ones', () => {
    const f = fx();
    const conv = f.stores.conversations.upsertConversation({ accountId: f.account.id, externalKey: 'p', kind: 'direct', title: 't' });
    const mk = (id: string, status: string) => {
      f.raw
        .prepare(
          `INSERT INTO care_delivery_intents (id, account_id, conversation_id, client_request_id, actor, purpose, status, channel, payload_enc, payload_hash,
             adapter_retry_token, owner_epoch, created_at, updated_at) VALUES (?, ?, ?, ?, 'manual', 'care', ?, 'zalo', 'x', 'h', ?, 1, ?, ?)`,
        )
        .run(id, f.account.id, conv.id, `r-${id}`, status, `t-${id}`, BASE, BASE);
      f.raw.prepare(`INSERT INTO care_delivery_attempts (id, intent_id, account_id, attempt_no, request_token, owner_epoch, started_at) VALUES (?, ?, ?, 1, ?, 1, ?)`).run(`a-${id}`, id, f.account.id, `t-${id}`, BASE);
    };
    mk('old-sent', 'sent');
    mk('old-failed', 'failed');
    mk('old-uncertain', 'uncertain');
    mk('old-needs-review', 'needs_review');
    const report = pruneCareData(f.raw, BASE + 400 * DAY, DEFAULT_RETENTION_POLICY);
    expect(report.terminalIntents).toBe(2);
    expect((f.raw.prepare('SELECT id FROM care_delivery_intents ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id)).toEqual(['old-needs-review', 'old-uncertain']);
    expect(count(f, 'care_delivery_attempts')).toBe(2);
  });
});

describe('bridge artifact payloads of erased sources', () => {
  const art = (f: MemoryFixture, table: string, id: string, over: { deleted?: boolean; image?: Record<string, unknown>; before?: Record<string, unknown> } = {}) =>
    f.stores.bridge.upsertArtifact({
      id: `art-${table}-${id}`,
      accountId: f.account.id,
      sourceKind: 'zalo',
      sourceTable: table,
      sourceId: id,
      state: 'sent',
      sourceDeleted: over.deleted ?? false,
      sourceVersion: 7,
      payload: { image: over.image ?? { text: `OUTBOX TEXT ${id} 0901234567` }, ...(over.before ? { deletedBeforeImage: over.before } : {}) },
    });
  const rawPlain = (f: MemoryFixture, id: string) =>
    decryptCareFieldStrict((f.raw.prepare('SELECT payload_enc FROM care_bridge_artifacts WHERE id = ?').get(`art-${id}`) as { payload_enc: string }).payload_enc, TEST_KEY);

  it('a deleted source keeps no content fragment (row image or deletedBeforeImage); metadata and reads survive', () => {
    const f = fx();
    art(f, 'zalo_outbox', 'gone', { deleted: true, image: null as never, before: { text: 'DELETED BEFORE IMAGE SECRET', phone: '0912345678' } });
    art(f, 'zalo_outbox', 'gone2', { deleted: true });
    art(f, 'zalo_outbox', 'live');
    expect(rawPlain(f, 'zalo_outbox-gone')).toContain('DELETED BEFORE IMAGE SECRET');

    const report = redactErasedContent(f.raw, Date.now(), DEFAULT_RETENTION_POLICY, { key: TEST_KEY });
    expect(report).toMatchObject({ artifactPayloads: 2, artifactsUnredacted: 0 });

    for (const id of ['gone', 'gone2']) {
      const plain = rawPlain(f, `zalo_outbox-${id}`);
      expect(plain).toBe('{"image":null,"redacted":true}');
      expect(plain).not.toMatch(/SECRET|OUTBOX TEXT|0912345678|0901234567/);
      const a = f.stores.bridge.getArtifact('zalo', 'zalo_outbox', id)!; // reads still work
      expect(a).toMatchObject({ sourceDeleted: true, state: 'sent', sourceVersion: 7, payload: { image: null, redacted: true }, dispatchable: false });
    }
    expect(rawPlain(f, 'zalo_outbox-live')).toContain('OUTBOX TEXT live');
    // idempotent, and the row keeps working for the legacy readers that look at payload.image
    expect(redactErasedContent(f.raw, Date.now(), DEFAULT_RETENTION_POLICY, { key: TEST_KEY }).artifactPayloads).toBe(0);
    expect(f.stores.bridge.listArtifacts(f.account.id)).toHaveLength(3);
  });

  it('without a key nothing is rewritten, and the gap is reported', () => {
    const f = fx();
    art(f, 'zalo_outbox', 'gone', { deleted: true });
    const report = redactErasedContent(f.raw, Date.now(), DEFAULT_RETENTION_POLICY);
    expect(report).toMatchObject({ artifactPayloads: 0, artifactsUnredacted: 1 });
    expect(rawPlain(f, 'zalo_outbox-gone')).toContain('OUTBOX TEXT');
  });

  it('a TTL redacts old content mirrors but not configuration mirrors', () => {
    const f = fx();
    art(f, 'zalo_outbox', 'old');
    art(f, 'zalo_agent_runs', 'oldrun');
    art(f, 'zalo_accounts', 'cfg', { image: { signature: 'KEEP ME' } });
    art(f, 'zalo_outbox', 'fresh');
    f.raw.prepare(`UPDATE care_bridge_artifacts SET updated_at = ? WHERE source_id IN ('old','oldrun','cfg')`).run(BASE);
    f.raw.prepare(`UPDATE care_bridge_artifacts SET updated_at = ? WHERE source_id = 'fresh'`).run(BASE + 400 * DAY);
    const policy = normalizeRetentionPolicy({ messageTtlMs: 30 * DAY });
    const report = redactErasedContent(f.raw, BASE + 400 * DAY + HOUR, policy, { key: TEST_KEY });
    expect(report.artifactPayloads).toBe(2);
    expect(rawPlain(f, 'zalo_outbox-old')).toBe('{"image":null,"redacted":true}');
    expect(rawPlain(f, 'zalo_agent_runs-oldrun')).toBe('{"image":null,"redacted":true}');
    expect(rawPlain(f, 'zalo_accounts-cfg')).toContain('KEEP ME');
    expect(rawPlain(f, 'zalo_outbox-fresh')).toContain('OUTBOX TEXT fresh');
  });

  it('the scheduled pass redacts artifacts when given the key', () => {
    const f = fx();
    art(f, 'zalo_outbox', 'gone', { deleted: true });
    const result = runCareRetention(f.raw, { nowMs: Date.now(), policy: DEFAULT_RETENTION_POLICY, key: TEST_KEY });
    expect(result.redaction.artifactPayloads).toBe(1);
  });
});
