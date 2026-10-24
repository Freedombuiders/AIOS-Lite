import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CareError } from '../../../_lib/care-kit/errors.js';
import { releaseHeldJob } from './backlog.js';
import { createManualClock } from './clock.js';
import { CareWorker, type JobHandler, type WorkerConfig, type WorkerEvent } from './worker.js';
import { SWITCH, engageKillSwitch, setRuntimeSwitch } from './switches.js';
import { addAccount, cycleOwner, deferred, enqueue, runtimeFixture } from './runtime-fixtures.js';
import { Supervisor, type SupervisorEvent } from './supervisor.js';
import type { FairnessPolicy } from './fairness.js';

const open: Array<() => void> = [];
afterEach(() => open.splice(0).forEach((c) => c()));
const settle = () => new Promise<void>((r) => setImmediate(r));

function setup(over = {}) {
  const f = runtimeFixture(over);
  open.push(f.close);
  const clock = createManualClock(5_000_000);
  const events: WorkerEvent[] = [];
  const make = (which: 'a' | 'b', handlers: Record<string, JobHandler>, config: Partial<WorkerConfig> = {}, extra: { fairness?: FairnessPolicy } = {}) =>
    new CareWorker({
      db: which === 'a' ? f.a : f.b,
      stores: which === 'a' ? f.storesA : f.storesB,
      handlers,
      clock,
      onEvent: (e) => events.push(e),
      config: { workerId: `worker-${which}`, lockTtlMs: 10_000, leaseMs: 20_000, ...config },
      ...extra,
    });
  return { ...f, clock, events, make };
}

const done: JobHandler = () => ({ kind: 'done' });

describe('two workers racing for one account (AC-020/030)', () => {
  it('only one holds the account; every job is handled exactly once', async () => {
    const s = setup();
    const ids = Array.from({ length: 6 }, (_, i) => enqueue(s.storesA, s.account, 'outbox_dispatch', { dedupeKey: `j${i}` }).id);
    const handled: Array<{ worker: string; job: string }> = [];
    const mk = (w: 'a' | 'b') => s.make(w, { outbox_dispatch: (ctx) => (handled.push({ worker: w, job: ctx.job.id }), { kind: 'done' as const }) }, { batchPerAccount: 2 });
    const a = mk('a');
    const b = mk('b');
    const ra = await a.runOnce();
    const rb = await b.runOnce();
    expect(ra.accounts[s.account.id]).toMatchObject({ claimed: 2, done: 2 });
    expect(rb.accounts[s.account.id]).toMatchObject({ skipped: 'LOCK_DENIED', claimed: 0 });
    for (let i = 0; i < 4; i++) await Promise.all([a.runOnce(), b.runOnce()]);
    expect(handled.map((h) => h.job).sort()).toEqual([...ids].sort());
    expect(new Set(handled.map((h) => h.worker))).toEqual(new Set(['a']));
    expect(s.storesA.ownership.getHolder(s.account.id)?.holderId).toBe('worker-a');
  });

  it('a restarted holder (same id, new process token) is not trusted until the old lock lapses', async () => {
    const s = setup();
    enqueue(s.storesA, s.account, 'outbox_dispatch', { dedupeKey: 'x' });
    const a = s.make('a', { outbox_dispatch: done });
    await a.runOnce();
    const restarted = s.make('b', { outbox_dispatch: done }, { workerId: 'worker-a', processToken: 'new-process' });
    expect((await restarted.runOnce()).accounts[s.account.id]).toMatchObject({ skipped: 'LOCK_DENIED' });
    await s.clock.advance(10_001);
    enqueue(s.storesA, s.account, 'outbox_dispatch', { dedupeKey: 'y' });
    expect((await restarted.runOnce()).accounts[s.account.id]).toMatchObject({ claimed: 1, done: 1 });
    expect(s.storesA.ownership.getHolder(s.account.id)).toMatchObject({ holderId: 'worker-a', lockSeq: 2 });
  });
});

