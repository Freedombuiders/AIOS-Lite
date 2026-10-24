import { _initTestDatabase } from './test-db.js';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getFbAdAccount,
  getFbAdsRecommendation,
  listFbAdsDaily,
  updateFbAdAccountSettings,
  upsertFbAdAccount,
  upsertFbAdsDaily,
  type FbAdsDailyInput,
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
  ComposioConnectionExpiredError,
  getComposio,
  hasComposioKey,
  listConnections,
  type ComposioConnection,
} from '../../_lib/composio.js';
import { _resetAdsConnectionCache } from './accounts.js';
import { runEvaluation } from './evaluate.js';
import { addDays, dayIn } from './metrics.js';
import { registerAdsRoutes } from './routes.js';
import { _resetCreativeProbe, _resetSnapshotGuards } from './snapshot.js';

const conn = (over: Partial<ComposioConnection> = {}): ComposioConnection => ({
  id: 'ca_1', toolkit: 'metaads', status: 'ACTIVE', alias: null, entityId: 'e1', authConfigId: 'ac_1', ...over,
});

const list = vi.mocked(listConnections);
const run = vi.mocked(metaRead);

function app(): Hono {
  const a = new Hono();
  registerAdsRoutes(a);
  return a;
}

const call = (a: Hono, method: string, url: string, body?: unknown) =>
  a.request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function json<T = Record<string, any>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function seedAccount(status = 'ACTIVE'): void {
  upsertFbAdAccount({ id: 'act_111', name: 'Rocket AI', currency: 'VND', timezone: 'Asia/Ho_Chi_Minh', connectionId: 'ca_1', entityId: 'e1', status });
  updateFbAdAccountSettings('act_111', { enabled: true, targetCpa: 120_000 });
}

/** Seven days of one campaign that spent and got nothing: R1 fires. */
function seedBadCampaign(): void {
  const today = dayIn('Asia/Ho_Chi_Minh', Math.floor(Date.now() / 1000));
  const rows: FbAdsDailyInput[] = [-6, -5, -4, -3, -2, -1, 0].map((o) => ({
    account_id: 'act_111', level: 'campaign', object_id: 'c9', parent_id: '', day: addDays(today, o), name: 'Test · Video dài',
    status: 'ACTIVE', daily_budget: null, spend: 400_000, impressions: 10000, reach: null, frequency: null, clicks: 100, link_clicks: 100,
    lp_views: 0, results: 0, result_value: 0, purchases: 0, video_3s: 0, thruplays: 0, creative_json: '{}', learning: 'SUCCESS',
    raw_json: JSON.stringify({ r: { lead: o === 0 ? 3 : 0, message: 0, purchase: 2, registration: 0 } }), captured_at: 0,
  }));
  upsertFbAdsDaily(rows);
  runEvaluation('act_111');
}

beforeEach(() => {
  _initTestDatabase(':memory:');
  _resetAdsConnectionCache();
  _resetSnapshotGuards();
  _resetCreativeProbe();
  list.mockReset();
  run.mockReset();
  vi.mocked(hasComposioKey).mockReturnValue(true);
  run.mockImplementation(makeFakeMeta().execute as never);
});

describe('GET /accounts', () => {
  it('reports the connection and the accounts, EXPIRED included', async () => {
    seedAccount();
    list.mockResolvedValue([conn({ status: 'EXPIRED' })]);
    const res = await call(app(), 'GET', '/accounts');
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.connection).toBe('EXPIRED');
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0]).toMatchObject({ id: 'act_111', status: 'EXPIRED', enabled: true, resultType: 'lead', targetCpa: 120_000, syncedAt: null });
  });

  it('is MISSING with no key', async () => {
    vi.mocked(hasComposioKey).mockReturnValue(false);
    const body = await json(await call(app(), 'GET', '/accounts'));
    expect(body).toEqual({ accounts: [], connection: 'MISSING' });
  });
});

