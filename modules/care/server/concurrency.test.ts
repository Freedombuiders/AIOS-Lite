import { afterEach, describe, expect, it } from 'vitest';
import { CareError } from '../../_lib/care-kit/errors.js';
import type { CareAccountRecord, CareJobType } from '../../_lib/care-kit/types.js';
import { assignAuto, chatMessage, createEligibleAccount, dumpCareTables, twoHandleFixture } from './test-fixtures.js';

const open: Array<() => void> = [];
afterEach(() => open.splice(0).forEach((close) => close()));

function setup() {
  const f = twoHandleFixture();
  open.push(f.close);
  const account = createEligibleAccount(f.storesA, { nativeAccountId: 'acct-1' });
  return { ...f, account };
}

function enqueue(f: ReturnType<typeof setup>, jobType: CareJobType = 'inbound_turn', extra: Record<string, unknown> = {}) {
  return f.storesA.jobs.enqueueJob({ accountId: f.account.id, jobType, payload: { n: Math.random() }, ownerEpoch: 1, dueAtMs: 0, ...extra });
}

const claim = (stores: ReturnType<typeof setup>['storesA'], workerId: string, nowMs: number, over: Record<string, unknown> = {}) =>
  stores.jobs.claimJobs({ workerId, currentEpoch: 1, leaseDurationMs: 1_000, nowMs, ...over });

describe('Competing claims across SQLite handles (AC-012)', () => {
  it('two workers on separate handles never claim the same job', () => {
    const f = setup();
    const ids = Array.from({ length: 5 }, (_, i) => enqueue(f, 'inbound_turn', { dedupeKey: `job_${i}` }).id);
    const w1 = claim(f.storesA, 'alpha', 100, { limit: 3 });
    const w2 = claim(f.storesB, 'beta', 100, { limit: 5 });
    expect(w1.length + w2.length).toBe(5);
    expect(w1.filter((j) => w2.some((k) => k.id === j.id))).toHaveLength(0);
    expect([...w1, ...w2].map((j) => j.id).sort()).toEqual([...ids].sort());
  });

  it('enqueue is idempotent per (account, dedupeKey) and the key is account-scoped', () => {
    const f = setup();
    const other = createEligibleAccount(f.storesA, { nativeAccountId: 'acct-2' });
    const first = enqueue(f, 'inbound_turn', { dedupeKey: 'same' });
    const again = f.storesB.jobs.enqueueJob({ accountId: f.account.id, jobType: 'inbound_turn', payload: {}, dedupeKey: 'same', ownerEpoch: 1 });
    const elsewhere = f.storesA.jobs.enqueueJob({ accountId: other.id, jobType: 'inbound_turn', payload: {}, dedupeKey: 'same', ownerEpoch: 1 });
    expect(again.id).toBe(first.id);
    expect(elsewhere.id).not.toBe(first.id);
  });

  it('a duplicate event id is suppressed across handles (cross-process ledger)', () => {
    const f = setup();
    assignAuto(f.storesA, f.account);
    const msg = chatMessage(f.account);
    expect(f.ingestA.ingestNormalizedMessage(msg, undefined, 1, 'shared_event').outcome).toBe('created');
    expect(f.ingestB.ingestNormalizedMessage(msg, undefined, 1, 'shared_event').outcome).toBe('duplicate_event');
    expect(f.a.prepare('SELECT count(*) AS n FROM care_jobs').get()).toEqual({ n: 1 });
  });

  it('checkpoint CAS is enforced across handles: the second adapter writer with a stale expectation loses', () => {
    const f = setup();
    f.ingestA.ingestNormalizedMessage(chatMessage(f.account), { namespace: 'zalo_chat', cursor: 'c0' }, 1);
    const winner = f.ingestA.ingestNormalizedMessage(chatMessage(f.account), { namespace: 'zalo_chat', cursor: 'c1', expectedCursor: 'c0' }, 1);
    expect(winner.checkpoint).toBe('advanced');
    expect(() =>
      f.ingestB.ingestNormalizedMessage(chatMessage(f.account), { namespace: 'zalo_chat', cursor: 'c1-b', expectedCursor: 'c0' }, 1),
    ).toThrow(CareError);
    expect(f.storesB.checkpoints.get(f.account.id, 'zalo_chat')!.cursor).toBe('c1');
    expect(f.a.prepare('SELECT count(*) AS n FROM care_messages').get()).toEqual({ n: 2 });
  });

  it('journal events written on one handle are visible on the other (WAL)', () => {
    const f = setup();
    f.storesA.events.appendEvent({ eventId: 'ev_wal_1', accountId: f.account.id, eventType: 'account.status', payload: { healthStatus: 'healthy' } });
    expect(f.storesB.events.listEventsSince(0).map((e) => e.eventId)).toEqual(['ev_wal_1']);
  });
});

