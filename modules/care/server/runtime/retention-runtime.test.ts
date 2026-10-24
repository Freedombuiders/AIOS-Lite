/**
 * CC-12: the retention/redaction loop is part of the runtime schedule and ALWAYS runs with the Care key. Without a
 * usable key the loop is refused (never half-run) and health says so. Fake clock, synthetic data.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeRunner } from '../application/agent-test-support.js';
import { decryptCareFieldStrict, createUnavailableCareKey, type CareKeyInput } from '../persistence/crypto.js';
import { TEST_KEY } from '../test-fixtures.js';
import { createManualClock } from './clock.js';
import { createCareRuntime, startCareRuntime, type CareRuntimeDeps } from './care-runtime.js';
import { runtimeFixture, type RuntimeFixture } from './runtime-fixtures.js';

const open: Array<() => void> = [];
afterEach(() => {
  vi.useRealTimers();
  open.splice(0).forEach((c) => c());
});
const settle = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
};
const HOUR = 3_600_000;

function rig(key: CareKeyInput | undefined) {
  const f: RuntimeFixture = runtimeFixture();
  open.push(f.close);
  const clock = createManualClock(Date.now());
  f.storesA.bridge.upsertArtifact({
    id: 'art-erased',
    accountId: f.account.id,
    sourceKind: 'zalo',
    sourceTable: 'zalo_outbox',
    sourceId: 'gone',
    state: 'sent',
    sourceDeleted: true,
    sourceVersion: 3,
    payload: { image: { text: 'ERASED CUSTOMER TEXT 0901234567' } },
  });
  const payload = () =>
    (f.a.prepare(`SELECT payload_enc FROM care_bridge_artifacts WHERE id = 'art-erased'`).get() as { payload_enc: string }).payload_enc;
  const plain = () => decryptCareFieldStrict(payload(), TEST_KEY);
  const build = (extra: Partial<CareRuntimeDeps> = {}) =>
    createCareRuntime({
      db: f.a,
      stores: f.storesA,
      connectors: { forAccount: () => null },
      runner: new FakeRunner(),
      workerId: 'w1',
      clock,
      worker: { lockTtlMs: 600_000, leaseMs: 600_000, idleSleepMs: 500 },
      ...(key !== undefined ? { key } : {}),
      retention: { intervalMs: HOUR },
      ...extra,
    });
  return { f, clock, build, plain };
}

describe('with the Care key', () => {
  it('startCareRuntime runs redaction on the schedule: erased content is rewritten, later passes follow the interval', async () => {
    const r = rig(TEST_KEY);
    const rt = r.build();
    expect(r.plain()).toContain('ERASED CUSTOMER TEXT');
    startCareRuntime(rt, { clock: r.clock, idleSleepMs: 500 });
    await settle();
    expect(r.plain()).not.toContain('ERASED CUSTOMER TEXT');
    const h1 = rt.getCareHealth();
    expect(h1.retention).toMatchObject({ state: 'running', reason: null, lastError: null });
    expect(h1.retention.lastResult?.redaction).toMatchObject({ artifactPayloads: 1, artifactsUnredacted: 0 });
    const firstRun = h1.retention.lastRunAtMs!;
    expect(h1.level).not.toBe('error');

    await r.clock.advance(HOUR + 1_000);
    await settle();
    expect(rt.retentionHealth().lastRunAtMs!).toBeGreaterThan(firstRun);
    expect(rt.retentionHealth().lastResult?.redaction.artifactPayloads).toBe(0); // idempotent

    await rt.stop(500);
    expect(rt.retentionHealth().state).toBe('stopped');
    const stoppedAt = rt.retentionHealth().lastRunAtMs;
    await r.clock.advance(3 * HOUR);
    await settle();
    expect(rt.retentionHealth().lastRunAtMs).toBe(stoppedAt); // no pass after stop
  });

  it('getCareHealth carries the ops health (accounts, gates) plus the retention block', () => {
    const r = rig(TEST_KEY);
    const rt = r.build();
    const h = rt.getCareHealth();
    expect(h.accounts.map((a) => a.id)).toContain(r.f.account.id);
    expect(h.gates.moduleEnabled).toBe(true);
    expect(h.retention.state).toBe('not_started');
    expect(h.level).not.toBe('error'); // not started is not a fault
  });
});

describe('without a usable key', () => {
  it.each([
    ['no key at all', undefined],
    ['the unavailable marker (db.ts could not bind a strict key)', createUnavailableCareKey('DB_ENCRYPTION_KEY invalid')],
    ['a key of the wrong size', Buffer.alloc(16, 1)],
  ])('%s: the loop is refused, erased content is NOT touched, health is an error with the reason', async (_name, key) => {
    const r = rig(key as CareKeyInput | undefined);
    const rt = r.build();
    expect(rt.startRetention()).toBeNull();
    startCareRuntime(rt, { clock: r.clock, idleSleepMs: 500 }); // the worker still starts; only the retention loop is refused
    await settle();
    expect(r.plain()).toContain('ERASED CUSTOMER TEXT'); // never silently "ran" without being able to redact
    const h = rt.getCareHealth();
    expect(h.retention).toMatchObject({ state: 'refused_no_key', reason: 'missing_or_unusable_key', lastRunAtMs: null, lastResult: null });
    expect(h.level).toBe('error');
    await rt.stop(500);
  });
});

describe('default off', () => {
  it('creating a runtime starts no retention timer or pass', async () => {
    vi.useFakeTimers();
    const r = rig(TEST_KEY);
    const rt = r.build();
    expect(vi.getTimerCount()).toBe(0);
    expect(rt.retentionHealth()).toMatchObject({ state: 'not_started', lastRunAtMs: null });
    expect(r.plain()).toContain('ERASED CUSTOMER TEXT');
  });
});
