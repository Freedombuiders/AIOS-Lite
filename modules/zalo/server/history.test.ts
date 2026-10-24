import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _setHistorySleepForTests, syncGroupList } from './history.js';
import type { IngestContext } from './ingest.js';
import { createZaloAccount, listZaloThreads } from './store.js';
import { _initTestDatabase } from './test-db.js';

type Check = { ok: boolean; reason?: 'daily' | 'burst'; retryAfterMs?: number };

function fakeCtx(accountId: string, checks: Check[]) {
  const consume = vi.fn(() => checks.shift() ?? { ok: true });
  const api = {
    getAllGroups: vi.fn(async () => ({ gridVerMap: { g1: '1', g2: '1' } })),
    getGroupInfo: vi.fn(async () => ({ gridInfoMap: { g1: { name: 'Nhóm Một' }, g2: { name: 'Nhóm Hai' } } })),
  };
  const ctx = { accountId, ownUid: 'me', api, limiter: { consume } } as unknown as IngestContext;
  return { ctx, api, consume };
}

describe('group backfill and the anti-ban budget', () => {
  let slept: number[];
  beforeEach(() => {
    _initTestDatabase();
    slept = [];
    _setHistorySleepForTests(async (ms) => { slept.push(ms); });
  });
  afterEach(() => _setHistorySleepForTests(null));

  it('waits out a full burst window and keeps going (first login used to stop here)', async () => {
    const acc = createZaloAccount('Nick test');
    const { ctx, api } = fakeCtx(acc.id, [{ ok: true }, { ok: false, reason: 'burst', retryAfterMs: 4_000 }, { ok: true }]);
    const ids = await syncGroupList(ctx);
    expect(ids).toEqual(['g1', 'g2']);
    expect(slept).toHaveLength(1);
    expect(slept[0]).toBeGreaterThanOrEqual(5_000);
    expect(api.getGroupInfo).toHaveBeenCalledTimes(1);
    const names = listZaloThreads({ accountId: acc.id, threadType: 'group', limit: 10 }).threads.map((t) => t.name).sort();
    expect(names).toEqual(['Nhóm Hai', 'Nhóm Một']);
  });

  it('the daily budget still stops reads: groups are listed without names, no waiting', async () => {
    const acc = createZaloAccount('Nick test');
    const { ctx, api } = fakeCtx(acc.id, [{ ok: true }, { ok: false, reason: 'daily' }]);
    const ids = await syncGroupList(ctx);
    expect(ids).toEqual(['g1', 'g2']);
    expect(slept).toEqual([]);
    expect(api.getGroupInfo).not.toHaveBeenCalled();
    expect(listZaloThreads({ accountId: acc.id, threadType: 'group', limit: 10 }).threads).toHaveLength(2);
  });
});