describe('Claim token / lease CAS (Finding 8, 13)', () => {
  it('expired lease rejects completion; same worker id reclaiming gets a NEW token that invalidates the old one', () => {
    const f = setup();
    const job = enqueue(f);
    const [c1] = claim(f.storesA, 'alpha', 10_000, { leaseDurationMs: 2_000 });
    expect(c1.id).toBe(job.id);
    expect(f.storesA.jobs.completeJob(job.id, 'alpha', c1.claimToken!, 13_000)).toBe(false); // lease expired

    const [c2] = claim(f.storesB, 'alpha', 14_000, { leaseDurationMs: 5_000 });
    expect(c2.claimToken).not.toBe(c1.claimToken);
    expect(f.storesA.jobs.completeJob(job.id, 'alpha', c1.claimToken!, 14_500)).toBe(false); // stale token, same worker id
    expect(f.storesA.jobs.failJob(job.id, 'alpha', c1.claimToken!, 'stale', true, 0, 14_500)).toBe(false);
    expect(f.storesA.jobs.releaseJob(job.id, 'alpha', c1.claimToken!, 14_500)).toBe(false);
    expect(f.storesA.jobs.renewLease(job.id, 'alpha', c1.claimToken!, 5_000, 14_500)).toBe(false);
    expect(f.storesB.jobs.completeJob(job.id, 'alpha', c2.claimToken!, 14_500)).toBe(true);
    expect(f.storesA.jobs.getJob(job.id)!.status).toBe('completed');
    // completed is terminal
    expect(f.storesB.jobs.completeJob(job.id, 'alpha', c2.claimToken!, 14_600)).toBe(false);
  });

  it('a different worker cannot complete with someone else\'s token', () => {
    const f = setup();
    const job = enqueue(f);
    const [c] = claim(f.storesA, 'alpha', 100);
    expect(f.storesB.jobs.completeJob(job.id, 'beta', c.claimToken!, 150)).toBe(false);
    expect(f.storesB.jobs.completeJob(job.id, 'alpha', 'forged', 150)).toBe(false);
  });

  it('renewal extends only a live lease and keeps the same token valid', () => {
    const f = setup();
    const job = enqueue(f);
    const [c] = claim(f.storesA, 'alpha', 1_000, { leaseDurationMs: 1_000 });
    expect(f.storesA.jobs.renewLease(job.id, 'alpha', c.claimToken!, 10_000, 1_500)).toBe(true);
    expect(f.storesB.jobs.getJob(job.id)!.leaseExpiresAtMs).toBe(11_500);
    expect(claim(f.storesB, 'beta', 5_000)).toEqual([]); // still leased
    expect(f.storesA.jobs.completeJob(job.id, 'alpha', c.claimToken!, 6_000)).toBe(true);
    expect(f.storesA.jobs.renewLease(job.id, 'alpha', c.claimToken!, 1_000, 6_100)).toBe(false);
  });

  it('failJob retries with backoff until attempts run out, then fails terminally; release refunds the attempt', () => {
    const f = setup();
    const job = enqueue(f, 'inbound_turn', { maxAttempts: 2 });
    let [c] = claim(f.storesA, 'w', 100);
    expect(f.storesA.jobs.failJob(job.id, 'w', c.claimToken!, 'boom 1', true, 500, 150)).toBe(true);
    expect(f.storesA.jobs.getJob(job.id)).toMatchObject({ status: 'pending', dueAtMs: 650, lastError: 'boom 1', attempts: 1 });
    expect(claim(f.storesA, 'w', 400)).toEqual([]); // backing off

    [c] = claim(f.storesA, 'w', 700);
    expect(c.attempts).toBe(2);
    expect(f.storesA.jobs.failJob(job.id, 'w', c.claimToken!, 'boom 2', true, 500, 750)).toBe(true);
    expect(f.storesA.jobs.getJob(job.id)!.status).toBe('failed'); // attempts exhausted

    const rel = enqueue(f);
    const [rc] = claim(f.storesA, 'w', 800);
    expect(rc.attempts).toBe(1);
    expect(f.storesA.jobs.releaseJob(rel.id, 'w', rc.claimToken!, 810)).toBe(true);
    expect(f.storesA.jobs.getJob(rel.id)).toMatchObject({ status: 'pending', attempts: 0, claimToken: null });
  });

  it('a job whose lease keeps expiring is failed once attempts are exhausted, never reclaimed forever', () => {
    const f = setup();
    const job = enqueue(f, 'inbound_turn', { maxAttempts: 2 });
    claim(f.storesA, 'a', 100, { leaseDurationMs: 10 });
    claim(f.storesA, 'b', 200, { leaseDurationMs: 10 });
    expect(claim(f.storesA, 'c', 300)).toEqual([]);
    expect(f.storesA.jobs.getJob(job.id)).toMatchObject({ status: 'failed', lastError: 'lease_expired_attempts_exhausted' });
  });
});

