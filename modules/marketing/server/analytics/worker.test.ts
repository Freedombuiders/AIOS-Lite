import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../_lib/composio.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../_lib/composio.js')>();
  return { ...actual, execute: vi.fn(), graphAsPage: vi.fn(async () => ({ status: 200, data: {} })), hasComposioKey: vi.fn(() => true) };
});
vi.mock('../settings.js', () => ({ isFbStudioEnabled: vi.fn(() => true) }));
vi.mock('../notify.js', () => ({ notifyOwner: vi.fn(async () => {}) }));

import {
  getFbAnalyticsPage, getFbSetting, getLatestFbInsight, listFbAnalyticsPosts, listFbPageDaily, listFbPostMetrics,
} from '../store.js';
import {
  ComposioConnectionExpiredError, ComposioRateLimitError, FbBudgetExceeded, execute, hasComposioKey,
} from '../../../_lib/composio.js';
import { isFbStudioEnabled } from '../settings.js';
import { notifyOwner } from '../notify.js';
import type { AgentRunner } from './agent-turn.js';
import { analyticsTick, runPageCycle, settingKeys, startRefresh } from './worker.js';
import { insertPage, insertStudioPost, setupAnalyticsDb, type AnalyticsTestDb } from './test-helpers.js';

const mockExecute = vi.mocked(execute);
const enabled = vi.mocked(isFbStudioEnabled);
const hasKey = vi.mocked(hasComposioKey);
const notify = vi.mocked(notifyOwner);

const vn = (s: string) => Date.parse(`${s.replace(' ', 'T')}:00+07:00`) / 1000;
const NOON = vn('2026-10-07 12:00');
const D = 86400;
const iso = (sec: number) => new Date(sec * 1000).toISOString().replace('.000Z', '+0000');

const ANALYST_JSON = JSON.stringify({
  summary: ['Case study thắng.', 'ER trung vị ổn.', 'Tối là khung tốt.'],
  actions: ['Thêm case study.', 'Bớt bài bán hàng.', 'Đăng tối.'],
  notes: [{ postId: '1_a', note: 'Hook tốt.' }],
});

/** Answers the classification prompt with an empty list and the Analyst prompt with a valid write-up. */
function makeRunner(): AgentRunner {
  return vi.fn(async (input) => ({
    text: input.usageKey.startsWith('fbstudio:classify') ? JSON.stringify({ items: [] }) : ANALYST_JSON,
    model: 'm',
    costUsd: 0,
  }));
}

function fbPost(id: string, createdAt: number) {
  return {
    id, message: `Caption ${id}`, created_time: iso(createdAt), permalink_url: `https://facebook.com/${id}`,
    reactions: { summary: { total_count: 20 } }, comments: { summary: { total_count: 4 } }, shares: { count: 2 },
  };
}

function fakeFacebook(posts: ReturnType<typeof fbPost>[]) {
  mockExecute.mockImplementation(async (slug) => {
    if (slug === 'FACEBOOK_GET_PAGE_POSTS') return { data: posts };
    if (slug === 'FACEBOOK_GET_POST_INSIGHTS') return { data: [{ name: 'post_total_media_view_unique', values: [{ value: 1000 }] }, { name: 'post_media_view', values: [{ value: 2000 }] }] };
    if (slug === 'FACEBOOK_GET_PAGE_INSIGHTS') {
      return { data: [{ name: 'page_total_media_view_unique', values: [{ value: 500, end_time: '2026-10-07T07:00:00+0000' }] }, { name: 'page_follows', values: [{ value: 1234, end_time: '2026-10-07T07:00:00+0000' }] }] };
    }
    throw new Error(`unexpected ${slug}`);
  });
}

// 60–64 hours old: past the 24h milestone window, before the 3d one, so only the sweep has work.
const threePosts = () => [fbPost('1_a', NOON - 60 * 3600), fbPost('1_b', NOON - 62 * 3600), fbPost('1_c', NOON - 64 * 3600)];

let t: AnalyticsTestDb;

beforeEach(() => {
  t = setupAnalyticsDb();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOON * 1000);
  mockExecute.mockReset();
  notify.mockClear();
  enabled.mockReturnValue(true);
  hasKey.mockReturnValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  t.cleanup();
});

const callsOf = (slug: string) => mockExecute.mock.calls.filter((c) => c[0] === slug);

