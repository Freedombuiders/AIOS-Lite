import manifest from '../module.json' with { type: 'json' };
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { ModuleContext } from '../../../src/modules/sdk.js';
import { getDb } from '../../../src/modules/compat/db.js';
import { _initTestDatabase } from './test-db.js';
import { organicPosts } from './organic.js';
import { analyzeAccount } from './analyst.js';
import { withContext } from './context.js';
import { createAdsModule } from './index.js';
import { upsertFbAdAccount } from './store.js';
import { graphProxy } from '../../_lib/composio.js';
import { metaRead, READ_SLUGS } from './graph-tools.js';

vi.mock('../../_lib/composio.js', () => ({
  configureComposio: vi.fn(), graphProxy: vi.fn(async () => ({ status: 200, data: { data: [] } })),
  hasComposioKey: vi.fn(() => false), listConnections: vi.fn(async () => []),
  ComposioAuthError: class extends Error {}, ComposioConnectionExpiredError: class extends Error {},
  ComposioRateLimitError: class extends Error {}, FbBudgetExceeded: class extends Error {},
}));

function fakeContext(marketing?: unknown): ModuleContext {
  const values = new Map<string, unknown>();
  return {
    id: 'ads', db: getDb(), dataDir: '/tmp/ads-test',
    settings: { get: (key: string, fallback: unknown) => values.get(key) ?? fallback, set: (key: string, value: unknown) => { if (!(key in manifest.settings)) throw new Error('Cài đặt chưa khai báo'); values.set(key, value); } },
    modules: { get: vi.fn(() => marketing) },
    access: { can: vi.fn(() => true) },
    agents: { runLean: vi.fn(async () => ({ ok: true, output: JSON.stringify({ action: 'review', text: 'Chi phí cao.', reason: 'CPA vượt mục tiêu.', score: 45 }), taskId: 1, runId: 1 })) },
    outbound: { sanitize: (s: string) => s },
    events: { emit: vi.fn() },
    connections: { secret: vi.fn() },
    schedule: { every: vi.fn(() => vi.fn()) },
    log: { info: vi.fn() },
  } as unknown as ModuleContext;
}
beforeEach(() => { _initTestDatabase(); vi.clearAllMocks(); });

function seed() {
  upsertFbAdAccount({ id: 'act_1', name: 'Tài khoản mẫu', currency: 'VND', timezone: '', connectionId: 'c1', entityId: 'u1', status: 'ACTIVE' });
}

describe('ads SDK integration', () => {
  it('does not access marketing data when the module is absent', async () => {
    const ctx = fakeContext();
    expect(await organicPosts(ctx)).toEqual({ available: false, rows: [] });
    expect(ctx.modules.get).toHaveBeenCalledWith('marketing');
  });
  it('reads organic data exclusively through optional provides', async () => {
    const rows = [{ post_id: 'p1', title: 'Bài nổi bật' }];
    const topPosts = vi.fn(async () => rows);
    expect(await organicPosts(fakeContext({ topPosts }))).toEqual({ available: true, rows });
    expect(topPosts).toHaveBeenCalledWith(undefined, 30);
  });
  it('evaluates prepared metrics through runLean and validates JSON', async () => {
    seed(); const ctx = fakeContext();
    const review = await withContext(ctx, () => analyzeAccount(ctx, 'act_1'));
    expect(review.score).toBe(45);
    expect(ctx.agents.runLean).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'ads-analyst', moduleContext: expect.stringContaining('kpis') }));
    expect(JSON.parse(ctx.settings.get<string>('latest_reviews'))['act_1']).toMatchObject({ score: 45, taskId: 1 });
    vi.mocked(ctx.agents.runLean).mockResolvedValueOnce({ ok: true, output: '{"action":"pause","score":999}', taskId: 2, runId: 2 });
    await expect(withContext(ctx, () => analyzeAccount(ctx, 'act_1'))).rejects.toThrow('hợp đồng');
    expect(JSON.parse(ctx.settings.get<string>('latest_reviews'))['act_1']).toMatchObject({ taskId: 1 });
  });
  it('denies analysis without scope before starting an agent', async () => {
    seed(); const ctx = fakeContext(); vi.mocked(ctx.access.can).mockReturnValue(false);
    await expect(withContext(ctx, () => analyzeAccount(ctx, 'act_1'))).rejects.toThrow('quyền');
    expect(ctx.agents.runLean).not.toHaveBeenCalled();
  });
  it('schedules hourly snapshots, is idempotent on start, and stops on Remove', () => {
    const ctx = fakeContext(); const stop = vi.fn(); vi.mocked(ctx.schedule.every).mockReturnValue(stop);
    const mod = createAdsModule(); mod.start!(ctx); mod.start!(ctx);
    expect(ctx.schedule.every).toHaveBeenCalledWith('snapshot', 3600000, expect.any(Function));
    expect(stop).toHaveBeenCalledTimes(1); mod.stop!(ctx); expect(stop).toHaveBeenCalledTimes(2);
  });
  it('mounts local routes with isolated module contexts and hides organic without marketing', async () => {
    seed(); const ctx = fakeContext(); const app = new Hono(); createAdsModule().routes!(app, ctx);
    const response = await app.request('/dashboard?account=act_1');
    expect(response.status).toBe(200); expect((await response.json()).organicAvailable).toBe(false);
    expect((await app.request('/evaluate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId: 'act_1' }) })).status).toBe(200);
  });
  it('all allowed Meta operations use GET; write tools fail before reaching Composio', async () => {
    const target = { area: 'ads', connectionId: 'c1', entityId: 'u1' } as const;
    for (const slug of READ_SLUGS) await metaRead(slug, { ad_account_id: '1', object_id: '1' }, target);
    expect(vi.mocked(graphProxy).mock.calls).toHaveLength(5);
    for (const [request] of vi.mocked(graphProxy).mock.calls) expect(request).toMatchObject({ method: 'GET' });
    for (const slug of ['METAADS_CREATE_CAMPAIGN', 'METAADS_UPDATE_AD', 'METAADS_DELETE_AD', 'METAADS_PAUSE_CAMPAIGN']) {
      await expect(metaRead(slug, {}, target)).rejects.toThrow('read-only');
    }
    expect(vi.mocked(graphProxy).mock.calls).toHaveLength(5);
  });
});