describe('Claims honour CURRENT account gates per job type (Findings 7, 8, 13; coordinator probes)', () => {
  type Mut = (f: ReturnType<typeof setup>) => void;
  const set = (patch: Parameters<ReturnType<typeof setup>['storesA']['accounts']['updateAccountFlags']>[1]): Mut => (f) =>
    f.storesA.accounts.updateAccountFlags(f.account.id, patch);

  const blocked: Array<[CareJobType, string, Mut]> = [
    ['inbound_turn', 'paused', set({ desiredState: 'paused' })],
    ['inbound_turn', 'draining', set({ desiredState: 'draining' })],
    ['inbound_turn', 'disconnected', set({ desiredState: 'disconnected' })],
    ['inbound_turn', 'AI disabled', set({ aiEnabled: false })],
    ['inbound_turn', 'sync disabled', set({ syncEnabled: false })],
    ['outbox_dispatch', 'paused', set({ desiredState: 'paused' })],
    ['outbox_dispatch', 'draining', set({ desiredState: 'draining' })],
    ['outbox_dispatch', 'send disabled', set({ sendEnabled: false })],
    ['sync_poll', 'paused', set({ desiredState: 'paused' })],
    ['sync_poll', 'sync disabled', set({ syncEnabled: false })],
    ['cleanup', 'disconnected', set({ desiredState: 'disconnected' })],
  ];
  for (const [type, label, mutate] of blocked) {
    it(`${type} is not claimable when ${label}`, () => {
      const f = setup();
      enqueue(f, type);
      mutate(f);
      // a bump to a new epoch (legacy case) also needs the worker to present the new epoch
      const epoch = f.storesA.accounts.getAccount(f.account.id)!.ownerEpoch;
      expect(f.storesB.jobs.claimJobs({ workerId: 'w', currentEpoch: epoch, leaseDurationMs: 1_000, nowMs: 100 })).toEqual([]);
    });
  }

  const allowed: Array<[CareJobType, string, Mut]> = [
    ['inbound_turn', 'fully eligible', () => {}],
    ['outbox_dispatch', 'send on, AI and sync off', set({ aiEnabled: false, syncEnabled: false })],
    ['sync_poll', 'sync on, AI and send off', set({ aiEnabled: false, sendEnabled: false })],
    ['cleanup', 'paused, legacy-owned housekeeping', set({ desiredState: 'paused' })],
    ['cleanup', 'draining', set({ desiredState: 'draining' })],
  ];
  for (const [type, label, mutate] of allowed) {
    it(`${type} stays claimable when ${label}`, () => {
      const f = setup();
      enqueue(f, type);
      mutate(f);
      expect(claim(f.storesB, 'w', 100)).toHaveLength(1);
    });
  }

  it.each(['legacy', 'draining'] as const)('a %s write owner never claims any core job type', (writeOwner) => {
    const f = setup();
    const acct = createEligibleAccount(f.storesA, { nativeAccountId: `wo-${writeOwner}`, writeOwner });
    for (const jobType of ['inbound_turn', 'outbox_dispatch', 'sync_poll'] as const) {
      f.storesA.jobs.enqueueJob({ accountId: acct.id, jobType, payload: {}, ownerEpoch: 1, dueAtMs: 0 });
    }
    expect(claim(f.storesB, 'w', 100, { accountIds: [acct.id] })).toEqual([]);
  });

  it('Telegram never claims an inbound_turn even with the AI flag on', () => {
    const f = setup();
    const tg = createEligibleAccount(f.storesA, { channel: 'telegram', connectorKind: 'telegram-user', nativeAccountId: 'tg' });
    f.storesA.jobs.enqueueJob({ accountId: tg.id, jobType: 'inbound_turn', payload: {}, ownerEpoch: 1, dueAtMs: 0 });
    f.storesA.jobs.enqueueJob({ accountId: tg.id, jobType: 'outbox_dispatch', payload: {}, ownerEpoch: 1, dueAtMs: 0 });
    const claimed = claim(f.storesB, 'w', 100);
    expect(claimed.map((j) => j.jobType)).toEqual(['outbox_dispatch']);
  });

  it('accounts are created inactive with every flag off (nothing is enabled by default)', () => {
    const f = setup();
    const fresh: CareAccountRecord = f.storesA.accounts.createAccount({ channel: 'zalo', connectorKind: 'k', nativeAccountId: 'n', label: 'l' });
    expect(fresh).toMatchObject({ desiredState: 'paused', syncEnabled: false, sendEnabled: false, aiEnabled: false, writeOwner: 'legacy', ownerEpoch: 1 });
    f.storesA.jobs.enqueueJob({ accountId: fresh.id, jobType: 'inbound_turn', payload: {}, ownerEpoch: 1, dueAtMs: 0 });
    expect(claim(f.storesA, 'w', 100)).toEqual([]);
  });
});

