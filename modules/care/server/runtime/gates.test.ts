import { afterEach, describe, expect, it } from 'vitest';
import { addAccount, cycleOwner, runtimeFixture } from './runtime-fixtures.js';
import { DISPATCH_SOURCES, evaluateDispatchGate, type DispatchSource } from './gates.js';
import { SWITCH, engageKillSwitch, releaseKillSwitch, setRuntimeSwitch } from './switches.js';

const open: Array<() => void> = [];
afterEach(() => open.splice(0).forEach((c) => c()));
const setup = (over = {}) => {
  const f = runtimeFixture(over);
  open.push(f.close);
  return f;
};

describe('dispatch gate: switches bind every source path, not only the UI (AC-021/031)', () => {
  it('allows a fully eligible core dispatch', () => {
    const f = setup();
    expect(evaluateDispatchGate(f.a, f.account.id, 1, 'core', 'api')).toMatchObject({ allow: true, code: 'OK', owner: 'core', epoch: 1 });
  });

  it('Adding the module is the opt-in: no module switch row means enabled, an explicit off denies', () => {
    const f = setup();
    f.a.prepare('DELETE FROM care_runtime_switches').run();
    expect(evaluateDispatchGate(f.a, f.account.id, 1, 'core', 'job').allow).toBe(true);
    setRuntimeSwitch(f.a, 'module', false, { actor: 'test' });
    expect(evaluateDispatchGate(f.a, f.account.id, 1, 'core', 'job')).toMatchObject({ allow: false, code: 'MODULE_DISABLED' });
  });

  it.each(DISPATCH_SOURCES.map((s) => [s]))('path switch "%s" blocks that path only', (source) => {
    const f = setup();
    setRuntimeSwitch(f.a, SWITCH.path(source as DispatchSource), false, { actor: 'op', nowMs: 10 });
    expect(evaluateDispatchGate(f.a, f.account.id, 1, 'core', source as DispatchSource)).toMatchObject({ allow: false, code: 'PATH_DISABLED' });
    for (const other of DISPATCH_SOURCES.filter((s) => s !== source)) {
      expect(evaluateDispatchGate(f.a, f.account.id, 1, 'core', other).allow).toBe(true);
    }
  });

  it('a switch written on one handle is enforced on the other (API/CLI/job processes share the DB)', () => {
    const f = setup();
    setRuntimeSwitch(f.a, SWITCH.module, false, { actor: 'op', nowMs: 10 });
    for (const source of ['api', 'cli', 'job', 'schedule'] as const) {
      expect(evaluateDispatchGate(f.b, f.account.id, 1, 'core', source)).toMatchObject({ allow: false, code: 'MODULE_DISABLED' });
    }
  });

  it('kill switch stops sends but not ingest/sync work; channel switch is per channel', () => {
    const f = setup();
    engageKillSwitch(f.a, { actor: 'op', nowMs: 10 });
    expect(evaluateDispatchGate(f.a, f.account.id, 1, 'core', 'job')).toMatchObject({ allow: false, code: 'KILL_SWITCH' });
    expect(evaluateDispatchGate(f.a, f.account.id, 1, 'core', 'job', { operation: 'work' }).allow).toBe(true);
    releaseKillSwitch(f.a, { actor: 'op', nowMs: 11 });
    expect(evaluateDispatchGate(f.a, f.account.id, 1, 'core', 'job').allow).toBe(true);

    const mail = addAccount(f.storesA, { channel: 'email' });
    setRuntimeSwitch(f.a, SWITCH.channel('zalo'), false, { actor: 'op', nowMs: 12 });
    expect(evaluateDispatchGate(f.a, f.account.id, 1, 'core', 'api')).toMatchObject({ allow: false, code: 'CHANNEL_DISABLED' });
    expect(evaluateDispatchGate(f.a, mail.id, 1, 'core', 'api').allow).toBe(true);
  });

  it('account switches: paused / disconnected / send off all deny; auto-send is its own switch', () => {
    const f = setup();
    f.storesA.accounts.updateAccountFlags(f.account.id, { sendEnabled: false });
    expect(evaluateDispatchGate(f.a, f.account.id, 1, 'core', 'cli')).toMatchObject({ allow: false, code: 'SEND_DISABLED' });
    expect(evaluateDispatchGate(f.a, f.account.id, 1, 'core', 'cli', { operation: 'work' }).allow).toBe(true);
    f.storesA.accounts.updateAccountFlags(f.account.id, { sendEnabled: true, desiredState: 'paused' });
    expect(evaluateDispatchGate(f.a, f.account.id, 1, 'core', 'cli')).toMatchObject({ allow: false, code: 'ACCOUNT_NOT_ACTIVE' });
    f.storesA.accounts.updateAccountFlags(f.account.id, { desiredState: 'active' });

    setRuntimeSwitch(f.a, SWITCH.autoSend, false, { actor: 'op', nowMs: 10 });
    expect(evaluateDispatchGate(f.a, f.account.id, 1, 'core', 'job', { actorType: 'auto' })).toMatchObject({ allow: false, code: 'AUTO_SEND_DISABLED' });
    expect(evaluateDispatchGate(f.a, f.account.id, 1, 'core', 'job', { actorType: 'approved' }).allow).toBe(true);
    expect(evaluateDispatchGate(f.a, f.account.id, 1, 'core', 'job', { actorType: 'manual' }).allow).toBe(true);
  });

  it('unknown account / unknown source fail closed', () => {
    const f = setup();
    expect(evaluateDispatchGate(f.a, 'nope', 1, 'core', 'api')).toMatchObject({ allow: false, code: 'ACCOUNT_NOT_FOUND' });
    expect(evaluateDispatchGate(f.a, f.account.id, 1, 'core', 'telepathy' as DispatchSource)).toMatchObject({ allow: false, code: 'INVALID_SOURCE' });
  });
});

