import { afterEach, describe, expect, it } from 'vitest';
import { CareError } from '../../../_lib/care-kit/errors.js';
import { addAccount, cycleOwner, runtimeFixture } from '../runtime/runtime-fixtures.js';
import { CareOwnershipStore, ensureOwnershipSchema } from './ownership-store.js';

const open: Array<() => void> = [];
afterEach(() => open.splice(0).forEach((c) => c()));
const setup = (over = {}) => {
  const f = runtimeFixture(over);
  open.push(f.close);
  return f;
};

const acq = (store: CareOwnershipStore, accountId: string, holderId: string, processToken: string, generation: number, nowMs: number, extra = {}) =>
  store.acquire({ accountId, holderId, processToken, role: 'core', generation, ttlMs: 1_000, nowMs, ...extra });

describe('ownership lock (AC-020/030)', () => {
  it('two handles racing for one account: exactly one wins, the loser sees who holds it', () => {
    const f = setup();
    const r1 = acq(f.storesA.ownership, f.account.id, 'w1', 'tok-1', 1, 100);
    const r2 = acq(f.storesB.ownership, f.account.id, 'w2', 'tok-2', 1, 100);
    expect([r1.ok, r2.ok].filter(Boolean)).toHaveLength(1);
    expect(r2).toMatchObject({ ok: false, reason: 'HELD_BY_OTHER', heldBy: 'w1', heldUntilMs: 1_100 });
    expect(f.storesB.ownership.getHolder(f.account.id)?.holderId).toBe('w1');
  });

  it('a recycled PID (same holder id, same pid, new process token) cannot renew, release, or steal a live lock', () => {
    const f = setup();
    const first = acq(f.storesA.ownership, f.account.id, 'w1', 'tok-old', 1, 100, { pid: 4242 });
    if (!first.ok) throw new Error('setup');
    const reborn = acq(f.storesB.ownership, f.account.id, 'w1', 'tok-new', 1, 200, { pid: 4242 });
    expect(reborn).toMatchObject({ ok: false, reason: 'HELD_BY_OTHER' });
    const forged = { ...first.lock, processToken: 'tok-new' };
    expect(f.storesB.ownership.renew(forged, { ttlMs: 1_000, nowMs: 300 })).toMatchObject({ ok: false, reason: 'NOT_HOLDER' });
    expect(f.storesB.ownership.release(forged, 300)).toBe(false);
    // the rightful holder is untouched
    expect(f.storesA.ownership.renew(first.lock, { ttlMs: 1_000, nowMs: 400 }).ok).toBe(true);
    // after real expiry the new incarnation may take over, under a NEW lock_seq, and the old one is dead
    const later = acq(f.storesB.ownership, f.account.id, 'w1', 'tok-new', 1, 5_000, { pid: 4242 });
    expect(later.ok && later.lock.lockSeq).toBe(first.lock.lockSeq + 1);
    expect(f.storesA.ownership.renew(first.lock, { ttlMs: 1_000, nowMs: 5_001 })).toMatchObject({ ok: false, reason: 'NOT_HOLDER' });
    expect(f.storesA.ownership.verify(first.lock, 5_001)).toMatchObject({ ok: false, reason: 'NOT_HOLDER' });
  });

  it('same holder + same token re-acquiring simply renews (no new lock_seq)', () => {
    const f = setup();
    const a = acq(f.storesA.ownership, f.account.id, 'w1', 't', 1, 100);
    const b = acq(f.storesA.ownership, f.account.id, 'w1', 't', 1, 200);
    expect(a.ok && b.ok && b.lock.lockSeq === a.lock.lockSeq && b.lock.expiresAtMs === 1_200).toBe(true);
  });

  it('generation handshake after restart: a remembered old generation is refused, the current one accepted, the old lock is dead', () => {
    const f = setup();
    const before = acq(f.storesA.ownership, f.account.id, 'w1', 'tok-1', 1, 100);
    if (!before.ok) throw new Error('setup');
    const epoch = cycleOwner(f.storesA, f.account.id, 'core', 'core'); // core -> draining -> core: epoch 3
    expect(epoch).toBe(3);
    // the stale holder cannot heartbeat or act, however fresh its lease
    expect(f.storesA.ownership.renew(before.lock, { ttlMs: 1_000, nowMs: 200 })).toMatchObject({ ok: false, reason: 'STALE_GENERATION', currentEpoch: 3 });
    expect(f.storesA.ownership.verify(before.lock, 200)).toMatchObject({ ok: false, reason: 'STALE_GENERATION' });
    // a restarted process with the epoch it remembered is told the truth; with the real one it takes over at once
    expect(acq(f.storesB.ownership, f.account.id, 'w1', 'tok-2', 1, 300)).toMatchObject({ ok: false, reason: 'STALE_GENERATION', currentEpoch: 3 });
    expect(acq(f.storesB.ownership, f.account.id, 'w1', 'tok-2', 99, 300)).toMatchObject({ ok: false, reason: 'GENERATION_AHEAD', currentEpoch: 3 });
    const fresh = acq(f.storesB.ownership, f.account.id, 'w1', 'tok-2', 3, 300);
    expect(fresh.ok && fresh.lock.generation).toBe(3);
    expect(f.storesA.ownership.renew(before.lock, { ttlMs: 1_000, nowMs: 301 })).toMatchObject({ ok: false, reason: 'NOT_HOLDER' });
  });

  it('draining blocks every acquisition; role must match the write owner', () => {
    const f = setup();
    const legacy = addAccount(f.storesA, { writeOwner: 'legacy' });
    expect(acq(f.storesA.ownership, legacy.id, 'w1', 't', 1, 100)).toMatchObject({ ok: false, reason: 'OWNER_MISMATCH' });
    expect(f.storesA.ownership.acquire({ accountId: legacy.id, holderId: 'legacy-sender', processToken: 'lt', role: 'legacy', generation: 1, ttlMs: 1_000, nowMs: 100 }).ok).toBe(true);

    const held = acq(f.storesA.ownership, f.account.id, 'w1', 't', 1, 100);
    if (!held.ok) throw new Error('setup');
    f.storesA.ownership.applyOwnerTransition({ accountId: f.account.id, expectedOwner: 'core', expectedEpoch: 1, toOwner: 'draining', kind: 'rollback', actor: 'op', reason: 'test' });
    expect(acq(f.storesB.ownership, f.account.id, 'w2', 't2', 2, 150)).toMatchObject({ ok: false, reason: 'DRAINING' });
    expect(f.storesA.ownership.verify(held.lock, 150).ok).toBe(false);
    expect(acq(f.storesB.ownership, 'missing', 'w', 't', 1, 1)).toMatchObject({ ok: false, reason: 'ACCOUNT_NOT_FOUND' });
  });

  it('expiry and release are strict: an expired lock cannot renew; a released lock frees the account immediately', () => {
    const f = setup();
    const a = acq(f.storesA.ownership, f.account.id, 'w1', 't1', 1, 100);
    if (!a.ok) throw new Error('setup');
    expect(f.storesA.ownership.renew(a.lock, { ttlMs: 1_000, nowMs: 5_000 })).toMatchObject({ ok: false, reason: 'EXPIRED' });
    const b = acq(f.storesB.ownership, f.account.id, 'w2', 't2', 1, 5_000);
    if (!b.ok) throw new Error('setup');
    expect(f.storesB.ownership.release(b.lock, 5_100)).toBe(true);
    expect(f.storesB.ownership.verify(b.lock, 5_101)).toMatchObject({ ok: false, reason: 'RELEASED' });
    expect(acq(f.storesA.ownership, f.account.id, 'w1', 't1', 1, 5_102).ok).toBe(true);
  });
});