describe('Completion / failure / release / renewal are fenced by the CURRENT account row (probe 4)', () => {
  it('an actual epoch bump on the other handle fences every settle operation during a valid lease', () => {
    const f = setup();
    const job = enqueue(f);
    const [c] = claim(f.storesA, 'alpha', 100, { leaseDurationMs: 100_000 });

    expect(f.storesB.accounts.updateAccountOwnerEpoch(f.account.id, 'core', 2)).toBe(true);

    expect(f.storesA.jobs.completeJob(job.id, 'alpha', c.claimToken!, 200)).toBe(false);
    expect(f.storesA.jobs.failJob(job.id, 'alpha', c.claimToken!, 'x', true, 0, 200)).toBe(false);
    expect(f.storesA.jobs.releaseJob(job.id, 'alpha', c.claimToken!, 200)).toBe(false);
    expect(f.storesA.jobs.renewLease(job.id, 'alpha', c.claimToken!, 1_000, 200)).toBe(false);
    expect(f.storesA.jobs.getJob(job.id)).toMatchObject({ status: 'claimed', leaseOwner: 'alpha' });

    // the stale-epoch job is unclaimable at either epoch and can be superseded explicitly
    expect(claim(f.storesB, 'beta', 200_000)).toEqual([]);
    expect(f.storesB.jobs.claimJobs({ workerId: 'beta', currentEpoch: 2, leaseDurationMs: 1_000, nowMs: 200_000 })).toEqual([]);
    expect(f.storesB.jobs.supersedeStaleEpochJobs(f.account.id, 200_001)).toBe(1);
    expect(f.storesA.jobs.getJob(job.id)).toMatchObject({ status: 'failed', lastError: 'superseded_by_epoch' });
  });

  it.each([
    ['AI turned off', { aiEnabled: false }],
    ['account paused', { desiredState: 'paused' as const }],
    ['account draining', { desiredState: 'draining' as const }],
  ])('%s during the lease fences settle operations; restoring the gate lets a later claim finish the job', (_label, patch) => {
    const f = setup();
    const job = enqueue(f);
    const [c] = claim(f.storesA, 'alpha', 100, { leaseDurationMs: 1_000 });
    const before = f.storesA.accounts.getAccount(f.account.id)!;
    f.storesB.accounts.updateAccountFlags(f.account.id, patch);

    expect(f.storesA.jobs.completeJob(job.id, 'alpha', c.claimToken!, 200)).toBe(false);
    expect(f.storesA.jobs.renewLease(job.id, 'alpha', c.claimToken!, 1_000, 200)).toBe(false);
    expect(f.storesA.jobs.getJob(job.id)!.status).toBe('claimed');

    f.storesB.accounts.updateAccountFlags(f.account.id, { aiEnabled: before.aiEnabled, desiredState: before.desiredState });
    const [again] = claim(f.storesB, 'beta', 5_000);
    expect(again.id).toBe(job.id);
    expect(f.storesB.jobs.completeJob(job.id, 'beta', again.claimToken!, 5_100)).toBe(true);
  });

  it('the account epoch never moves backwards or sideways', () => {
    const f = setup();
    expect(f.storesA.accounts.updateAccountOwnerEpoch(f.account.id, 'core', 3)).toBe(true);
    expect(f.storesB.accounts.updateAccountOwnerEpoch(f.account.id, 'core', 3)).toBe(false);
    expect(f.storesB.accounts.updateAccountOwnerEpoch(f.account.id, 'legacy', 2)).toBe(false);
    expect(f.storesB.accounts.getAccount(f.account.id)).toMatchObject({ ownerEpoch: 3, writeOwner: 'core' });
  });

  it('a runtime that still believes in the old epoch can neither enqueue nor claim', () => {
    const f = setup();
    enqueue(f);
    f.storesA.accounts.updateAccountOwnerEpoch(f.account.id, 'core', 2);
    expect(() => enqueue(f)).toThrow(CareError); // ownerEpoch 1 vs account epoch 2
    expect(claim(f.storesB, 'w', 100)).toEqual([]); // worker view epoch 1
  });
});

