import { _initTestDatabase } from './test-db.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getFbAdAccount,
  getFbSetting,
  listFbAdsDaily,
  listFbAdsPlacements,
  listFbAdsRecommendations,
  updateFbAdAccountSettings,
  upsertFbAdAccount,
} from './store.js';
import { metaRead } from './graph-tools.js';
import { makeFakeMeta, READ_ONLY_SLUGS } from './test-fixtures.js';

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
} from '../../_lib/composio.js';
import { notifyOwner } from './context.js';
import { addDays } from './metrics.js';
import {
  _resetCreativeProbe,
  _resetSnapshotGuards,
  AdsRefreshBusyError,
  AdsRefreshTooSoonError,
  runAccountSnapshot,
  snapshotAccount,
  TOOLS,
} from './snapshot.js';

const NOW = Date.UTC(2026, 9, 7, 5, 0) / 1000; // 2026-10-07 12:00 Ho Chi Minh
const TODAY = '2026-10-07';
const ACCOUNT = 'act_111';

const run = vi.mocked(metaRead);

function setup(opts: Parameters<typeof makeFakeMeta>[0] = {}) {
  const fake = makeFakeMeta(opts);
  run.mockReset();
  run.mockImplementation(fake.execute as never);
  return fake;
}

function seedAccount(): void {
  _initTestDatabase(':memory:');
  upsertFbAdAccount({ id: ACCOUNT, name: 'Rocket AI', currency: 'VND', timezone: 'Asia/Ho_Chi_Minh', connectionId: 'ca_1', entityId: 'e1', status: 'ACTIVE' });
  updateFbAdAccountSettings(ACCOUNT, { enabled: true, resultType: 'lead', targetCpa: 120_000, monthlyBudget: 200_000_000 });
}

beforeEach(() => {
  seedAccount();
  _resetCreativeProbe();
  _resetSnapshotGuards();
  vi.mocked(notifyOwner).mockClear();
});

