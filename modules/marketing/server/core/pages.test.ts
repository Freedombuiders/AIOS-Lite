import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  listConnections: vi.fn(),
  hasKey: vi.fn(() => true),
  notify: vi.fn(async () => {}),
}));

vi.mock('../../../_lib/composio.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../_lib/composio.js')>();
  return {
    ...actual,
    execute: mocks.execute,
    listConnections: mocks.listConnections,
    hasComposioKey: () => mocks.hasKey(),
  };
});
vi.mock('../notify.js', () => ({ notifyOwner: mocks.notify }));
vi.mock('../compat.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../compat.js')>()), listAgentIds: () => ['main', 'video-heygen'] }));

import { _initTestDatabase, getFbPage, insertFbContent, listFbPages, setFbSetting, upsertFbPageFromSync } from '../store.js';
import { ComposioConnectionExpiredError, FbBudgetExceeded } from '../../../_lib/composio.js';
import { listPages, syncPages, updatePage } from './pages.js';
import { makePage, seedContent } from './test-fixtures.js';
import { initTestDbWithRawAccess } from './test-db.js';

const conn = (id: string, entityId: string, status = 'ACTIVE') => ({ id, toolkit: 'facebook', status, alias: null, entityId, authConfigId: 'ac' });

/** Maps a connection id to the response of FACEBOOK_LIST_MANAGED_PAGES for it. */
function respond(byConnection: Record<string, unknown[] | Error | ((args: Record<string, unknown>) => unknown)>): void {
  mocks.execute.mockImplementation(async (slug: string, args: Record<string, unknown>, target: { connectionId: string }) => {
    if (slug === 'FACEBOOK_GET_PAGE_DETAILS') return { data: { followers_count: 4321 } };
    const r = byConnection[target.connectionId];
    if (r instanceof Error) throw r;
    if (typeof r === 'function') return r(args);
    return { data: { data: r ?? [] } };
  });
}

beforeEach(() => {
  _initTestDatabase(':memory:');
  mocks.execute.mockReset();
  mocks.listConnections.mockReset();
  mocks.notify.mockClear();
  mocks.hasKey.mockReturnValue(true);
});