describe('owner transitions and cutover log', () => {
  it('only legacy/core <-> draining edges exist; direct legacy <-> core is refused by the store', () => {
    const f = setup({ writeOwner: 'legacy' });
    expect(() =>
      f.storesA.ownership.applyOwnerTransition({ accountId: f.account.id, expectedOwner: 'legacy', expectedEpoch: 1, toOwner: 'core', kind: 'forward', actor: 'op', reason: 'x' }),
    ).toThrow(CareError);
    expect(f.storesA.accounts.getAccount(f.account.id)).toMatchObject({ writeOwner: 'legacy', ownerEpoch: 1 });
  });

  it('is a CAS on owner + epoch across handles: the second of two identical requests loses and nothing changes twice', () => {
    const f = setup({ writeOwner: 'legacy' });
    const req = { accountId: f.account.id, expectedOwner: 'legacy' as const, expectedEpoch: 1, toOwner: 'draining' as const, kind: 'forward' as const, actor: 'op', reason: 'drain' };
    expect(f.storesA.ownership.applyOwnerTransition(req)).toMatchObject({ ok: true, epochBefore: 1, epochAfter: 2 });
    expect(f.storesB.ownership.applyOwnerTransition(req)).toMatchObject({ ok: false, code: 'CAS_MISMATCH', currentOwner: 'draining', currentEpoch: 2 });
    expect(f.storesA.accounts.getAccount(f.account.id)).toMatchObject({ writeOwner: 'draining', ownerEpoch: 2 });
    expect(f.storesA.ownership.listCutoverLog(f.account.id)).toHaveLength(1);
  });

  it('log rows carry actor, reason, epochs and evidence refs, and are append-only', () => {
    const f = setup({ writeOwner: 'legacy' });
    f.storesA.ownership.applyOwnerTransition({
      accountId: f.account.id, expectedOwner: 'legacy', expectedEpoch: 1, toOwner: 'draining', kind: 'forward',
      actor: 'operator:tony', reason: 'pilot cutover', evidence: ['run:abc', 'backup:manifest-1'], nowMs: 777,
    });
    const [row] = f.storesA.ownership.listCutoverLog(f.account.id);
    expect(row).toMatchObject({ fromOwner: 'legacy', toOwner: 'draining', epochBefore: 1, epochAfter: 2, outcome: 'applied', actor: 'operator:tony', reason: 'pilot cutover', evidence: ['run:abc', 'backup:manifest-1'], createdAtMs: 777 });
    expect(() => f.a.prepare('UPDATE care_cutover_log SET actor = ?').run('x')).toThrow(/append-only/);
    expect(() => f.a.prepare('DELETE FROM care_cutover_log').run()).toThrow(/append-only/);
    expect(f.storesA.ownership.lastDrainOrigin(f.account.id)).toEqual({ origin: 'legacy', epochAfter: 2 });
  });

  it('rejects control characters / oversized evidence instead of storing them', () => {
    const f = setup({ writeOwner: 'legacy' });
    expect(() =>
      f.storesA.ownership.applyOwnerTransition({ accountId: f.account.id, expectedOwner: 'legacy', expectedEpoch: 1, toOwner: 'draining', kind: 'forward', actor: 'op', reason: 'bad\nreason' }),
    ).toThrow(CareError);
    expect(f.storesA.ownership.listCutoverLog(f.account.id)).toHaveLength(0);
  });
});

