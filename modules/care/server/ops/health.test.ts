import { afterEach, describe, expect, it } from 'vitest';
import { wrapApi } from '../api/test-helpers.js';
import { chat, makeRig, type Rig } from '../application/dispatch-test-kit.js';
import { chatMessage } from '../test-fixtures.js';
import { getCareHealth, type CareHealth } from './health.js';

const MIN = 60_000;
const NOW = 1_800_000_000_000;

let rig: Rig;
afterEach(() => rig?.close());

function health(over: Parameters<typeof getCareHealth>[2] = {}): CareHealth {
  return getCareHealth(rig.fx.a, rig.storesA, { nowMs: NOW, buildVersion: 'test-build', ...over });
}
const acct = (h: CareHealth, id = rig.account.id) => h.accounts.find((a) => a.id === id)!;

describe('health snapshot (AC-030)', () => {
  it('a fresh eligible account without a worker or checkpoint is flagged, and the build/schema/gates are reported', () => {
    rig = makeRig();
    const h = health();
    expect(h.build).toEqual({ version: 'test-build', careSchemaRuntime: 4, careSchemaStored: 4 });
    expect(h.gates).toMatchObject({ moduleEnabled: false, dispatchEnabled: true, autoSendEnabled: true });
    expect(acct(h)).toMatchObject({
      channel: 'zalo',
      desiredState: 'active',
      owner: { writeOwner: 'core', epoch: 1 },
      lock: { state: 'none', holderId: null },
      flags: { sync: true, send: true, ai: true },
    });
    expect(acct(h).issues).toEqual(expect.arrayContaining(['NO_CHECKPOINT', 'LOCK_NOT_HELD']));
    expect(h.level).toBe('warn');
  });

  it('reports sync coverage, queue age, uncertain/needs_review, cooldown and lock liveness under lag', () => {
    rig = makeRig();
    rig.storesA.ownership.setSwitch('module', true, { actor: 't', nowMs: 1 });
    const id = rig.account.id;
    const lock = rig.storesA.ownership.acquire({ accountId: id, holderId: 'worker-a', processToken: 'p1', role: 'core', generation: 1, ttlMs: 30_000, nowMs: NOW });
    expect(lock.ok).toBe(true);

    rig.fx.a
      .prepare(`INSERT INTO care_sync_state (account_id, cursor_namespace, opaque_cursor, revision, covered_until, updated_at) VALUES (?, 'zalo_chat', 'opaque-cursor', 3, ?, ?)`)
      .run(id, NOW - 30 * MIN, NOW - 20 * MIN);

    // a due job waiting 10 minutes, and a claimed job whose lease expired
    rig.storesA.jobs.enqueueJob({ accountId: id, jobType: 'outbox_dispatch', payload: { n: 1 }, dueAtMs: NOW - 10 * MIN, dedupeKey: 'late' });
    const stuck = rig.storesA.jobs.enqueueJob({ accountId: id, jobType: 'sync_poll', payload: { n: 2 }, dueAtMs: NOW - 30 * MIN, dedupeKey: 'stuck' });
    rig.fx.a.prepare(`UPDATE care_jobs SET status = 'claimed', lease_owner = 'dead', claim_token = 'tok', lease_expires_at = ? WHERE id = ?`).run(NOW - 1, stuck.id);

    // outbox: pending (9 min), uncertain, needs_review, rate-limited retry in 5 min
    rig.clock.t = NOW - 9 * MIN;
    const mk = (key: string) => rig.serviceA.enqueue({ conversationId: rig.conversation.id, clientRequestId: key, actor: 'manual', content: chat(`text ${key}`) }).intent;
    mk('r-pending-0001');
    const u = mk('r-uncertain-001');
    const n = mk('r-review-00001');
    const c = mk('r-cooldown-001');
    rig.fx.a.prepare(`UPDATE care_delivery_intents SET status = 'uncertain' WHERE id = ?`).run(u.id);
    rig.fx.a.prepare(`UPDATE care_delivery_intents SET status = 'needs_review' WHERE id = ?`).run(n.id);
    rig.fx.a.prepare(`UPDATE care_delivery_intents SET status = 'retry_wait', last_error_code = 'RATE_LIMITED', next_attempt_at = ? WHERE id = ?`).run(NOW + 5 * MIN, c.id);

    const a = acct(health());
    expect(a.lock).toMatchObject({ state: 'live', holderId: 'worker-a', role: 'core', generation: 1, lockSeq: 1, expiresInMs: 30_000 });
    expect(a.sync).toMatchObject({ lastSyncAgeMs: 20 * MIN, checkpoints: [{ namespace: 'zalo_chat', revision: 3, ageMs: 20 * MIN, coveredUntilMs: NOW - 30 * MIN, coverageLagMs: 30 * MIN }] });
    expect(a.queues.outbox_dispatch).toMatchObject({ pending: 1, due: 1, oldestDueAgeMs: 10 * MIN });
    expect(a.queues.sync_poll).toMatchObject({ claimed: 1, expiredLeases: 1 });
    expect(a.outbox).toMatchObject({
      uncertain: 1,
      needsReview: 1,
      oldestDueAgeMs: 9 * MIN,
      cooldownUntilMs: NOW + 5 * MIN,
      cooldownActive: true,
      nextAttemptAtMs: NOW + 5 * MIN,
      nextAttemptInMs: 5 * MIN,
      byStatus: { pending: 1, uncertain: 1, needs_review: 1, retry_wait: 1 },
    });
    expect(a.issues).toEqual(expect.arrayContaining(['SYNC_STALE', 'QUEUE_BACKLOG', 'EXPIRED_LEASES', 'OUTBOX_UNCERTAIN', 'OUTBOX_NEEDS_REVIEW', 'COOLDOWN_ACTIVE']));
    expect(a.issues).not.toContain('LOCK_NOT_HELD');
    expect(a.level).toBe('warn');

    const h = health();
    expect(h.totals).toMatchObject({ accounts: 1, uncertain: 1, needsReview: 1, dueJobs: 1, withIssues: 1 });
    expect(h.gates.moduleEnabled).toBe(true);

    // the same instant 61 s later: the lock is no longer live
    const later = acct(health({ nowMs: NOW + 61_000 }));
    expect(later.lock.state).toBe('expired');
    expect(later.issues).toContain('LOCK_NOT_HELD');
    // and once released
    if (lock.ok) rig.storesA.ownership.release(lock.lock, NOW + 1);
    expect(acct(health({ nowMs: NOW + 2 })).lock.state).toBe('released');
  });

  it('an erroring account is an error level; a legacy-owned paused account is not nagged about locks or sync', () => {
    rig = makeRig();
    const legacy = rig.storesA.accounts.createAccount({ channel: 'email', connectorKind: 'gmail', nativeAccountId: 'mail', label: 'Mail', desiredState: 'paused', writeOwner: 'legacy' });
    rig.fx.a.prepare(`UPDATE care_accounts SET health_status = 'error' WHERE id = ?`).run(rig.account.id);
    const h = health();
    expect(h.level).toBe('error');
    expect(acct(h).issues).toContain('ACCOUNT_ERROR');
    expect(acct(h, legacy.id)).toMatchObject({ issues: [], level: 'ok', owner: { writeOwner: 'legacy' } });
  });

  it('source-journal lag and bridge state', () => {
    rig = makeRig();
    const id = rig.account.id;
    for (let i = 0; i < 2; i++) rig.storesA.journal.appendSourceJournal({ accountId: id, sourceKind: 'zalo', sourceTable: 't', sourceId: `r${i}`, operation: 'insert', payload: { i } });
    rig.fx.a.prepare(`INSERT INTO care_bridge_state (care_account_id, source_kind, source_account_id, status, watermark_s0, applied_seq, created_at, updated_at) VALUES (?, 'zalo', 'x', 'backfilling', 0, 0, 1, 1)`).run(id);
    rig.storesA.bridge.pin(id, 'replayer', 1);
    const h = health({ nowMs: Date.now() + 10 * MIN });
    expect(h.sourceJournal).toMatchObject({ maxSeq: 2, unappliedEntries: 2 });
    expect(h.sourceJournal.oldestUnappliedAgeMs).toBeGreaterThanOrEqual(10 * MIN);
    expect(acct(h).bridge).toMatchObject({ status: 'backfilling', appliedSeq: 0, unappliedEntries: 2, pins: 1 });
    expect(acct(h).issues).toContain('BRIDGE_LAG');
  });

  it('the event journal range is reported', () => {
    rig = makeRig();
    for (let i = 1; i <= 3; i++) rig.storesA.events.appendEvent({ eventId: `e${i}`, accountId: rig.account.id, eventType: 'message.created', payload: {} });
    rig.fx.a.prepare('DELETE FROM care_events WHERE seq = 1').run();
    expect(health().journal).toEqual({ latestSeq: 3, oldestRetainedSeq: 2, retainedEvents: 2 });
  });
});