describe('stale epoch worker (claim / send / heartbeat)', () => {
  it('an in-flight lane loses heartbeat, authorisation and its outcome write after the owner cycles away and back', async () => {
    const s = setup();
    const job = enqueue(s.storesA, s.account, 'outbox_dispatch');
    const gate = deferred();
    const seen: { heartbeat?: boolean; threw?: string; beforeHeartbeat?: boolean } = {};
    const worker = s.make('a', {
      outbox_dispatch: async (ctx) => {
        ctx.assertAuthorised();
        seen.beforeHeartbeat = ctx.heartbeat();
        await gate.promise;
        seen.heartbeat = ctx.heartbeat();
        try {
          ctx.assertAuthorised();
        } catch (e) {
          seen.threw = e instanceof CareError ? e.code : 'other';
          throw e;
        }
        return { kind: 'done' };
      },
    });
    const run = worker.runOnce();
    await settle();
    const oldLock = worker.heldLocks()[0];
    const epoch = cycleOwner(s.storesB, s.account.id, 'core', 'core');
    expect(epoch).toBe(3);
    gate.resolve();
    const report = await run;
    expect(seen).toEqual({ beforeHeartbeat: true, heartbeat: false, threw: 'FENCING_REJECTED' });
    expect(report.accounts[s.account.id]).toMatchObject({ claimed: 1, done: 0 });
    // the old-epoch job is neither completed nor claimable again: epoch fencing in the job store
    expect(s.storesA.jobs.getJob(job.id)?.status).not.toBe('completed');
    expect(s.storesB.jobs.claimJobs({ workerId: 'late', currentEpoch: 1, leaseDurationMs: 1_000, nowMs: 5_000_001 })).toEqual([]);
    expect(s.storesB.jobs.claimJobs({ workerId: 'late', currentEpoch: 3, leaseDurationMs: 1_000, nowMs: 5_000_001 })).toEqual([]);
    // and its holder lock is dead
    expect(s.storesA.ownership.renew(oldLock, { ttlMs: 1_000, nowMs: 5_000_001 })).toMatchObject({ ok: false, reason: 'STALE_GENERATION' });
  });

  it('a handler that finishes under a changed epoch cannot complete the job (outcome CAS refused and counted)', async () => {
    const s = setup();
    const job = enqueue(s.storesA, s.account, 'outbox_dispatch');
    const gate = deferred();
    const worker = s.make('a', { outbox_dispatch: async () => (await gate.promise, { kind: 'done' as const }) });
    const run = worker.runOnce();
    await settle();
    cycleOwner(s.storesB, s.account.id, 'core', 'core');
    gate.resolve();
    expect((await run).accounts[s.account.id]).toMatchObject({ done: 0, fenced: 1 });
    expect(s.storesA.jobs.getJob(job.id)?.status).toBe('claimed');
  });
});