describe('POST /accounts/sync', () => {
  it('imports the accounts of an ACTIVE connection', async () => {
    list.mockResolvedValue([conn()]);
    const res = await call(app(), 'POST', '/accounts/sync');
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.connection).toBe('ACTIVE');
    expect(body.accounts[0]).toMatchObject({ id: 'act_111', name: 'Rocket AI', enabled: false });
  });

  it('answers 200 with the EXPIRED state, not an error, and calls no tool', async () => {
    list.mockResolvedValue([conn({ status: 'EXPIRED' })]);
    const res = await call(app(), 'POST', '/accounts/sync');
    expect(res.status).toBe(200);
    expect((await json(res)).connection).toBe('EXPIRED');
    expect(run).not.toHaveBeenCalled();
  });

  it('is 503 without a Composio key', async () => {
    vi.mocked(hasComposioKey).mockReturnValue(false);
    const res = await call(app(), 'POST', '/accounts/sync');
    expect(res.status).toBe(503);
    expect((await json(res)).code).toBe('composio_not_configured');
  });
});

describe('PATCH /accounts/:id', () => {
  beforeEach(() => {
    list.mockResolvedValue([conn({ status: 'EXPIRED' })]);
    seedAccount('EXPIRED');
  });

  it('updates the owner\'s settings', async () => {
    const res = await call(app(), 'PATCH', '/accounts/act_111', { targetCpa: 99_000, monthlyBudget: 150_000_000, enabled: false });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ id: 'act_111', targetCpa: 99_000, monthlyBudget: 150_000_000, enabled: false });
    expect(getFbAdAccount('act_111')).toMatchObject({ target_cpa: 99_000, enabled: 0 });
  });

  it('accepts the id without the act_ prefix and clears a target with null', async () => {
    const res = await call(app(), 'PATCH', '/accounts/111', { targetCpa: null });
    expect(res.status).toBe(200);
    expect(getFbAdAccount('act_111')!.target_cpa).toBeNull();
  });

  it('rejects bad values and unknown fields', async () => {
    for (const body of [{ targetCpa: -1 }, { resultType: 'clicks' }, { enabled: 'yes' }, { name: 'x' }, 'nope']) {
      expect((await call(app(), 'PATCH', '/accounts/act_111', body)).status).toBe(400);
    }
    expect((await call(app(), 'PATCH', '/accounts/act_404', { enabled: true })).status).toBe(404);
  });

  it('re-derives stored results and the queue when the result type changes', async () => {
    seedBadCampaign();
    // Result type lead: one lead today, spend 2.8 tr: not R1. With purchases (2 per day) it is a different story.
    const before = listFbAdsDaily('act_111', '2000-01-01').filter((r) => r.object_id === 'c9');
    expect(before.reduce((s, r) => s + r.results, 0)).toBe(0); // seeded rows carry results 0; raw_json is the source of truth
    const res = await call(app(), 'PATCH', '/accounts/act_111', { resultType: 'purchase' });
    expect(res.status).toBe(200);
    const after = listFbAdsDaily('act_111', '2000-01-01').filter((r) => r.object_id === 'c9');
    expect(after.reduce((s, r) => s + r.results, 0)).toBe(14);
  });

  it('re-runs the rules at once when the target changes (no API call)', async () => {
    seedBadCampaign();
    const dash = async () => json(await call(app(), 'GET', '/dashboard?account=act_111'));
    expect((await dash()).queue.map((r: any) => r.action)).toEqual(['off_now']);
    await call(app(), 'PATCH', '/accounts/act_111', { targetCpa: 5_000_000 });
    expect((await dash()).queue).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('GET /dashboard', () => {
  it('is a clear 409 with the connection state when there is no account yet', async () => {
    list.mockResolvedValue([conn({ status: 'EXPIRED' })]);
    const res = await call(app(), 'GET', '/dashboard');
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ code: 'no_account', connection: 'EXPIRED' });
  });

  it('is 503 when Composio is not configured and nothing is stored', async () => {
    vi.mocked(hasComposioKey).mockReturnValue(false);
    const res = await call(app(), 'GET', '/dashboard');
    expect(res.status).toBe(503);
    expect((await json(res)).code).toBe('composio_not_configured');
  });

  it('asks to enable an account when none is enabled', async () => {
    list.mockResolvedValue([conn()]);
    upsertFbAdAccount({ id: 'act_111', name: 'Rocket AI', currency: 'VND', timezone: '', connectionId: 'ca_1', entityId: 'e1', status: 'ACTIVE' });
    const res = await call(app(), 'GET', '/dashboard');
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe('no_enabled_account');
  });

  it('still serves stored data with connection EXPIRED, so the screen can show a reconnect button', async () => {
    list.mockResolvedValue([conn({ status: 'EXPIRED' })]);
    seedAccount('EXPIRED');
    seedBadCampaign();
    const res = await call(app(), 'GET', '/dashboard');
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.connection).toBe('EXPIRED');
    expect(body.account.status).toBe('EXPIRED');
    expect(body.kpis.spend).toBe(0); // account-level rows were never fetched
    expect(body.queue.map((r: any) => r.action)).toEqual(['off_now']);
  });

  it('picks the requested account and clamps the window', async () => {
    list.mockResolvedValue([conn()]);
    seedAccount();
    expect((await json(await call(app(), 'GET', '/dashboard?account=111&days=99'))).days).toBe(28);
    expect((await json(await call(app(), 'GET', '/dashboard?days=abc'))).days).toBe(7);
    expect((await call(app(), 'GET', '/dashboard?account=act_404')).status).toBe(404);
  });
});