describe('Job payloads and errors are encrypted at rest', () => {
  it('keeps payload and lastError out of plaintext while decrypting for the store', () => {
    const f = setup();
    const job = f.storesA.jobs.enqueueJob({
      accountId: f.account.id, jobType: 'inbound_turn', payload: { customerPhone: 'PHONE_MARKER_0901234567' }, ownerEpoch: 1, dueAtMs: 0,
    });
    const [c] = claim(f.storesA, 'w', 10);
    f.storesA.jobs.failJob(job.id, 'w', c.claimToken!, 'upstream said ERROR_MARKER_secret@example.com', false, 0, 20);

    const dump = dumpCareTables(f.a);
    expect(dump).not.toContain('PHONE_MARKER_0901234567');
    expect(dump).not.toContain('ERROR_MARKER_secret@example.com');
    expect(f.storesB.jobs.getJob(job.id)).toMatchObject({
      payload: { customerPhone: 'PHONE_MARKER_0901234567' },
      lastError: 'upstream said ERROR_MARKER_secret@example.com',
    });
  });
});

describe('Claim scope is exact; housekeeping stays inside it (review 1, 3)', () => {
  it('an explicitly empty account or job-type scope claims nothing and touches nothing', () => {
    const f = setup();
    const job = enqueue(f);
    expect(claim(f.storesA, 'w', 100, { accountIds: [] })).toEqual([]);
    expect(claim(f.storesA, 'w', 100, { jobTypes: [] })).toEqual([]);
    expect(f.storesA.jobs.getJob(job.id)).toMatchObject({ status: 'pending', attempts: 0 });
    expect(claim(f.storesA, 'w', 100, { accountIds: [f.account.id], jobTypes: ['inbound_turn'] })).toHaveLength(1);
  });

  it('a worker scoped to account A neither claims nor fails account B\'s jobs (incl. exhausted leases)', () => {
    const f = setup();
    const b = createEligibleAccount(f.storesA, { nativeAccountId: 'acct-b' });
    const jobA = enqueue(f);
    const jobB = f.storesA.jobs.enqueueJob({ accountId: b.id, jobType: 'inbound_turn', payload: {}, ownerEpoch: 1, dueAtMs: 0, maxAttempts: 1 });

    // B's only attempt is claimed and its lease lapses: it is exhausted
    expect(claim(f.storesB, 'wb', 100, { accountIds: [b.id], leaseDurationMs: 10 })).toHaveLength(1);

    // a worker scoped to A, long after, must not "clean up" B
    const got = claim(f.storesA, 'wa', 10_000, { accountIds: [f.account.id] });
    expect(got.map((j) => j.id)).toEqual([jobA.id]);
    expect(f.storesA.jobs.getJob(jobB.id)).toMatchObject({ status: 'claimed', leaseOwner: 'wb' });

    // B's own scope (or an unscoped worker) does the housekeeping
    expect(claim(f.storesB, 'wb2', 10_000, { accountIds: [b.id] })).toEqual([]);
    expect(f.storesA.jobs.getJob(jobB.id)).toMatchObject({ status: 'failed', lastError: 'lease_expired_attempts_exhausted' });
  });

  it('housekeeping is limited to the worker\'s epoch and job types', () => {
    const f = setup();
    const turn = enqueue(f, 'inbound_turn', { maxAttempts: 1 });
    const poll = enqueue(f, 'sync_poll', { maxAttempts: 1 });
    claim(f.storesA, 'w', 100, { leaseDurationMs: 10 });
    expect(f.storesA.jobs.getJob(turn.id)!.status).toBe('claimed');
    expect(f.storesA.jobs.getJob(poll.id)!.status).toBe('claimed');

    claim(f.storesA, 'w2', 10_000, { jobTypes: ['sync_poll'] });
    expect(f.storesA.jobs.getJob(poll.id)!.status).toBe('failed');
    expect(f.storesA.jobs.getJob(turn.id)!.status).toBe('claimed'); // different type: untouched

    // a worker presenting another epoch cannot touch epoch-1 jobs either
    claim(f.storesA, 'w3', 20_000, { currentEpoch: 2 });
    expect(f.storesA.jobs.getJob(turn.id)!.status).toBe('claimed');
  });

  it('renewLease never shortens a lease', () => {
    const f = setup();
    const job = enqueue(f);
    const [c] = claim(f.storesA, 'w', 1_000, { leaseDurationMs: 60_000 }); // expires 61_000
    expect(f.storesA.jobs.renewLease(job.id, 'w', c.claimToken!, 1_000, 2_000)).toBe(true); // 3_000 < 61_000
    expect(f.storesB.jobs.getJob(job.id)!.leaseExpiresAtMs).toBe(61_000);
    expect(f.storesA.jobs.renewLease(job.id, 'w', c.claimToken!, 100_000, 2_000)).toBe(true);
    expect(f.storesB.jobs.getJob(job.id)!.leaseExpiresAtMs).toBe(102_000);
    expect(() => f.storesA.jobs.renewLease(job.id, 'w', c.claimToken!, 0, 2_000)).toThrow(CareError);
  });
});

