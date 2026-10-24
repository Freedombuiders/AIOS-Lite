import { _initTestDatabase } from './test-db.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getFbAdAccount,
  listFbAdAccounts,
  listFbAdsRecommendations,
  markFbAdAccountSynced,
  updateFbAdAccountSettings,
  upsertFbAdAccount,
} from './store.js';
import { metaRead } from './graph-tools.js';
import { makeFakeMeta } from './test-fixtures.js';

vi.mock('../../_lib/composio.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../_lib/composio.js')>();
  return { ...actual, listConnections: vi.fn(), hasComposioKey: vi.fn(() => true), getComposio: vi.fn() };
});
vi.mock('./graph-tools.js', () => ({ metaRead: vi.fn() }));
vi.mock('./context.js', async (original) => ({ ...await original<typeof import('./context.js')>(), notifyOwner: vi.fn(async () => {}), isFbStudioEnabled: vi.fn(() => true) }));


import {
  ComposioAuthError,
  ComposioConnectionExpiredError,
  ComposioRateLimitError,
  hasComposioKey,
  listConnections,
  type ComposioConnection,
} from '../../_lib/composio.js';
import { isFbStudioEnabled } from './context.js';
import { notifyOwner } from './context.js';
import { _resetAdsConnectionCache } from './accounts.js';
import { _resetCreativeProbe, _resetSnapshotGuards } from './snapshot.js';
import { _resetAdsWorker, runAdsTick } from './worker.js';

const NOW = Math.floor(Date.now() / 1000);

const conn = (over: Partial<ComposioConnection> = {}): ComposioConnection => ({
  id: 'ca_1', toolkit: 'metaads', status: 'ACTIVE', alias: null, entityId: 'e1', authConfigId: 'ac_1', ...over,
});

const list = vi.mocked(listConnections);
const run = vi.mocked(metaRead);

function seed(id = 'act_111', enabled = true): void {
  upsertFbAdAccount({ id, name: id, currency: 'VND', timezone: 'Asia/Ho_Chi_Minh', connectionId: 'ca_1', entityId: 'e1', status: 'ACTIVE' });
  updateFbAdAccountSettings(id, { enabled, targetCpa: 120_000 });
}

beforeEach(() => {
  _initTestDatabase(':memory:');
  _resetAdsConnectionCache();
  _resetSnapshotGuards();
  _resetCreativeProbe();
  _resetAdsWorker();
  list.mockReset();
  list.mockResolvedValue([conn()]);
  run.mockReset();
  run.mockImplementation(makeFakeMeta().execute as never);
  vi.mocked(isFbStudioEnabled).mockReturnValue(true);
  vi.mocked(hasComposioKey).mockReturnValue(true);
  vi.mocked(notifyOwner).mockClear();
});

