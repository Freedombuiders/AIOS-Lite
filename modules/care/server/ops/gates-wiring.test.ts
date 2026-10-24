import { afterEach, describe, expect, it } from 'vitest';
import { wrapApi, T0 } from '../api/test-helpers.js';
import type { CareReplyPort } from '../api/ports.js';
import { createManualClock } from '../runtime/clock.js';
import { DISPATCH_SOURCES, evaluateDispatchGate } from '../runtime/gates.js';
import { SWITCH, engageKillSwitch, setRuntimeSwitch } from '../runtime/switches.js';
import { addAccount, cycleOwner, enqueue, runtimeFixture, type RuntimeFixture } from '../runtime/runtime-fixtures.js';
import { CareWorker, type WorkerEvent } from '../runtime/worker.js';
import { GATED_SURFACES, assertGateWiring, careNavigationState, evaluateGateMatrix, findGateViolations } from './gates-wiring.js';

const open: Array<() => void> = [];
afterEach(() => open.splice(0).forEach((c) => c()));
function setup(): RuntimeFixture {
  const f = runtimeFixture();
  open.push(f.close);
  return f;
}

describe('every surface asks the one gate (AC-010)', () => {
  it('lists a surface for every dispatch source', () => {
    const covered = new Set(GATED_SURFACES.map((s) => s.source).filter(Boolean));
    expect([...covered].sort()).toEqual([...DISPATCH_SOURCES].sort());
    expect(GATED_SURFACES.some((s) => s.surface === 'navigation')).toBe(true);
  });

  it('the gate agrees with an independent reading of the switch and account rows in every state', () => {
    const f = setup();
    const mail = addAccount(f.storesA, { channel: 'email' });
    expect(findGateViolations(f.a)).toEqual([]);
    expect(evaluateGateMatrix(f.a).every((r) => r.allow)).toBe(true);

    const states: Array<[string, () => void, string]> = [
      ['module off', () => setRuntimeSwitch(f.a, SWITCH.module, false, { actor: 't', nowMs: 10 }), 'MODULE_DISABLED'],
      ['module back on', () => setRuntimeSwitch(f.a, SWITCH.module, true, { actor: 't', nowMs: 11 }), 'OK'],
      ['kill switch', () => engageKillSwitch(f.a, { actor: 't', nowMs: 12 }), 'KILL_SWITCH'],
      ['kill released', () => setRuntimeSwitch(f.a, SWITCH.dispatch, true, { actor: 't', nowMs: 13 }), 'OK'],
      ['channel zalo off', () => setRuntimeSwitch(f.a, SWITCH.channel('zalo'), false, { actor: 't', nowMs: 14 }), 'CHANNEL_DISABLED'],
      ['channel zalo on', () => setRuntimeSwitch(f.a, SWITCH.channel('zalo'), true, { actor: 't', nowMs: 15 }), 'OK'],
      ['path job off', () => setRuntimeSwitch(f.a, SWITCH.path('job'), false, { actor: 't', nowMs: 16 }), 'PATH_DISABLED'],
      ['path job on', () => setRuntimeSwitch(f.a, SWITCH.path('job'), true, { actor: 't', nowMs: 17 }), 'OK'],
      ['send flag off', () => f.storesA.accounts.updateAccountFlags(f.account.id, { sendEnabled: false }), 'SEND_DISABLED'],
      ['send flag on', () => f.storesA.accounts.updateAccountFlags(f.account.id, { sendEnabled: true }), 'OK'],
      ['paused', () => f.storesA.accounts.updateAccountFlags(f.account.id, { desiredState: 'paused' }), 'ACCOUNT_NOT_ACTIVE'],
      ['active again', () => f.storesA.accounts.updateAccountFlags(f.account.id, { desiredState: 'active' }), 'OK'],
      ['owner legacy', () => cycleOwner(f.storesA, f.account.id, 'core', 'legacy'), 'OWNER_LEGACY'],
    ];
    for (const [name, apply, code] of states) {
      apply();
      expect(findGateViolations(f.a), name).toEqual([]);
      const row = evaluateGateMatrix(f.a).find((r) => r.accountId === f.account.id && r.source === 'job' && r.operation === 'send')!;
      if (name === 'channel zalo off') {
        // the email account is unaffected by a zalo channel switch
        expect(evaluateGateMatrix(f.a).find((r) => r.accountId === mail.id && r.source === 'job' && r.operation === 'send')!.allow).toBe(true);
      }
      if (name === 'kill switch') {
        // the kill switch stops sends but not ingest/sync work
        expect(evaluateGateMatrix(f.a).find((r) => r.accountId === f.account.id && r.source === 'job' && r.operation === 'work')!.allow).toBe(true);
      }
      expect(row.code, name).toBe(code);
    }
    expect(() => assertGateWiring(f.a)).not.toThrow();
  });

  it('the check catches a gate that ignores a switch', () => {
    const f = setup();
    setRuntimeSwitch(f.a, SWITCH.module, false, { actor: 't', nowMs: 10 });
    // a broken gate that answers "allow" for everything, as if the module switch were not wired in
    const blind: typeof evaluateDispatchGate = (_db, id, epoch) => ({ allow: true, code: 'OK', accountId: id, owner: 'core', epoch });
    const bad = findGateViolations(f.a, blind);
    expect(bad.length).toBeGreaterThan(0);
    expect(bad[0]).toMatchObject({ expected: 'MODULE_DISABLED', actual: 'OK' });
    expect(() => assertGateWiring(f.a, blind)).toThrow(/gate wiring violated/);
  });

  it('navigation follows the module switch and the data-access gate, fail closed', () => {
    const f = setup();
    expect(careNavigationState(f.a, { canRead: () => true })).toEqual({ visible: true, reason: null });
    expect(careNavigationState(f.a, { canRead: () => false })).toEqual({ visible: false, reason: 'READ_DISABLED' });
    expect(careNavigationState(f.a, { canRead: () => { throw new Error('x'); } })).toEqual({ visible: false, reason: 'READ_DISABLED' });
    setRuntimeSwitch(f.a, SWITCH.module, false, { actor: 't', nowMs: 10 });
    expect(careNavigationState(f.a, { canRead: () => true })).toEqual({ visible: false, reason: 'MODULE_DISABLED' });
    f.a.prepare('DELETE FROM care_runtime_switches').run(); // a fresh database: Care is opt-in
    expect(careNavigationState(f.a, { canRead: () => true })).toEqual({ visible: false, reason: 'MODULE_DISABLED' });
  });
});