describe('POST /recommendations/:id', () => {
  it('marks done, snoozes for 24 hours and refuses expired ones', async () => {
    list.mockResolvedValue([conn()]);
    seedAccount();
    seedBadCampaign();
    const id = (await json(await call(app(), 'GET', '/dashboard'))).queue[0].id as number;

    const before = Math.floor(Date.now() / 1000);
    expect(await json(await call(app(), 'POST', `/recommendations/${id}`, { state: 'snoozed' }))).toEqual({ ok: true });
    const snoozed = getFbAdsRecommendation(id)!;
    expect(snoozed.state).toBe('snoozed');
    expect(snoozed.snoozed_until!).toBeGreaterThanOrEqual(before + 86400);

    expect((await call(app(), 'POST', `/recommendations/${id}`, { state: 'done' })).status).toBe(200);
    expect(getFbAdsRecommendation(id)).toMatchObject({ state: 'done', snoozed_until: null });

    expect((await call(app(), 'POST', `/recommendations/${id}`, { state: 'open' })).status).toBe(400);
    expect((await call(app(), 'POST', '/recommendations/9999', { state: 'done' })).status).toBe(404);

  });

  it('answers 409 for an expired recommendation', async () => {
    list.mockResolvedValue([conn()]);
    seedAccount();
    seedBadCampaign();
    const id = (await json(await call(app(), 'GET', '/dashboard'))).queue[0].id as number;
    await call(app(), 'PATCH', '/accounts/act_111', { targetCpa: 50_000_000 });
    expect(getFbAdsRecommendation(id)!.state).toBe('expired');
    expect((await call(app(), 'POST', `/recommendations/${id}`, { state: 'done' })).status).toBe(409);
  });
});

describe('POST /refresh', () => {
  it('pulls fresh data for the account', async () => {
    list.mockResolvedValue([conn()]);
    seedAccount();
    const res = await call(app(), 'POST', '/refresh', { accountId: 'act_111' });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true });
    expect(getFbAdAccount('act_111')!.synced_at).not.toBeNull();
    const body = await json(await call(app(), 'GET', '/dashboard'));
    expect(body.lastSnapshotAt).not.toBeNull();
    expect(body.tree.length).toBeGreaterThan(0);
    expect(body.kpis.results).toBeGreaterThan(0);
  });

  it('answers 429 to a second refresh within two minutes', async () => {
    list.mockResolvedValue([conn()]);
    seedAccount();
    await call(app(), 'POST', '/refresh', { accountId: 'act_111' });
    const res = await call(app(), 'POST', '/refresh', { accountId: 'act_111' });
    expect(res.status).toBe(429);
    expect((await json(res)).code).toBe('too_soon');
  });

  it('answers 409 for an account that is already known to be expired, without calling Meta', async () => {
    seedAccount('EXPIRED');
    const res = await call(app(), 'POST', '/refresh', { accountId: 'act_111' });
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ code: 'connection_expired', connection: 'EXPIRED' });
    expect(run).not.toHaveBeenCalled();
  });

  it('turns an expiry discovered during the call into 409 and marks the account', async () => {
    seedAccount();
    run.mockReset();
    run.mockRejectedValue(new ComposioConnectionExpiredError('expired'));
    const res = await call(app(), 'POST', '/refresh', { accountId: 'act_111' });
    expect(res.status).toBe(409);
    expect(getFbAdAccount('act_111')!.status).toBe('EXPIRED');
  });

  it('validates the body and the account', async () => {
    expect((await call(app(), 'POST', '/refresh', {})).status).toBe(400);
    expect((await call(app(), 'POST', '/refresh', { accountId: 'act_404' })).status).toBe(404);
  });
});