describe('Checkpoint conflicts at an equal causal position (review 2)', () => {
  it('different opaque state at the same position is refused without CAS, accepted with CAS, lower ignored, higher advances', () => {
    const f = setup();
    const cp = f.storesA.checkpoints;
    const id = f.account.id;
    cp.advance(id, { namespace: 'zalo_chat', cursor: 'state-A', position: '100' });

    expect(() => cp.advance(id, { namespace: 'zalo_chat', cursor: 'state-B', position: '100' })).toThrow(CareError);
    expect(cp.get(id, 'zalo_chat')).toMatchObject({ cursor: 'state-A', position: '100', revision: 1 });

    expect(cp.advance(id, { namespace: 'zalo_chat', cursor: 'state-A', position: '100' })).toBe('unchanged');
    expect(cp.advance(id, { namespace: 'zalo_chat', cursor: 'older', position: '99' })).toBe('regression_ignored');
    expect(cp.get(id, 'zalo_chat')!.cursor).toBe('state-A');

    expect(cp.advance(id, { namespace: 'zalo_chat', cursor: 'state-B', position: '100', expectedCursor: 'state-A' })).toBe('advanced');
    expect(cp.advance(id, { namespace: 'zalo_chat', cursor: 'state-C', position: '101' })).toBe('advanced');
    expect(cp.get(id, 'zalo_chat')).toMatchObject({ cursor: 'state-C', position: '101', revision: 3 });
  });

  it('standalone advance is atomic across handles: only one concurrent CAS wins', () => {
    const f = setup();
    f.storesA.checkpoints.advance(f.account.id, { namespace: 'zalo_chat', cursor: 'c0' });
    const attempt = (stores: typeof f.storesA, cursor: string) => {
      try {
        return stores.checkpoints.advance(f.account.id, { namespace: 'zalo_chat', cursor, expectedCursor: 'c0' });
      } catch (err) {
        return (err as CareError).code;
      }
    };
    expect([attempt(f.storesA, 'from-A'), attempt(f.storesB, 'from-B')]).toEqual(['advanced', 'STALE_REVISION']);
    expect(f.storesB.checkpoints.get(f.account.id, 'zalo_chat')!.cursor).toBe('from-A');
  });
});