describe('snapshotAccount', () => {
  it('stores every level with names, status, budget, learning, creative and results', async () => {
    setup();
    const result = await snapshotAccount(getFbAdAccount(ACCOUNT)!, NOW);
    expect(result.calls).toBe(11);

    const rows = listFbAdsDaily(ACCOUNT, addDays(TODAY, -30));
    const count = (level: string) => rows.filter((r) => r.level === level).length;
    // 28 days of history at every level (the UI's longest window); the account level also covers the month so far.
    expect(count('account')).toBe(28);
    expect(count('campaign')).toBe(56);
    expect(count('adset')).toBe(84);
    expect(count('ad')).toBe(84);

    const a1 = rows.filter((r) => r.level === 'adset' && r.object_id === 'a1');
    expect(a1[0]).toMatchObject({
      name: 'Chủ shop online 25–45', parent_id: 'c1', status: 'ACTIVE', daily_budget: 1_800_000, learning: 'SUCCESS',
      spend: 1_700_000, impressions: 10000, reach: 8000, frequency: 1.25, link_clicks: 150, clicks: 200, results: 20, lp_views: 160,
    });
    expect(JSON.parse(a1[0]!.raw_json)).toEqual({ r: { lead: 20, message: 0, purchase: 0, registration: 0 } });

    const d1 = rows.find((r) => r.level === 'ad' && r.object_id === 'd1')!;
    expect(d1).toMatchObject({ parent_id: 'a1', video_3s: 3800, thruplays: 800 });
    expect(JSON.parse(d1.creative_json)).toMatchObject({ format: 'video', storyId: 'P1_300', videoId: 'v_d1' });
    expect(JSON.parse(rows.find((r) => r.object_id === 'd2')!.creative_json)).toMatchObject({ format: 'photo' });

    const acct = rows.find((r) => r.level === 'account')!;
    expect(acct).toMatchObject({ object_id: ACCOUNT, name: 'Rocket AI', spend: 6_500_000, results: 59, result_value: 3_000_000 });
  });

  it('keeps the 7-day frequency on each object\'s latest day only', async () => {
    setup();
    await snapshotAccount(getFbAdAccount(ACCOUNT)!, NOW);
    const rows = listFbAdsDaily(ACCOUNT, addDays(TODAY, -30)).filter((r) => r.level === 'adset' && r.object_id === 'a2');
    const withFreq = rows.filter((r) => r.freq_window !== null);
    expect(withFreq).toHaveLength(1);
    expect(withFreq[0]).toMatchObject({ day: TODAY, freq_window: 3.4 });
  });

  it('stores placements for the last 7 days', async () => {
    setup();
    await snapshotAccount(getFbAdAccount(ACCOUNT)!, NOW);
    const p = listFbAdsPlacements(ACCOUNT, addDays(TODAY, -30));
    expect(p).toHaveLength(21);
    expect(p.find((x) => x.day === TODAY && x.placement === 'facebook|facebook_reels')).toMatchObject({ spend: 4_100_000, results: 45 });
  });

  it('marks the account synced and writes the recommendations', async () => {
    setup();
    await snapshotAccount(getFbAdAccount(ACCOUNT)!, NOW);
    expect(getFbAdAccount(ACCOUNT)).toMatchObject({ synced_at: NOW, status: 'ACTIVE' });
    const recs = listFbAdsRecommendations(ACCOUNT, ['open']);
    expect(recs.map((r) => [r.action, r.object_id]).sort()).toEqual([['clone', 'd1'], ['off_now', 'c2'], ['up', 'a1']]);
  });

  it('is idempotent: a second run refreshes rows and does not duplicate recommendations', async () => {
    setup();
    await snapshotAccount(getFbAdAccount(ACCOUNT)!, NOW);
    await snapshotAccount(getFbAdAccount(ACCOUNT)!, NOW + 3600);
    expect(listFbAdsDaily(ACCOUNT, addDays(TODAY, -30)).filter((r) => r.level === 'ad')).toHaveLength(84);
    expect(listFbAdsRecommendations(ACCOUNT)).toHaveLength(3);
  });

  it('asks Meta for what it needs: account tz range, month to date, daily increments, breakdowns', async () => {
    const fake = setup();
    await snapshotAccount(getFbAdAccount(ACCOUNT)!, NOW);
    const insights = fake.calls.filter((c) => c.slug === TOOLS.insights);
    expect(insights).toHaveLength(8);
    const account = insights[0]!.args;
    expect(account).toMatchObject({ object_id: ACCOUNT, level: 'account', time_increment: 1, time_range: { since: '2026-09-10', until: TODAY } });
    expect(insights.map((c) => c.args.level)).toEqual(['account', 'campaign', 'adset', 'ad', 'campaign', 'adset', 'ad', 'account']);
    expect(insights[1]!.args.fields).toEqual(expect.arrayContaining(['spend', 'actions', 'inline_link_clicks', 'video_thruplay_watched_actions', 'campaign_id', 'campaign_name']));
    expect(insights[4]!.args).toMatchObject({ time_increment: 'all_days', time_range: { since: '2026-10-01', until: TODAY } });
    expect(insights[7]!.args).toMatchObject({ breakdowns: ['publisher_platform', 'platform_position'], time_increment: 1 });
    // Every call targets the account's own connection and entity.
    expect(fake.calls.every((c) => JSON.stringify(c.target) === JSON.stringify({ area: 'ads', connectionId: 'ca_1', entityId: 'e1' }))).toBe(true);
  });

  it('reaches back to the 1st of the month for account totals late in the month', async () => {
    const fake = setup();
    const late = Date.UTC(2026, 9, 30, 5, 0) / 1000;
    await snapshotAccount(getFbAdAccount(ACCOUNT)!, late);
    const account = fake.calls.find((c) => c.slug === TOOLS.insights && c.args.level === 'account')!;
    expect(account.args.time_range).toEqual({ since: '2026-10-01', until: '2026-10-30' });
    const campaign = fake.calls.find((c) => c.slug === TOOLS.insights && c.args.level === 'campaign')!;
    expect(campaign.args.time_range).toEqual({ since: '2026-10-03', until: '2026-10-30' });
  });

  it('never calls a tool that is not a read tool', async () => {
    const fake = setup();
    await snapshotAccount(getFbAdAccount(ACCOUNT)!, NOW);
    expect(fake.calls.every((c) => READ_ONLY_SLUGS.has(c.slug))).toBe(true);
    expect(fake.calls.some((c) => /CREATE|UPDATE|DELETE|PAUSE|SET_/.test(c.slug))).toBe(false);
  });

  it('follows paging cursors', async () => {
    const fake = makeFakeMeta();
    let adPages = 0;
    run.mockReset();
    run.mockImplementation((async (slug: string, args: Record<string, any>, target: unknown) => {
      if (slug === TOOLS.insights && args.level === 'ad' && args.time_increment === 1) {
        adPages++;
        const full = (await fake.execute(slug, { ...args, after: undefined }, target)) as { data: { data: unknown[] } };
        const half = Math.ceil(full.data.data.length / 2);
        return args.after
          ? { data: { data: full.data.data.slice(half), paging: { cursors: { after: 'END' } } } }
          : { data: { data: full.data.data.slice(0, half), paging: { cursors: { after: 'PAGE2' }, next: 'https://graph/next' } } };
      }
      return fake.execute(slug, args, target);
    }) as never);
    await snapshotAccount(getFbAdAccount(ACCOUNT)!, NOW);
    expect(adPages).toBe(2);
    expect(listFbAdsDaily(ACCOUNT, addDays(TODAY, -30)).filter((r) => r.level === 'ad')).toHaveLength(84);
    const second = run.mock.calls.filter(([slug, args]) => slug === TOOLS.insights && (args as any).level === 'ad' && (args as any).after);
    expect(second).toHaveLength(1);
    expect((second[0]![1] as any).after).toBe('PAGE2');
  });

  it('falls back to a plain ad list once Meta refuses the nested creative field', async () => {
    const fake = setup({ rejectNestedCreative: true });
    await snapshotAccount(getFbAdAccount(ACCOUNT)!, NOW);
    const adCalls = fake.calls.filter((c) => c.slug === TOOLS.ads);
    expect(adCalls).toHaveLength(2);
    expect(String(adCalls[1]!.args.fields)).not.toContain('creative{');
    const d1 = listFbAdsDaily(ACCOUNT, addDays(TODAY, -30)).find((r) => r.object_id === 'd1')!;
    expect(d1.creative_json).toBe('{}');
    expect(d1.name).toBe('Reel "3 prompt viết caption"');

    // The probe is remembered: the next run goes straight to the plain list.
    fake.calls.length = 0;
    await snapshotAccount(getFbAdAccount(ACCOUNT)!, NOW + 3600);
    expect(fake.calls.filter((c) => c.slug === TOOLS.ads)).toHaveLength(1);
  });

  it('keeps going when an entity list fails for a non-fatal reason', async () => {
    setup({ failSlug: { [TOOLS.adsets]: new Error('(#200) permission') } });
    await snapshotAccount(getFbAdAccount(ACCOUNT)!, NOW);
    const a1 = listFbAdsDaily(ACCOUNT, addDays(TODAY, -30)).find((r) => r.object_id === 'a1')!;
    // Name still comes from the insights row; status and budget are unknown.
    expect(a1).toMatchObject({ name: 'Chủ shop online 25–45', status: '', daily_budget: null });
    expect(getFbAdAccount(ACCOUNT)!.synced_at).toBe(NOW);
  });

  it('survives a failing 7-day frequency call', async () => {
    const fake = makeFakeMeta();
    run.mockReset();
    run.mockImplementation((async (slug: string, args: Record<string, any>, target: unknown) => {
      if (slug === TOOLS.insights && args.time_increment === 'all_days') throw new Error('boom');
      return fake.execute(slug, args, target);
    }) as never);
    await snapshotAccount(getFbAdAccount(ACCOUNT)!, NOW);
    expect(getFbAdAccount(ACCOUNT)!.synced_at).toBe(NOW);
  });

  it('fails loudly when the insights shape drifts instead of storing zeros', async () => {
    run.mockReset();
    run.mockImplementation((async (slug: string) => {
      if (slug === TOOLS.insights) return { data: { data: [{ spend: '1', actions: 'not-an-array' }] } };
      return { data: { data: [] } };
    }) as never);
    await expect(snapshotAccount(getFbAdAccount(ACCOUNT)!, NOW)).rejects.toThrow(/unexpected insights shape/);
    expect(getFbAdAccount(ACCOUNT)!.synced_at).toBeNull();
  });

  it('maps results to the account result type', async () => {
    setup();
    updateFbAdAccountSettings(ACCOUNT, { resultType: 'message' });
    await snapshotAccount(getFbAdAccount(ACCOUNT)!, NOW);
    const a1 = listFbAdsDaily(ACCOUNT, addDays(TODAY, -30)).find((r) => r.object_id === 'a1')!;
    expect(a1.results).toBe(0); // the fake only reports leads
    expect(JSON.parse(a1.raw_json).r.lead).toBe(20);
  });
});