describe('runtime switches stop the worker; re-enable never auto-sends backlog (AC-021)', () => {
  it('module off: nothing is claimed; turning it on holds the older backlog, new work flows, release is explicit', async () => {
    const s = setup();
    const calls: string[] = [];
    const worker = s.make('a', { outbox_dispatch: (ctx) => (calls.push(ctx.job.id), { kind: 'done' }) });
    setRuntimeSwitch(s.a, SWITCH.module, false, { actor: 'op', nowMs: 5_000_000 });
    const old1 = enqueue(s.storesA, s.account, 'outbox_dispatch', { dedupeKey: 'old1' });
    const old2 = enqueue(s.storesA, s.account, 'outbox_dispatch', { dedupeKey: 'old2' });
    s.a.prepare('UPDATE care_jobs SET created_at = 1000').run();

    expect((await worker.runOnce()).accounts[s.account.id]).toMatchObject({ skipped: 'MODULE_DISABLED', claimed: 0 });
    expect(calls).toEqual([]);

    const re = setRuntimeSwitch(s.a, SWITCH.module, true, { actor: 'op', reason: 'back', nowMs: 5_000_000 });
    expect(re).toMatchObject({ reenabled: true, held: 2 });
    const fresh = enqueue(s.storesA, s.account, 'outbox_dispatch', { dedupeKey: 'fresh' });
    s.a.prepare('UPDATE care_jobs SET created_at = 6000000 WHERE id = ?').run(fresh.id);

    await s.clock.advance(1_000);
    const totals = [await worker.runOnce(), await worker.runOnce(), await worker.runOnce()].map((r) => r.accounts[s.account.id]);
    expect(totals.reduce((n, t) => n + t.held, 0)).toBe(2);
    expect(totals.reduce((n, t) => n + t.done, 0)).toBe(1);
    expect(calls).toEqual([fresh.id]); // the backlog was NOT handled
    expect(s.storesA.jobs.getJob(old1.id)).toMatchObject({ status: 'failed', lastError: 'backlog_held' });
    expect(s.storesA.ownership.listHolds({ status: 'held' }).map((h) => h.itemId).sort()).toEqual([old1.id, old2.id].sort());

    // explicit review: release one, discard the other
    const rel = releaseHeldJob(s.storesA, s.a, old1.id, 'operator:tony', 5_001_500);
    expect(rel).toMatchObject({ released: true });
    expect(rel.requeuedJobId).toBeTruthy();
    expect(releaseHeldJob(s.storesA, s.a, old1.id, 'operator:tony').released).toBe(false);
    s.storesA.ownership.resolveHold('job', old2.id, 'discarded', { actor: 'operator:tony' });
    await s.clock.advance(1_000);
    await worker.runOnce();
    await worker.runOnce();
    expect(calls).toEqual([fresh.id, rel.requeuedJobId]);
  });

  it('kill switch: outbox_dispatch jobs are not claimed (stay pending) while ingest work keeps running', async () => {
    const s = setup();
    const send = enqueue(s.storesA, s.account, 'outbox_dispatch', { dedupeKey: 's' });
    const turn = enqueue(s.storesA, s.account, 'inbound_turn', { dedupeKey: 't' });
    const calls: string[] = [];
    const worker = s.make(
      'a',
      {
        outbox_dispatch: () => (calls.push('send'), { kind: 'done' }),
        inbound_turn: () => (calls.push('turn'), { kind: 'done' }),
      },
      { batchPerAccount: 5 },
    );
    engageKillSwitch(s.a, { actor: 'op', nowMs: 5_000_000 });
    await worker.runOnce();
    expect(calls).toEqual(['turn']);
    expect(s.storesA.jobs.getJob(send.id)?.status).toBe('pending');
    expect(s.storesA.jobs.getJob(turn.id)?.status).toBe('completed');
  });

  it('path switch "job" stops the worker even though the API path is open; a paused account is not offered a lane', async () => {
    const s = setup();
    enqueue(s.storesA, s.account, 'outbox_dispatch');
    const calls: string[] = [];
    const worker = s.make('a', { outbox_dispatch: (ctx) => (calls.push(ctx.job.id), { kind: 'done' }) });
    setRuntimeSwitch(s.a, SWITCH.path('job'), false, { actor: 'op', nowMs: 1 });
    expect((await worker.runOnce()).accounts[s.account.id]).toMatchObject({ skipped: 'PATH_DISABLED' });
    setRuntimeSwitch(s.a, SWITCH.path('job'), true, { actor: 'op', nowMs: 1 });
    s.storesA.accounts.updateAccountFlags(s.account.id, { desiredState: 'paused' });
    expect(Object.keys((await worker.runOnce()).accounts)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('a legacy-owned or draining account is never served by the Care worker', async () => {
    const s = setup({ writeOwner: 'legacy' });
    s.storesA.accounts.updateAccountFlags(s.account.id, { desiredState: 'active' });
    enqueue(s.storesA, s.account, 'outbox_dispatch');
    const calls: string[] = [];
    const worker = s.make('a', { outbox_dispatch: (ctx) => (calls.push(ctx.job.id), { kind: 'done' }) });
    expect(Object.keys((await worker.runOnce()).accounts)).toEqual([]);
    s.storesA.ownership.applyOwnerTransition({ accountId: s.account.id, expectedOwner: 'legacy', expectedEpoch: 1, toOwner: 'draining', kind: 'forward', actor: 'op', reason: 'x' });
    expect(Object.keys((await worker.runOnce()).accounts)).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe('job outcomes', () => {
  it('maps done / retry / fail / release / thrown errors onto the fenced job CAS', async () => {
    const s = setup();
    const mk = (key: string) => enqueue(s.storesA, s.account, 'sync_poll', { dedupeKey: key });
    const j = { done: mk('d'), retry: mk('r'), fail: mk('f'), release: mk('l'), boom: mk('b'), fenced: mk('x') };
    const worker = s.make(
      'a',
      {
        sync_poll: (ctx) => {
          const k = Object.entries(j).find(([, v]) => v.id === ctx.job.id)![0];
          if (k === 'retry') return { kind: 'retry', error: 'temporary', backoffMs: 60_000 };
          if (k === 'fail') return { kind: 'fail', error: 'permanent' };
          if (k === 'release') return { kind: 'release' };
          if (k === 'boom') throw new Error('kaboom');
          if (k === 'fenced') throw new CareError('FENCING_REJECTED', 'no', 409);
          return { kind: 'done' };
        },
      },
      { batchPerAccount: 10 },
    );
    await worker.runOnce();
    const st = (k: keyof typeof j) => s.storesA.jobs.getJob(j[k].id)!;
    expect(st('done').status).toBe('completed');
    expect(st('retry')).toMatchObject({ status: 'pending', lastError: 'temporary', dueAtMs: 5_000_000 + 60_000 });
    expect(st('fail')).toMatchObject({ status: 'failed', lastError: 'permanent' });
    expect(st('release')).toMatchObject({ status: 'pending', attempts: 0 });
    expect(st('boom')).toMatchObject({ status: 'pending', lastError: 'kaboom' });
    expect(st('fenced')).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('only job types with a handler are claimed', async () => {
    const s = setup();
    const unhandled = enqueue(s.storesA, s.account, 'cleanup');
    const worker = s.make('a', { sync_poll: done });
    await worker.runOnce();
    expect(s.storesA.jobs.getJob(unhandled.id)?.status).toBe('pending');
  });
});

describe('fairness across accounts', () => {
  it('a busy account cannot starve the others: every account gets its batch in one tick', async () => {
    const s = setup();
    const quiet1 = addAccount(s.storesA);
    const quiet2 = addAccount(s.storesA);
    for (let i = 0; i < 9; i++) enqueue(s.storesA, s.account, 'sync_poll', { dedupeKey: `busy${i}` });
    enqueue(s.storesA, quiet1, 'sync_poll');
    enqueue(s.storesA, quiet2, 'sync_poll');
    const order: string[] = [];
    const worker = s.make('a', { sync_poll: (ctx) => (order.push(ctx.accountId), { kind: 'done' }) }, { batchPerAccount: 1, maxConcurrentAccounts: 1 });
    await worker.runOnce();
    expect(order).toHaveLength(3);
    expect(new Set(order)).toEqual(new Set([s.account.id, quiet1.id, quiet2.id]));
    // second tick: only the busy account still has work, and it is served again (one batch)
    order.length = 0;
    await worker.runOnce();
    expect(order).toEqual([s.account.id]);
  });

  it('the injected policy decides who is served: dropping an account from the order skips it', async () => {
    const s = setup();
    const other = addAccount(s.storesA);
    enqueue(s.storesA, s.account, 'sync_poll');
    enqueue(s.storesA, other, 'sync_poll');
    const served: string[] = [];
    const worker = s.make('a', { sync_poll: (ctx) => (served.push(ctx.accountId), { kind: 'done' }) }, {}, { fairness: { order: () => [other.id] } });
    await worker.runOnce();
    expect(served).toEqual([other.id]);
  });
});

describe('graceful drain', () => {
  it('lets the running lane finish, then releases the lock and takes no new work', async () => {
    const s = setup();
    enqueue(s.storesA, s.account, 'outbox_dispatch', { dedupeKey: 'a' });
    enqueue(s.storesA, s.account, 'outbox_dispatch', { dedupeKey: 'b' });
    const gate = deferred();
    let handled = 0;
    const worker = s.make('a', { outbox_dispatch: async () => (handled++, await gate.promise, { kind: 'done' as const }) });
    const tick = worker.runOnce();
    await settle();
    const draining = worker.drain(30_000);
    gate.resolve();
    expect(await draining).toEqual({ drained: true, abandonedAccounts: [] });
    await tick;
    expect(worker.draining).toBe(true);
    expect(s.storesA.ownership.getHolder(s.account.id)?.releasedAtMs).not.toBeNull();
    expect((await worker.runOnce()).jobsClaimed).toBe(0);
    expect(handled).toBe(1);
  });

  it('a lane stuck past the timeout is abandoned: handlers are signalled and the lock is NOT released', async () => {
    const s = setup();
    enqueue(s.storesA, s.account, 'outbox_dispatch');
    const never = deferred();
    let aborted = false;
    const worker = s.make('a', {
      outbox_dispatch: async (ctx) => {
        ctx.signal.addEventListener('abort', () => {
          aborted = true;
        });
        await never.promise;
        return { kind: 'done' as const };
      },
    });
    void worker.runOnce();
    await settle();
    const draining = worker.drain(5_000);
    await settle();
    await s.clock.advance(5_000);
    expect(await draining).toEqual({ drained: false, abandonedAccounts: [s.account.id] });
    expect(aborted).toBe(true);
    // nobody else may start dispatching next to an RPC that might still be in flight
    expect(s.storesA.ownership.getHolder(s.account.id)?.releasedAtMs).toBeNull();
    expect(
      s.storesB.ownership.acquire({ accountId: s.account.id, holderId: 'other', processToken: 'o', role: 'core', generation: 1, ttlMs: 1_000, nowMs: 5_000_100 }),
    ).toMatchObject({ ok: false, reason: 'HELD_BY_OTHER' });
    never.resolve();
  });
});

describe('supervision', () => {
  const run = async (crashes: number, opts: { fatalOn?: number; max?: number } = {}) => {
    const clock = createManualClock(0);
    const events: SupervisorEvent[] = [];
    let n = 0;
    const sup = new Supervisor({
      name: 'sut',
      clock,
      backoff: { initialMs: 1_000, maxMs: 5_000, factor: 2, resetAfterMs: 60_000, maxConsecutiveFailures: opts.max },
      isFatal: (e) => e instanceof CareError && e.code === 'CREDENTIAL_DECODE_FAILED',
      onEvent: (e) => events.push(e),
      run: async (signal) => {
        n += 1;
        if (n === opts.fatalOn) throw new CareError('CREDENTIAL_DECODE_FAILED', 'bad key');
        if (n <= crashes) throw new Error(`crash ${n}`);
        await new Promise<void>((res) => signal.addEventListener('abort', () => res())); // healthy until stopped
      },
    });
    sup.start();
    for (let i = 0; i < 12; i++) {
      await settle();
      await clock.advance(5_000);
    }
    return { sup, events, runs: () => n };
  };

  it('restarts with exponential backoff capped at maxMs', async () => {
    const { sup, events, runs } = await run(4);
    expect(events.filter((e) => e.type === 'restarting').map((e) => e.delayMs)).toEqual([1_000, 2_000, 4_000, 5_000]);
    expect(runs()).toBe(5);
    expect(sup.state).toBe('running');
    await sup.stop();
    expect(sup.state).toBe('stopped');
  });

  it('does not reconnect forever: a fatal error stops it, a crash loop is bounded', async () => {
    const fatal = await run(1, { fatalOn: 2 });
    expect(fatal.sup.state).toBe('failed');
    expect(fatal.events.some((e) => e.type === 'fatal')).toBe(true);
    const loop = await run(100, { max: 3 });
    expect(loop.sup.state).toBe('failed');
    expect(loop.events.some((e) => e.type === 'gave_up')).toBe(true);
    expect(loop.runs()).toBe(4);
  });

  it('a long healthy run resets the failure streak', async () => {
    const clock = createManualClock(0);
    const delays: number[] = [];
    let n = 0;
    const sup = new Supervisor({
      name: 'reset',
      clock,
      backoff: { initialMs: 1_000, maxMs: 60_000, factor: 2, resetAfterMs: 10_000 },
      onEvent: (e) => {
        if (e.type === 'restarting') delays.push(e.delayMs!);
      },
      run: async (signal) => {
        n += 1;
        if (n === 3) await clock.sleep(11_000); // healthy long enough, then crashes
        if (n < 5) throw new Error('x');
        await new Promise<void>((res) => signal.addEventListener('abort', () => res()));
      },
    });
    sup.start();
    for (let i = 0; i < 30; i++) {
      await settle();
      await clock.advance(1_000);
    }
    expect(delays.slice(0, 4)).toEqual([1_000, 2_000, 1_000, 2_000]);
    await sup.stop();
  });

  it('the worker loop itself runs supervised and stops on drain', async () => {
    const s = setup();
    enqueue(s.storesA, s.account, 'sync_poll');
    let handled = 0;
    const worker = s.make('a', { sync_poll: () => (handled++, { kind: 'done' }) }, { idleSleepMs: 500 });
    const sup = worker.start();
    await settle();
    await s.clock.advance(1_000);
    expect(handled).toBe(1);
    await worker.drain(1_000);
    expect(sup.state).toBe('stopped');
  });
});

describe('the worker orchestrates only', () => {
  it('runtime sources import no connector implementation, provider SDK or model package (only the in-repo contract and the connector registry)', () => {
    const dir = path.dirname(new URL(import.meta.url).pathname);
    const banned = /from ['"](?:\.\.\/connectors\/(?!contract\.js|registry\.js)|\.\.\/\.\.\/(?:zalo|email|telegram|fbstudio|integrations)|googleapis|@anthropic-ai|openai|telegram|gramjs|zca|node-fetch|undici)/;
    const offenders = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .filter((f) => banned.test(fs.readFileSync(path.join(dir, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