describe('History/live overlap across handles creates exactly one policy job (AC-008)', () => {
  it('backfill on one handle, live on another, then a replayed live event with a NEW id', () => {
    const f = setup();
    assignAuto(f.storesA, f.account);
    const m = (origin: 'history' | 'live') => chatMessage(f.account, { nativeMessageId: 'overlap', sentAtMs: 500, origin });

    expect(f.ingestA.ingestNormalizedMessage(m('history'), undefined, 1, 'backfill-1').jobId).toBeUndefined();
    const live = f.ingestB.ingestNormalizedMessage(m('live'), undefined, 1, 'live-1');
    expect(live.outcome).toBe('live_observed');
    expect(live.jobId).toBeDefined();
    expect(f.ingestA.ingestNormalizedMessage(m('live'), undefined, 1, 'live-2').outcome).toBe('duplicate_ignored');
    expect(f.ingestB.ingestNormalizedMessage(m('live'), undefined, 1, 'live-1').outcome).toBe('duplicate_event');
    expect(f.a.prepare('SELECT count(*) AS n FROM care_jobs').get()).toEqual({ n: 1 });
    expect(f.a.prepare('SELECT count(*) AS n FROM care_messages').get()).toEqual({ n: 1 });
  });

  it('a peerless tombstone written on one handle suppresses a late body ingested on the other', () => {
    const f = setup();
    const tg = createEligibleAccount(f.storesA, { channel: 'telegram', connectorKind: 'telegram-user', nativeAccountId: 'tg-1' });
    f.ingestA.ingestNormalizedEvent({
      type: 'message.deleted', eventId: 'peerless', accountId: tg.id, timestampMs: 1, epoch: 1,
      nativeMessageNamespace: 'telegram_common_box', nativeMessageId: '10', nativeVersion: null,
    });
    const late = f.ingestB.ingestNormalizedMessage(
      chatMessage(tg, { nativeMessageId: '10', nativeMessageNamespace: 'telegram_common_box', text: 'LATE BODY' }),
      undefined,
      1,
    );
    expect(late.outcome).toBe('ignored_tombstone');
    expect(dumpCareTables(f.a)).not.toContain('LATE BODY');
  });
});