describe('runAccountSnapshot', () => {
  it('marks the account EXPIRED, notifies once and rethrows', async () => {
    run.mockReset();
    run.mockRejectedValue(new ComposioConnectionExpiredError('token expired'));
    await expect(runAccountSnapshot(ACCOUNT, { nowSec: NOW })).rejects.toBeInstanceOf(ComposioConnectionExpiredError);
    expect(getFbAdAccount(ACCOUNT)!.status).toBe('EXPIRED');
    expect(notifyOwner).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notifyOwner).mock.calls[0]![0]).toContain('Rocket AI');
    expect(getFbSetting(`ads_expired_notified:${ACCOUNT}`)).toBe('1');

    _resetSnapshotGuards();
    await expect(runAccountSnapshot(ACCOUNT, { nowSec: NOW + 3600 })).rejects.toBeInstanceOf(ComposioConnectionExpiredError);
    expect(notifyOwner).toHaveBeenCalledTimes(1);
  });

  it('allows a new notification after the account worked again', async () => {
    run.mockReset();
    run.mockRejectedValue(new ComposioConnectionExpiredError());
    await expect(runAccountSnapshot(ACCOUNT, { nowSec: NOW })).rejects.toThrow();
    setup();
    _resetSnapshotGuards();
    await runAccountSnapshot(ACCOUNT, { nowSec: NOW + 7200 });
    expect(getFbAdAccount(ACCOUNT)!.status).toBe('ACTIVE');
    expect(getFbSetting(`ads_expired_notified:${ACCOUNT}`)).toBe('0');
    run.mockReset();
    run.mockRejectedValue(new ComposioConnectionExpiredError());
    _resetSnapshotGuards();
    await expect(runAccountSnapshot(ACCOUNT, { nowSec: NOW + 14400 })).rejects.toThrow();
    expect(notifyOwner).toHaveBeenCalledTimes(2);
  });

  it('does not mark EXPIRED for a rate limit or a bad key', async () => {
    run.mockReset();
    run.mockRejectedValueOnce(new ComposioRateLimitError());
    await expect(runAccountSnapshot(ACCOUNT, { nowSec: NOW })).rejects.toBeInstanceOf(ComposioRateLimitError);
    _resetSnapshotGuards();
    run.mockRejectedValueOnce(new ComposioAuthError());
    await expect(runAccountSnapshot(ACCOUNT, { nowSec: NOW })).rejects.toBeInstanceOf(ComposioAuthError);
    expect(getFbAdAccount(ACCOUNT)!.status).toBe('ACTIVE');
    expect(notifyOwner).not.toHaveBeenCalled();
  });

  it('refuses a second run of the same account while one is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    run.mockReset();
    run.mockImplementation((async () => { await gate; return { data: { data: [] } }; }) as never);
    const first = runAccountSnapshot(ACCOUNT, { nowSec: NOW });
    await expect(runAccountSnapshot(ACCOUNT, { nowSec: NOW })).rejects.toBeInstanceOf(AdsRefreshBusyError);
    release();
    // The empty answers also mean the first run ends normally.
    await first.catch(() => undefined);
  });

  it('rate-limits manual refreshes to one every two minutes', async () => {
    setup();
    await runAccountSnapshot(ACCOUNT, { manual: true, nowSec: NOW });
    await expect(runAccountSnapshot(ACCOUNT, { manual: true, nowSec: NOW + 60 })).rejects.toBeInstanceOf(AdsRefreshTooSoonError);
    await expect(runAccountSnapshot(ACCOUNT, { manual: true, nowSec: NOW + 121 })).resolves.toBeDefined();
    // The worker's own runs are not held back by the manual limit.
    await expect(runAccountSnapshot(ACCOUNT, { nowSec: NOW + 122 })).resolves.toBeDefined();
  });

  it('rejects an unknown account', async () => {
    await expect(runAccountSnapshot('act_nope')).rejects.toThrow(/unknown ad account/);
  });
});