describe('health output carries no secrets or content', () => {
  it('contains no message text, label, native id, cursor, credential, claim or retry token', () => {
    rig = makeRig();
    const secretAcct = rig.storesA.accounts.createAccount({
      channel: 'zalo',
      connectorKind: 'fake',
      nativeAccountId: 'native-zalo-0901234567',
      label: 'Shop Bi Mat 0901234567',
      desiredState: 'active',
      writeOwner: 'core',
      syncEnabled: true,
      sendEnabled: true,
    });
    rig.storesA.credentials.saveCredential(secretAcct.id, 'zalo_session', { cookie: 'COOKIE-SECRET-VALUE' });
    rig.fx.a.prepare(`INSERT INTO care_sync_state (account_id, cursor_namespace, opaque_cursor, revision, updated_at) VALUES (?, 'zalo_chat', 'CURSOR-SECRET-VALUE', 1, ?)`).run(secretAcct.id, NOW);
    const m = rig.fx.ingestA.ingestNormalizedMessage(chatMessage(rig.account, { externalConversationKey: 'peer:1', text: 'TOP SECRET BODY 0901234567 buyer@example.com' }));
    expect(m.messageId).toBeTruthy();
    const intent = rig.serviceA.enqueue({ conversationId: rig.conversation.id, clientRequestId: 'r-secret-0001', actor: 'manual', content: chat('OUTBOUND SECRET TEXT') }).intent;
    const [claim] = rig.storesA.outbox.claimDue({ workerId: 'worker-a', leaseDurationMs: 60_000, nowMs: rig.clock.t });
    expect(claim.intentId).toBe(intent.id);
    rig.storesA.ownership.acquire({ accountId: rig.account.id, holderId: 'worker-a', processToken: 'PROCESS-TOKEN-SECRET', role: 'core', generation: 1, ttlMs: 30_000, nowMs: NOW });

    const json = JSON.stringify(health());
    for (const secret of [
      'TOP SECRET BODY',
      'OUTBOUND SECRET TEXT',
      'buyer@example.com',
      'Shop Bi Mat',
      '0901234567',
      'native-zalo',
      'CURSOR-SECRET-VALUE',
      'COOKIE-SECRET-VALUE',
      'PROCESS-TOKEN-SECRET',
      claim.claimToken,
      intent.adapterRetryToken,
    ]) {
      expect(json, secret).not.toContain(secret);
    }
    // the report is still useful: it knows both accounts and the in-flight delivery
    expect(JSON.parse(json).accounts).toHaveLength(2);
    expect(JSON.parse(json).accounts.find((a: { id: string }) => a.id === rig.account.id).outbox.byStatus).toEqual({ sending: 1 });
  });

  it('only the accounts a source gate allows are reported and counted', () => {
    rig = makeRig();
    const other = rig.addAccount('email').account;
    const h = health({ accountFilter: (id) => id === other.id });
    expect(h.accounts.map((a) => a.id)).toEqual([other.id]);
    expect(h.totals.accounts).toBe(1);
  });
});

describe('GET /api/m/care/health', () => {
  it('serves the snapshot behind the read gate and the per-source gate', async () => {
    rig = makeRig();
    const gates = { canRead: true, source: true };
    const api = wrapApi(rig.storesA, rig.fx.a, { canRead: () => gates.canRead, canReadSource: () => gates.source });
    const ok = await api.get('/api/m/care/health');
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body).toMatchObject({ level: expect.any(String), build: { careSchemaRuntime: 4 }, accounts: [{ id: rig.account.id }] });
    expect(JSON.stringify(body)).not.toContain('fixture');

    gates.source = false;
    const hidden = (await (await api.get('/api/m/care/health')).json()) as { accounts: unknown[]; totals: { accounts: number } };
    expect(hidden.accounts).toEqual([]);
    expect(hidden.totals.accounts).toBe(0);

    gates.canRead = false;
    const denied = await api.get('/api/m/care/health');
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: 'READ_DISABLED' });
    // it is read-only: a write verb is not a route
    gates.canRead = true;
    expect((await api.send('POST', '/api/m/care/health', {})).status).toBeGreaterThanOrEqual(400);
    api.handle.close();
  });
});