describe('dispatch gate: ownership and epochs (AC-020)', () => {
  it('Care never dispatches a legacy account; legacy never dispatches a core account; draining blocks both', () => {
    const f = setup({ writeOwner: 'legacy' });
    expect(evaluateDispatchGate(f.a, f.account.id, 1, 'core', 'job')).toMatchObject({ allow: false, code: 'OWNER_LEGACY' });
    expect(evaluateDispatchGate(f.a, f.account.id, 1, 'legacy', 'sender').allow).toBe(true);

    const e2 = f.storesA.ownership.applyOwnerTransition({ accountId: f.account.id, expectedOwner: 'legacy', expectedEpoch: 1, toOwner: 'draining', kind: 'forward', actor: 'op', reason: 'drain' });
    expect(e2.ok).toBe(true);
    expect(evaluateDispatchGate(f.a, f.account.id, 2, 'core', 'job')).toMatchObject({ allow: false, code: 'ACCOUNT_DRAINING' });
    expect(evaluateDispatchGate(f.a, f.account.id, 2, 'legacy', 'sender')).toMatchObject({ allow: false, code: 'ACCOUNT_DRAINING' });
    expect(evaluateDispatchGate(f.a, f.account.id, 1, 'legacy', 'responder')).toMatchObject({ allow: false, code: 'ACCOUNT_DRAINING' });

    f.storesA.ownership.applyOwnerTransition({ accountId: f.account.id, expectedOwner: 'draining', expectedEpoch: 2, toOwner: 'core', kind: 'forward', actor: 'op', reason: 'done' });
    expect(evaluateDispatchGate(f.a, f.account.id, 3, 'legacy', 'sender')).toMatchObject({ allow: false, code: 'OWNER_CORE' });
    expect(evaluateDispatchGate(f.a, f.account.id, 3, 'core', 'job').allow).toBe(true);
  });

  it('an old-epoch dispatcher is refused on both sides; a core dispatcher must present an epoch', () => {
    const f = setup();
    cycleOwner(f.storesA, f.account.id, 'core', 'core'); // epoch 3
    expect(evaluateDispatchGate(f.a, f.account.id, 1, 'core', 'job')).toMatchObject({ allow: false, code: 'STALE_EPOCH', epoch: 3 });
    expect(evaluateDispatchGate(f.a, f.account.id, null, 'core', 'job')).toMatchObject({ allow: false, code: 'EPOCH_REQUIRED' });
    expect(evaluateDispatchGate(f.a, f.account.id, 3, 'core', 'job').allow).toBe(true);

    const legacyAcct = addAccount(f.storesA, { writeOwner: 'legacy' });
    cycleOwner(f.storesA, legacyAcct.id, 'legacy', 'legacy');
    expect(evaluateDispatchGate(f.a, legacyAcct.id, 1, 'legacy', 'sender')).toMatchObject({ allow: false, code: 'STALE_EPOCH' });
    expect(evaluateDispatchGate(f.a, legacyAcct.id, null, 'legacy', 'sender').allow).toBe(true);
    expect(evaluateDispatchGate(f.a, legacyAcct.id, 3, 'legacy', 'sender').allow).toBe(true);
  });

  it('a lost holder lock denies (LOCK_LOST) even when the account state allows', () => {
    const f = setup();
    const a = f.storesA.ownership.acquire({ accountId: f.account.id, holderId: 'w1', processToken: 't1', role: 'core', generation: 1, ttlMs: 1_000, nowMs: 100 });
    if (!a.ok) throw new Error('setup');
    expect(evaluateDispatchGate(f.a, f.account.id, 1, 'core', 'job', { lock: a.lock, nowMs: 200 }).allow).toBe(true);
    expect(evaluateDispatchGate(f.b, f.account.id, 1, 'core', 'job', { lock: a.lock, nowMs: 5_000 })).toMatchObject({ allow: false, code: 'LOCK_LOST', detail: 'EXPIRED' });
    cycleOwner(f.storesA, f.account.id, 'core', 'core');
    expect(evaluateDispatchGate(f.a, f.account.id, 3, 'core', 'job', { lock: a.lock, nowMs: 200 })).toMatchObject({ allow: false, code: 'LOCK_LOST', detail: 'STALE_GENERATION' });
  });
});