describe('POST /reconnect', () => {
  const initiate = vi.fn();
  beforeEach(() => {
    initiate.mockReset();
    initiate.mockResolvedValue({ redirectUrl: 'https://connect.composio.dev/link/xyz' });
    vi.mocked(getComposio).mockReturnValue({ connectedAccounts: { link: initiate }, authConfigs: { list: vi.fn().mockResolvedValue({ items: [] }) } } as never);
  });

  it('returns the redirect URL of the expired connection', async () => {
    list.mockResolvedValue([conn({ status: 'EXPIRED', entityId: 'entity-1', authConfigId: 'ac_meta' })]);
    const res = await call(app(), 'POST', '/reconnect');
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ redirectUrl: 'https://connect.composio.dev/link/xyz' });
    expect(initiate).toHaveBeenCalledWith('entity-1', 'ac_meta', { allowMultiple: true });
  });

  it('is 404 when there is no connection at all and 503 without a key', async () => {
    list.mockResolvedValue([]);
    const missing = await call(app(), 'POST', '/reconnect');
    expect(missing.status).toBe(404);
    expect((await json(missing)).code).toBe('no_connection');
    vi.mocked(hasComposioKey).mockReturnValue(false);
    expect((await call(app(), 'POST', '/reconnect')).status).toBe(503);
  });

  it('is 502 when Composio fails, without echoing its message', async () => {
    list.mockResolvedValue([conn({ status: 'EXPIRED' })]);
    initiate.mockRejectedValue(new Error('secret-ish upstream detail'));
    const res = await call(app(), 'POST', '/reconnect');
    expect(res.status).toBe(502);
    expect(JSON.stringify(await json(res))).not.toContain('secret-ish');
  });
});

describe('POST /accounts/enable-all', () => {
  it('turns tracking on for the listed accounts and stores the guessed result type', async () => {
    upsertFbAdAccount({ id: 'act_201', name: 'A', currency: 'VND', timezone: '', connectionId: 'ca_1', entityId: 'e1', status: 'EXPIRED' });
    upsertFbAdAccount({ id: 'act_202', name: 'B', currency: 'VND', timezone: '', connectionId: 'ca_1', entityId: 'e1', status: 'EXPIRED' });
    const res = await call(app(), 'POST', '/accounts/enable-all', { enabled: true, ids: ['201'], resultTypes: { act_201: 'registration' } });
    expect(res.status).toBe(200);
    expect(getFbAdAccount('act_201')).toMatchObject({ enabled: 1, result_type: 'registration' });
    expect(getFbAdAccount('act_202')).toMatchObject({ enabled: 0, result_type: 'lead' });
    expect((await call(app(), 'POST', '/accounts/enable-all', { enabled: 'yes' })).status).toBe(400);
  });
});

describe('GET /campaigns', () => {
  it('lists the campaigns of tracked accounts with today\'s spend and the rule label', async () => {
    seedAccount();
    seedBadCampaign();
    list.mockResolvedValue([conn()]);
    const res = await call(app(), 'GET', '/campaigns?days=7');
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.days).toBe(7);
    expect(body.staleAccounts).toEqual(['Rocket AI']);
    expect(body.campaigns).toHaveLength(1);
    expect(body.campaigns[0]).toMatchObject({ accountId: 'act_111', accountName: 'Rocket AI', id: 'c9', spend: 2_800_000, spendToday: 400_000, results: 0, targetCpa: 120_000 });
    expect(body.campaigns[0].recommendation?.action).toBeTruthy();
  });
});

describe('dashboard extras', () => {
  it('reports the window, today and month spend, and no target hint once a target is set', async () => {
    seedAccount();
    seedBadCampaign();
    list.mockResolvedValue([conn()]);
    const body = await json(await call(app(), 'GET', '/dashboard?account=act_111&days=7'));
    const today = dayIn('Asia/Ho_Chi_Minh', Math.floor(Date.now() / 1000));
    expect(body.range).toEqual({ from: addDays(today, -6), to: today });
    expect(body.suggestedTargetCpa).toBeNull();
    expect(typeof body.kpis.spendToday).toBe('number');
    expect(typeof body.kpis.spendMonth).toBe('number');
    expect(body.tree[0]).toHaveProperty('spendToday');
  });
});