describe('runtime switches and backlog holds (store level)', () => {
  it('validates keys, reports re-enable, and logs every change', () => {
    const f = setup();
    const o = f.storesA.ownership;
    expect(() => o.setSwitch('whatever', true, { actor: 'x' })).toThrow(CareError);
    expect(() => o.setSwitch('channel:fax', true, { actor: 'x' })).toThrow(CareError);
    expect(o.setSwitch('path:api', false, { actor: 'x', nowMs: 10 })).toMatchObject({ previous: null, enabled: false, reenabled: false });
    expect(o.setSwitch('path:api', false, { actor: 'x', nowMs: 11 })).toMatchObject({ previous: false, reenabled: false });
    expect(o.setSwitch('path:api', true, { actor: 'x', nowMs: 12 })).toMatchObject({ previous: false, enabled: true, reenabled: true, atMs: 12 });
    expect(o.getSwitch('path:api')).toMatchObject({ enabled: true, enabledSinceMs: 12 });
    expect((f.a.prepare("SELECT count(*) AS n FROM care_runtime_switch_log WHERE switch_key = 'path:api'").get() as any).n).toBe(2);
  });

  it('holds are idempotent, resolved explicitly, and a later re-enable can hold the same item again', () => {
    const f = setup();
    const o = f.storesA.ownership;
    const item = { kind: 'job', id: 'j1', accountId: f.account.id };
    expect(o.holdItems([item], { cutoffMs: 5, reason: 'r', actor: 'a', nowMs: 5 })).toBe(1);
    expect(o.holdItems([item], { cutoffMs: 5, reason: 'r', actor: 'a', nowMs: 6 })).toBe(0);
    expect(o.isHeld('job', 'j1')).toBe(true);
    expect(o.resolveHold('job', 'j1', 'released', { actor: 'op', nowMs: 7 })).toBe(true);
    expect(o.resolveHold('job', 'j1', 'released', { actor: 'op', nowMs: 8 })).toBe(false);
    expect(o.isHeld('job', 'j1')).toBe(false);
    expect(o.holdItems([item], { cutoffMs: 9, reason: 'again', actor: 'a', nowMs: 9 })).toBe(1);
    expect(o.listHolds({ accountId: f.account.id, status: 'held' })).toHaveLength(1);
  });
});

describe('regression: no trigger may name a table that does not exist', () => {
  it('re-enabling an account works on a database without the legacy outbox tables, and a retired trigger is dropped on boot', () => {
    const f = setup();
    // a database created by the earlier (broken) build carries these triggers
    f.a.exec(`CREATE TRIGGER care_hold_discard_legacy_email AFTER UPDATE OF status ON care_backlog_holds
              WHEN NEW.status = 'discarded' BEGIN UPDATE email_outbox SET status = 'discarded'; END;`);
    expect(() => f.storesA.accounts.updateAccountFlags(f.account.id, { desiredState: 'paused' })).toThrow(/no such table/);
    ensureOwnershipSchema(f.a); // what every boot does
    expect(() => f.storesA.accounts.updateAccountFlags(f.account.id, { desiredState: 'paused' })).not.toThrow();
    expect(() => f.storesA.accounts.updateAccountFlags(f.account.id, { desiredState: 'active' })).not.toThrow();
    const o = f.storesA.ownership;
    o.holdItems([{ kind: 'zalo_outbox', id: '7', accountId: f.account.id }], { cutoffMs: 1, reason: 'r', actor: 'a' });
    expect(o.resolveHold('zalo_outbox', '7', 'discarded', { actor: 'op' })).toBe(true); // no legacy table: nothing else to close
  });
});