describe('ads worker tick', () => {
  it('does nothing while the studio is switched off', async () => {
    seed();
    vi.mocked(isFbStudioEnabled).mockReturnValue(false);
    await runAdsTick(NOW);
    expect(list).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('does nothing without an enabled account or without a key', async () => {
    seed('act_111', false);
    await runAdsTick(NOW);
    expect(run).not.toHaveBeenCalled();
    updateFbAdAccountSettings('act_111', { enabled: true });
    vi.mocked(hasComposioKey).mockReturnValue(false);
    await runAdsTick(NOW);
    expect(run).not.toHaveBeenCalled();
  });

  it('snapshots an enabled account that was never synced', async () => {
    seed();
    await runAdsTick(NOW);
    expect(run).toHaveBeenCalled();
    expect(getFbAdAccount('act_111')!.synced_at).toBe(NOW);
    expect(listFbAdsRecommendations('act_111', ['open']).length).toBeGreaterThan(0);
  });

  it('snapshots hourly, not on every tick', async () => {
    seed();
    markFbAdAccountSynced('act_111', NOW - 30 * 60);
    await runAdsTick(NOW);
    expect(run).not.toHaveBeenCalled();
    await runAdsTick(NOW + 26 * 60); // 56 minutes after the last snapshot
    expect(run).toHaveBeenCalled();
  });

  it('skips disabled accounts and EXPIRED ones', async () => {
    seed('act_111', false);
    seed('act_222');
    list.mockResolvedValue([conn({ status: 'EXPIRED' })]);
    await runAdsTick(NOW);
    expect(run).not.toHaveBeenCalled();
    expect(getFbAdAccount('act_222')!.status).toBe('EXPIRED');
  });

  it('marks an account EXPIRED and tells the owner once when the connection dies mid-run', async () => {
    seed();
    run.mockReset();
    run.mockRejectedValue(new ComposioConnectionExpiredError());
    await runAdsTick(NOW);
    expect(getFbAdAccount('act_111')!.status).toBe('EXPIRED');
    expect(notifyOwner).toHaveBeenCalledTimes(1);
    _resetSnapshotGuards();
    await runAdsTick(NOW + 3600);
    expect(notifyOwner).toHaveBeenCalledTimes(1);
  });

  it('re-binds EXPIRED accounts once a connection is ACTIVE again and then snapshots them', async () => {
    seed();
    list.mockResolvedValue([conn({ status: 'EXPIRED' })]);
    await runAdsTick(NOW);
    expect(getFbAdAccount('act_111')!.status).toBe('EXPIRED');
    list.mockResolvedValue([conn({ id: 'ca_2', entityId: 'e2' })]);
    _resetAdsConnectionCache();
    await runAdsTick(NOW + 3600);
    expect(getFbAdAccount('act_111')).toMatchObject({ status: 'ACTIVE', connection_id: 'ca_2', entity_id: 'e2' });
    expect(getFbAdAccount('act_111')!.synced_at).toBe(NOW + 3600);
  });

  it('backs off for the rest of the tick after a rate limit and retries on the next', async () => {
    seed('act_111');
    seed('act_222');
    run.mockReset();
    run.mockRejectedValueOnce(new ComposioRateLimitError());
    await runAdsTick(NOW);
    expect(run).toHaveBeenCalledTimes(1); // the second account was not tried
    run.mockImplementation(makeFakeMeta().execute as never);
    _resetSnapshotGuards();
    await runAdsTick(NOW + 60); // still inside the back-off
    expect(listFbAdAccounts().every((a) => a.synced_at === null)).toBe(true);
    await runAdsTick(NOW + 6 * 60);
    expect(listFbAdAccounts().every((a) => a.synced_at !== null)).toBe(true);
  });

  it('retries a failing account only after 15 minutes and does not stop the others', async () => {
    seed('act_111');
    seed('act_222');
    const fake = makeFakeMeta();
    run.mockReset();
    run.mockImplementation((async (slug: string, args: Record<string, any>, target: any) => {
      if (args.ad_account_id === 'act_111') throw new Error('boom');
      if (args.object_id === 'act_111') throw new Error('boom');
      return fake.execute(slug, args, target);
    }) as never);
    await runAdsTick(NOW);
    expect(getFbAdAccount('act_111')!.synced_at).toBeNull();
    expect(getFbAdAccount('act_222')!.synced_at).toBe(NOW);

    const callsBefore = run.mock.calls.length;
    _resetSnapshotGuards();
    await runAdsTick(NOW + 5 * 60); // act_111 waits out its 15 minutes, act_222 is not due yet
    expect(run.mock.calls.length).toBe(callsBefore);
    await runAdsTick(NOW + 16 * 60);
    expect(run.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('stops quietly on a rejected key', async () => {
    seed();
    run.mockReset();
    run.mockRejectedValue(new ComposioAuthError());
    await expect(runAdsTick(NOW)).resolves.toBeUndefined();
    expect(getFbAdAccount('act_111')!.status).toBe('ACTIVE');
  });

  it('expires recommendations nobody has confirmed for two days', async () => {
    seed();
    await runAdsTick(NOW);
    const open = listFbAdsRecommendations('act_111', ['open']);
    expect(open.length).toBeGreaterThan(0);
    // Snapshots stop (connection gone); two days later the advice is no longer trustworthy.
    list.mockResolvedValue([conn({ status: 'EXPIRED' })]);
    _resetAdsConnectionCache();
    await runAdsTick(Math.floor(Date.now() / 1000) + 49 * 3600);
    expect(listFbAdsRecommendations('act_111', ['open'])).toHaveLength(0);
    expect(listFbAdsRecommendations('act_111', ['expired']).length).toBe(open.length);
  });

  it('does not overlap two ticks', async () => {
    seed();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    run.mockReset();
    run.mockImplementation((async () => { await gate; return { data: { data: [] } }; }) as never);
    const first = runAdsTick(NOW);
    await runAdsTick(NOW); // returns at once: the first one is still running
    expect(run.mock.calls.length).toBeLessThanOrEqual(1);
    release();
    await first;
  });
});