describe('runPageCycle', () => {
  it('on first sight imports 90 days, snapshots, fills Page daily, then runs the Analyst the same day', async () => {
    insertPage(t.raw, { id: 'C1', pillars: ['Case study'] });
    fakeFacebook(threePosts());
    const runner = makeRunner();
    const report = await runPageCycle(getFbAnalyticsPage('C1')!, NOON, { runner, pauseMs: 0 });

    expect(report.sweep).toMatchObject({ fetched: 3, imported: 3, snapshots: 3 });
    expect(callsOf('FACEBOOK_GET_PAGE_POSTS')[0][1]).toMatchObject({ since: String(NOON - 90 * D) });
    expect(listFbAnalyticsPosts('C1', 0)).toHaveLength(3);
    expect(listFbPostMetrics('C1', 0)).toHaveLength(3);
    expect(listFbPageDaily('C1', '2026-10-01', '2026-10-31')).toHaveLength(1);
    expect(getFbAnalyticsPage('C1')?.followers).toBe(1234);

    expect(report.analyst).toBe('stored');
    expect(getLatestFbInsight('C1', 'channel')).toBeDefined();
    expect(getFbSetting(settingKeys.imported('C1'))).toBe(String(NOON));
    expect(getFbSetting(settingKeys.sweep('C1'))).toBe('2026-10-07');
    expect(getFbSetting(settingKeys.analyst('C1'))).toBe('2026-10-07');
  });

  it('does nothing more later the same day', async () => {
    insertPage(t.raw, { id: 'C2', pillars: ['Case study'] });
    fakeFacebook(threePosts());
    const runner = makeRunner();
    await runPageCycle(getFbAnalyticsPage('C2')!, NOON, { runner, pauseMs: 0 });
    mockExecute.mockClear();
    (runner as ReturnType<typeof vi.fn>).mockClear();
    const report = await runPageCycle(getFbAnalyticsPage('C2')!, NOON + 3600, { runner, pauseMs: 0 });
    expect(report).toMatchObject({ sweep: null, analyst: null });
    expect(mockExecute).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });

  it('sweeps from 02:00 local the next day and runs the Analyst only from 07:00', async () => {
    insertPage(t.raw, { id: 'C3', pillars: ['Case study'] });
    fakeFacebook(threePosts());
    const runner = makeRunner();
    await runPageCycle(getFbAnalyticsPage('C3')!, NOON, { runner, pauseMs: 0 });

    const before2 = vn('2026-10-08 01:30');
    expect((await runPageCycle(getFbAnalyticsPage('C3')!, before2, { runner, pauseMs: 0 })).sweep).toBeNull();

    const at2 = vn('2026-10-08 02:05');
    const sweepOnly = await runPageCycle(getFbAnalyticsPage('C3')!, at2, { runner, pauseMs: 0 });
    expect(sweepOnly.sweep).not.toBeNull();
    expect(sweepOnly.analyst).toBeNull(); // 02:05 is too early for the Analyst
    expect(callsOf('FACEBOOK_GET_PAGE_POSTS').at(-1)![1]).toMatchObject({ since: String(at2 - 56 * D) }); // later sweeps look back 56 days (28 + backfill of never-captured older posts)

    const at7 = vn('2026-10-08 07:10');
    const analystOnly = await runPageCycle(getFbAnalyticsPage('C3')!, at7, { runner, pauseMs: 0 });
    expect(analystOnly.sweep).toBeNull();
    expect(analystOnly.analyst).toBe('stored');
  });

  it('captures due milestones on every cycle', async () => {
    insertPage(t.raw, { id: 'C4' });
    insertStudioPost(t.raw, { pageId: 'C4', fbPostId: '9_h1', publishedAt: NOON - 90 * 60 });
    fakeFacebook([fbPost('9_h1', NOON - 90 * 60)]);
    const report = await runPageCycle(getFbAnalyticsPage('C4')!, NOON, { runner: makeRunner(), pauseMs: 0 });
    expect(report.milestones).toBe(1);
    expect(listFbPostMetrics('C4', 0).map((m) => m.milestone).sort()).toEqual(['1h', 'latest']);
  });

  it('retries a failed Analyst run after an hour and does not mark the day done', async () => {
    insertPage(t.raw, { id: 'C5', pillars: ['Case study'] });
    fakeFacebook(threePosts());
    const failing: AgentRunner = vi.fn(async (input) => (
      input.usageKey.startsWith('fbstudio:classify') ? { text: '{"items":[]}', model: 'm', costUsd: 0 } : { text: '', model: 'm', costUsd: 0, error: 'timeout' }
    ));
    const first = await runPageCycle(getFbAnalyticsPage('C5')!, NOON, { runner: failing, pauseMs: 0 });
    expect(first.analyst).toBe('error');
    expect(getFbSetting(settingKeys.analyst('C5'))).toBeUndefined();
    expect((await runPageCycle(getFbAnalyticsPage('C5')!, NOON + 600, { runner: failing, pauseMs: 0 })).analyst).toBeNull();
    const later = await runPageCycle(getFbAnalyticsPage('C5')!, NOON + 3700, { runner: makeRunner(), pauseMs: 0 });
    expect(later.analyst).toBe('stored');
  });

  it('marks the day done when the Analyst output is invalid, so it is not retried all day', async () => {
    insertPage(t.raw, { id: 'C6', pillars: ['Case study'] });
    fakeFacebook(threePosts());
    const junk: AgentRunner = async (input) => ({ text: input.usageKey.startsWith('fbstudio:classify') ? '{"items":[]}' : 'không phải JSON', model: 'm', costUsd: 0 });
    const report = await runPageCycle(getFbAnalyticsPage('C6')!, NOON, { runner: junk, pauseMs: 0 });
    expect(report.analyst).toBe('invalid');
    expect(getFbSetting(settingKeys.analyst('C6'))).toBe('2026-10-07');
    expect(getLatestFbInsight('C6', 'channel')).toBeUndefined();
  });
});