describe('syncPages', () => {
  it('walks every ACTIVE connection, skips expired ones and starts new Pages disabled', async () => {
    mocks.listConnections.mockResolvedValue([
      conn('c1', 'e1'), conn('c2', 'e1'), conn('c3', 'e2'), conn('c4', 'e2'),
      conn('x1', 'e1', 'EXPIRED'), conn('x2', 'e2', 'EXPIRED'), conn('x3', 'e2', 'EXPIRED'),
    ]);
    respond({
      c1: [{ id: '100', name: 'Alpha', access_token: 'EAAB' + 'x'.repeat(40), picture: { data: { url: 'https://p/a.jpg' } }, followers_count: 10 }],
      c2: [{ id: '100', name: 'Alpha (dup)' }, { id: '200', name: 'Beta' }],
      c3: [{ id: '300', name: 'Gamma' }],
      c4: [],
    });
    const pages = await syncPages();
    expect(mocks.execute.mock.calls.filter((c) => c[0] === 'FACEBOOK_LIST_MANAGED_PAGES').map((c) => c[2].connectionId)).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(pages.map((p) => p.id).sort()).toEqual(['100', '200', '300']);
    expect(pages.every((p) => p.enabled === false)).toBe(true);
    const alpha = getFbPage('100')!;
    expect(alpha.connection_id).toBe('c1'); // first ACTIVE connection wins
    expect(alpha.entity_id).toBe('e1');
    expect(alpha.name).toBe('Alpha');
    expect(alpha.picture_url).toBe('https://p/a.jpg');
    expect(alpha.followers).toBe(10);
    expect(getFbPage('300')?.entity_id).toBe('e2');
    // Page access tokens are never stored
    expect(JSON.stringify(listFbPages())).not.toMatch(/EAAB/);
  });

  it('never asks for access tokens', async () => {
    mocks.listConnections.mockResolvedValue([conn('c1', 'e1')]);
    respond({ c1: [] });
    await syncPages();
    const args = mocks.execute.mock.calls[0][1] as { fields: string };
    expect(args.fields).not.toMatch(/access_token/);
  });

  it('keeps the stored connection while it still lists the Page', async () => {
    upsertFbPageFromSync({ id: '100', name: 'Alpha', connection_id: 'c2', entity_id: 'e1', picture_url: '', followers: null });
    mocks.listConnections.mockResolvedValue([conn('c1', 'e1'), conn('c2', 'e1')]);
    respond({ c1: [{ id: '100', name: 'Alpha' }], c2: [{ id: '100', name: 'Alpha' }] });
    await syncPages();
    expect(getFbPage('100')?.connection_id).toBe('c2');
  });

  it('preserves the owner configuration on re-sync', async () => {
    mocks.listConnections.mockResolvedValue([conn('c1', 'e1')]);
    respond({ c1: [{ id: '100', name: 'Alpha' }] });
    await syncPages();
    updatePage('100', { enabled: true, brandVoice: 'Thân thiện', maxPostsPerDay: 5 });
    respond({ c1: [{ id: '100', name: 'Alpha 2' }] });
    await syncPages();
    const p = getFbPage('100')!;
    expect(p).toMatchObject({ name: 'Alpha 2', enabled: 1, brand_voice: 'Thân thiện', max_posts_per_day: 5, status: 'ACTIVE' });
  });

  it('follows pagination', async () => {
    mocks.listConnections.mockResolvedValue([conn('c1', 'e1')]);
    respond({
      c1: (args) => args.after
        ? { data: [{ id: '2', name: 'Two' }] }
        : { data: [{ id: '1', name: 'One' }], paging: { cursors: { after: 'CUR' }, next: 'https://next' } },
    });
    const pages = await syncPages();
    expect(pages.map((p) => p.id).sort()).toEqual(['1', '2']);
    expect(mocks.execute).toHaveBeenCalledTimes(2);
    expect(mocks.execute.mock.calls[1][1]).toMatchObject({ after: 'CUR' });
  });

  it('expires the Pages of a connection that turns out to be expired and notifies', async () => {
    makePage('100', { connection_id: 'c1' });
    makePage('200', { connection_id: 'c2' });
    mocks.listConnections.mockResolvedValue([conn('c1', 'e1'), conn('c2', 'e1')]);
    respond({ c1: [{ id: '100', name: 'Alpha' }], c2: new ComposioConnectionExpiredError() });
    await syncPages();
    expect(getFbPage('100')?.status).toBe('ACTIVE');
    expect(getFbPage('200')?.status).toBe('EXPIRED');
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    // syncing again does not notify a second time
    await syncPages();
    expect(mocks.notify).toHaveBeenCalledTimes(1);
  });

  it('expires stored Pages whose connection is no longer ACTIVE and unseen', async () => {
    makePage('100', { connection_id: 'gone' });
    mocks.listConnections.mockResolvedValue([conn('c1', 'e1'), conn('gone', 'e1', 'EXPIRED')]);
    respond({ c1: [{ id: '300', name: 'Gamma' }] });
    await syncPages();
    expect(getFbPage('100')?.status).toBe('EXPIRED');
    expect(mocks.notify).toHaveBeenCalledTimes(1); // enabled Page: owner is told
  });

  it('survives one failing connection and still syncs the others', async () => {
    mocks.listConnections.mockResolvedValue([conn('c1', 'e1'), conn('c2', 'e1')]);
    respond({ c1: new Error('(#100) boom'), c2: [{ id: '200', name: 'Beta' }] });
    const pages = await syncPages();
    expect(pages.map((p) => p.id)).toEqual(['200']);
  });

  it('retries the page listing with plain fields when the field list is rejected', async () => {
    mocks.listConnections.mockResolvedValue([conn('c1', 'e1')]);
    mocks.execute.mockImplementation(async (_slug: string, args: { fields: string }) => {
      if (args.fields.includes('{')) throw new Error('(#100) Invalid fields');
      return { data: { data: [{ id: '1', name: 'One' }] } };
    });
    expect((await syncPages()).map((p) => p.id)).toEqual(['1']);
  });

  it('stops with 503 when the API budget runs out', async () => {
    mocks.listConnections.mockResolvedValue([conn('c1', 'e1')]);
    respond({ c1: new FbBudgetExceeded(600, 600) });
    await expect(syncPages()).rejects.toMatchObject({ status: 503 });
  });

  it('fills followers of enabled Pages the listing did not report', async () => {
    makePage('100', { connection_id: 'c1' });
    mocks.listConnections.mockResolvedValue([conn('c1', 'e1')]);
    respond({ c1: [{ id: '100', name: 'Alpha' }] });
    await syncPages();
    expect(getFbPage('100')?.followers).toBe(4321);
    expect(mocks.execute.mock.calls.some((c) => c[0] === 'FACEBOOK_GET_PAGE_DETAILS')).toBe(true);
  });

  it('answers 503 without a key and 502 when connections cannot be listed', async () => {
    mocks.hasKey.mockReturnValue(false);
    await expect(syncPages()).rejects.toMatchObject({ status: 503 });
    mocks.hasKey.mockReturnValue(true);
    mocks.listConnections.mockRejectedValue(new Error('network'));
    await expect(syncPages()).rejects.toMatchObject({ status: 502 });
  });
});