describe('API and jobs obey the module switch and source gates', () => {
  it('the API refuses to enqueue a reply while the module (or the api path) is off and never reaches the port', async () => {
    const f = setup();
    const conv = f.storesA.conversations.upsertConversation({ accountId: f.account.id, externalKey: 'peer:1', kind: 'direct', title: 'T' });
    let submitted = 0;
    const port: CareReplyPort = {
      async submitReply() {
        submitted += 1;
        return { intent: { id: 'intent-1' } as never, duplicate: false };
      },
      async getOutbox() {
        return null;
      },
      async cancel() {
        return null;
      },
      async reconcile() {
        return null;
      },
    };
    const api = wrapApi(f.storesA, f.a, { replyPort: port, now: () => T0 });
    open.push(() => api.handle.close());
    const reply = (n: number) => api.send('POST', `/api/m/care/conversations/${conv.id}/replies`, { clientRequestId: `req-gates-${n}`, text: 'hello' });

    setRuntimeSwitch(f.a, SWITCH.module, false, { actor: 't', nowMs: 10 });
    const off = await reply(1);
    expect(off.status).toBe(403);
    expect(await off.json()).toMatchObject({ code: 'SEND_DISABLED', details: { reason: 'MODULE_DISABLED' } });

    setRuntimeSwitch(f.a, SWITCH.module, true, { actor: 't', nowMs: 11 });
    setRuntimeSwitch(f.a, SWITCH.path('api'), false, { actor: 't', nowMs: 12 });
    expect(await (await reply(2)).json()).toMatchObject({ details: { reason: 'PATH_DISABLED' } });
    expect(submitted).toBe(0);

    setRuntimeSwitch(f.a, SWITCH.path('api'), true, { actor: 't', nowMs: 13 });
    expect((await reply(3)).status).toBeLessThan(300);
    expect(submitted).toBe(1);
  });

  it('the read gate stops every /api/m/care call, and a blocked source is invisible', async () => {
    const f = setup();
    const conv = f.storesA.conversations.upsertConversation({ accountId: f.account.id, externalKey: 'peer:1', kind: 'direct', title: 'T' });
    const gates = { read: true, source: true };
    const api = wrapApi(f.storesA, f.a, { canRead: () => gates.read, canReadSource: () => gates.source });
    open.push(() => api.handle.close());

    expect((await api.get(`/api/m/care/conversations/${conv.id}`)).status).toBe(200);
    gates.source = false;
    expect((await api.get(`/api/m/care/conversations/${conv.id}`)).status).toBeGreaterThanOrEqual(403);
    expect(((await (await api.get('/api/m/care/health')).json()) as { accounts: unknown[] }).accounts).toEqual([]);
    gates.source = true;
    gates.read = false;
    for (const path of ['/api/m/care/health', '/api/m/care/accounts', '/api/m/care/runtime/switches', `/api/m/care/conversations/${conv.id}`]) {
      const res = await api.get(path);
      expect(res.status, path).toBe(403);
      expect(await res.json(), path).toMatchObject({ code: 'READ_DISABLED' });
    }
    expect((await api.send('POST', `/api/m/care/conversations/${conv.id}/read`, {})).status).toBe(403);
  });

  it('jobs: the worker runs no handler while the module, the job path or the kill switch (for sends) is off', async () => {
    const f = setup();
    enqueue(f.storesA, f.account, 'outbox_dispatch', { dedupeKey: 'g1' });
    enqueue(f.storesA, f.account, 'sync_poll', { dedupeKey: 'g2' });
    const clock = createManualClock(5_000_000);
    const events: WorkerEvent[] = [];
    const ran: string[] = [];
    const worker = new CareWorker({
      db: f.a,
      stores: f.storesA,
      clock,
      onEvent: (e) => events.push(e),
      config: { workerId: 'w1', lockTtlMs: 10_000, leaseMs: 20_000 },
      handlers: {
        outbox_dispatch: () => (ran.push('outbox_dispatch'), { kind: 'done' as const }),
        sync_poll: () => (ran.push('sync_poll'), { kind: 'done' as const }),
      },
    });

    setRuntimeSwitch(f.a, SWITCH.module, false, { actor: 't', nowMs: 10 });
    await worker.runOnce();
    expect(ran).toEqual([]);
    expect(events.some((e) => e.type === 'gate_denied' && e.code === 'MODULE_DISABLED')).toBe(true);

    setRuntimeSwitch(f.a, SWITCH.module, true, { actor: 't', nowMs: 11 });
    setRuntimeSwitch(f.a, SWITCH.path('job'), false, { actor: 't', nowMs: 12 });
    events.length = 0;
    await worker.runOnce();
    expect(ran).toEqual([]);
    expect(events.some((e) => e.type === 'gate_denied' && e.code === 'PATH_DISABLED')).toBe(true);

    setRuntimeSwitch(f.a, SWITCH.path('job'), true, { actor: 't', nowMs: 13 });
    await clock.advance(1_000);
    await worker.runOnce();
    expect(ran.length).toBeGreaterThan(0);
  });
});