describe('analyticsTick', () => {
  it('does nothing while the studio is off or Composio has no key', async () => {
    insertPage(t.raw, { id: 'T1' });
    enabled.mockReturnValue(false);
    await analyticsTick({ runner: makeRunner(), pauseMs: 0 });
    enabled.mockReturnValue(true);
    hasKey.mockReturnValue(false);
    await analyticsTick({ runner: makeRunner(), pauseMs: 0 });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('only visits enabled Pages that have a connection and are not expired', async () => {
    insertPage(t.raw, { id: 'T_on' });
    insertPage(t.raw, { id: 'T_off', enabled: 0 });
    insertPage(t.raw, { id: 'T_exp', status: 'EXPIRED' });
    insertPage(t.raw, { id: 'T_noconn', connectionId: '' });
    fakeFacebook([]);
    await analyticsTick({ runner: makeRunner(), pauseMs: 0 });
    const pages = new Set(mockExecute.mock.calls.map((c) => (c[1] as { page_id?: string }).page_id));
    expect(pages).toEqual(new Set(['T_on']));
  });

  it('marks a Page EXPIRED and tells the owner once when its connection expired, then carries on', async () => {
    insertPage(t.raw, { id: 'T_a', name: 'Page A' });
    insertPage(t.raw, { id: 'T_b', name: 'Page B' });
    mockExecute.mockImplementation(async (slug, args) => {
      if ((args as { page_id?: string }).page_id === 'T_a') throw new ComposioConnectionExpiredError();
      if (slug === 'FACEBOOK_GET_PAGE_POSTS') return { data: [fbPost('2_a', NOON - D)] };
      if (slug === 'FACEBOOK_GET_POST_INSIGHTS') return { data: [] };
      return { data: [] };
    });
    await analyticsTick({ runner: makeRunner(), pauseMs: 0 });
    expect(getFbAnalyticsPage('T_a')?.status).toBe('EXPIRED');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain('Page A');
    expect(listFbAnalyticsPosts('T_b', 0)).toHaveLength(1);
    // Next tick skips the expired Page and does not notify again.
    mockExecute.mockClear();
    await analyticsTick({ runner: makeRunner(), pauseMs: 0 });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(mockExecute.mock.calls.some((c) => (c[1] as { page_id?: string }).page_id === 'T_a')).toBe(false);
  });

  it.each([
    ['rate limit', () => new ComposioRateLimitError()],
    ['budget', () => new FbBudgetExceeded(600, 600)],
  ])('backs off the whole tick on %s', async (_name, make) => {
    insertPage(t.raw, { id: 'T_1', name: 'A' });
    insertPage(t.raw, { id: 'T_2', name: 'B' });
    mockExecute.mockRejectedValue(make());
    await analyticsTick({ runner: makeRunner(), pauseMs: 0 });
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(getFbSetting(settingKeys.sweep('T_1'))).toBeUndefined(); // retried on the next tick
    expect(getFbAnalyticsPage('T_1')?.status).toBe('ACTIVE');
    expect(notify).not.toHaveBeenCalled();
  });

  it('survives an unexpected error and continues with the next Page', async () => {
    insertPage(t.raw, { id: 'T_x', name: 'A' });
    insertPage(t.raw, { id: 'T_y', name: 'B' });
    mockExecute.mockImplementation(async (slug, args) => {
      if ((args as { page_id?: string }).page_id === 'T_x') throw new Error('boom');
      return slug === 'FACEBOOK_GET_PAGE_POSTS' ? { data: [fbPost('3_y', NOON - D)] } : { data: [] };
    });
    await expect(analyticsTick({ runner: makeRunner(), pauseMs: 0 })).resolves.toBeUndefined();
    expect(listFbAnalyticsPosts('T_y', 0)).toHaveLength(1);
  });

  it('does not run two ticks at once', async () => {
    insertPage(t.raw, { id: 'T_slow' });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    mockExecute.mockImplementation(async (slug) => {
      await gate;
      return slug === 'FACEBOOK_GET_PAGE_POSTS' ? { data: [] } : { data: [] };
    });
    const first = analyticsTick({ runner: makeRunner(), pauseMs: 0 });
    await analyticsTick({ runner: makeRunner(), pauseMs: 0 });
    expect(mockExecute).toHaveBeenCalledTimes(1);
    release();
    await first;
  });
});

describe('startRefresh', () => {
  it('rejects unknown, disabled, expired and unconnected Pages and a missing key or switch', () => {
    expect(startRefresh(undefined)).toMatchObject({ ok: false, status: 404 });
    insertPage(t.raw, { id: 'R0', enabled: 0 });
    expect(startRefresh(getFbAnalyticsPage('R0')!)).toMatchObject({ ok: false, status: 409 });
    insertPage(t.raw, { id: 'R_exp', status: 'EXPIRED' });
    expect(startRefresh(getFbAnalyticsPage('R_exp')!)).toMatchObject({ ok: false, status: 409 });
    insertPage(t.raw, { id: 'R_ok' });
    enabled.mockReturnValue(false);
    expect(startRefresh(getFbAnalyticsPage('R_ok')!)).toMatchObject({ ok: false, status: 409 });
    enabled.mockReturnValue(true);
    hasKey.mockReturnValue(false);
    expect(startRefresh(getFbAnalyticsPage('R_ok')!)).toMatchObject({ ok: false, status: 503 });
  });

  it('runs import and a forced snapshot, then refuses another refresh for 10 minutes', async () => {
    insertPage(t.raw, { id: 'R1' });
    fakeFacebook(threePosts());
    const started = startRefresh(getFbAnalyticsPage('R1')!, { runner: makeRunner(), pauseMs: 0 });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await started.done;
    expect(listFbPostMetrics('R1', 0)).toHaveLength(3);

    const again = startRefresh(getFbAnalyticsPage('R1')!, { runner: makeRunner(), pauseMs: 0 });
    expect(again).toMatchObject({ ok: false, status: 429 });
    expect((again as { retryAfterSec: number }).retryAfterSec).toBe(600);

    vi.setSystemTime((NOON + 601) * 1000);
    mockExecute.mockClear();
    const third = startRefresh(getFbAnalyticsPage('R1')!, { runner: makeRunner(), pauseMs: 0 });
    expect(third.ok).toBe(true);
    if (third.ok) await third.done;
    expect(callsOf('FACEBOOK_GET_POST_INSIGHTS')).toHaveLength(3); // forced: re-snapshots despite today's snapshot
  });

  it('refuses a second refresh while one is running', async () => {
    insertPage(t.raw, { id: 'R2' });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    mockExecute.mockImplementation(async () => { await gate; return { data: [] }; });
    const started = startRefresh(getFbAnalyticsPage('R2')!, { runner: makeRunner(), pauseMs: 0 });
    expect(started.ok).toBe(true);
    expect(startRefresh(getFbAnalyticsPage('R2')!, { runner: makeRunner(), pauseMs: 0 })).toMatchObject({ ok: false, status: 409 });
    release();
    if (started.ok) await started.done;
  });

  it('marks the Page expired when the refresh finds the connection dead, without rejecting', async () => {
    insertPage(t.raw, { id: 'R3', name: 'Page R3' });
    mockExecute.mockRejectedValue(new ComposioConnectionExpiredError());
    const started = startRefresh(getFbAnalyticsPage('R3')!, { runner: makeRunner(), pauseMs: 0 });
    if (!started.ok) throw new Error('should start');
    await expect(started.done).resolves.toBeUndefined();
    expect(getFbAnalyticsPage('R3')?.status).toBe('EXPIRED');
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