describe('listPages stats', () => {
  it('counts the week, ER and AI replies from the other tables', async () => {
    const now = Math.floor(Date.now() / 1000);
    const raw = initTestDbWithRawAccess();
    // (re-create the fixtures in the file-backed database)
    makePage('p1');
    insertFbContent({ page_id: 'p1', status: 'published', published_at: now - 60, fb_post_id: 'a_1' });
    insertFbContent({ page_id: 'p1', status: 'scheduled', scheduled_at: now + 3600 });
    seedContent({ status: 'published', published_at: now - 3600, fb_post_id: 'a_2' });
    const _testExec = (sql: string): void => { raw.exec(sql); };
    _testExec(`INSERT INTO fb_post_metrics (post_id, page_id, milestone, captured_at, reach, reactions, comments, shares) VALUES ('a_1','p1','24h',${now},1000,40,5,5)`);
    _testExec(`INSERT INTO fb_post_metrics (post_id, page_id, milestone, captured_at, reach, reactions, comments, shares) VALUES ('a_2','p1','24h',${now},500,10,0,0)`);
    _testExec(`INSERT INTO fb_comments (id, page_id, post_id, created_time, fetched_at, status, sent_at) VALUES ('c1','p1','a_1',${now},${now},'sent',${now - 10})`);
    _testExec(`INSERT INTO fb_comments (id, page_id, post_id, created_time, fetched_at, status, sent_at) VALUES ('c2','p1','a_1',${now},${now},'sent',${now - 2 * 86400})`);
    const [page] = listPages();
    expect(page.stats.aiReplies24h).toBe(1);
    expect(page.stats.scheduledThisWeek).toBeGreaterThanOrEqual(0);
    // ER: a_1 = 50/1000 = 5 %, a_2 = 10/500 = 2 % → median 3.5
    expect(page.stats.er28d).toBeCloseTo(3.5, 5);
    expect(page.stats.postsThisWeek).toBeGreaterThanOrEqual(0);
    raw.close();
  });
});

describe('updatePage', () => {
  beforeEach(() => makePage('p1'));

  it('updates and normalises fields', () => {
    const p = updatePage('p1', {
      enabled: false, role: 'Nhận lead', timezone: 'Asia/Bangkok', approvalRequired: false, maxPostsPerDay: 5,
      minGapMinutes: 60, windowStart: '8:00', windowEnd: '21:30', graceMinutes: 15, brandVoice: 'Vui',
      pillars: [{ name: 'Giáo dục', targetPct: 40 }], writerAgent: 'video-heygen',
    });
    expect(p).toMatchObject({
      enabled: false, role: 'Nhận lead', timezone: 'Asia/Bangkok', approvalRequired: false, maxPostsPerDay: 5,
      minGapMinutes: 60, windowStart: '08:00', windowEnd: '21:30', graceMinutes: 15, brandVoice: 'Vui', writerAgent: 'video-heygen',
    });
    expect(p.pillars).toEqual([{ name: 'Giáo dục', targetPct: 40 }]);
  });

  it('rejects invalid values with 400 and unknown Pages with 404', () => {
    const bad: Array<Record<string, unknown>> = [
      { timezone: 'Mars/Base' }, { windowStart: '25:00' }, { maxPostsPerDay: -1 }, { maxPostsPerDay: 1.5 },
      { minGapMinutes: 99999 }, { graceMinutes: 'x' }, { pillars: [{ name: '', targetPct: 10 }] },
      { pillars: [{ name: 'a', targetPct: 101 }] }, { writerAgent: 'ghost' }, { videoAgent: '' },
    ];
    for (const patch of bad) expect(() => updatePage('p1', patch as never), JSON.stringify(patch)).toThrowError(expect.objectContaining({ status: 400 }));
    expect(() => updatePage('nope', {})).toThrowError(expect.objectContaining({ status: 404 }));
    expect(getFbPage('p1')?.max_posts_per_day).toBe(3); // nothing was applied
  });

  it('accepts main and the studio switch setting stays untouched', () => {
    expect(updatePage('p1', { writerAgent: 'main' }).writerAgent).toBe('main');
    setFbSetting('enabled', '1');
  });
});
