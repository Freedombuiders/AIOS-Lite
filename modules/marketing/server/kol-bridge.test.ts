import { beforeEach, describe, expect, it } from 'vitest';
import { createKolBridge } from './kol-bridge.js';
import { getFbContent, setFbSetting, upsertFbPostMetrics, _initTestDatabase } from './store.js';
import { makePage } from './core/test-fixtures.js';

beforeEach(() => _initTestDatabase(':memory:'));

describe('marketing kolBridge (provides for KOL Studio)', () => {
  const draft = { pageId: 'p1', title: 'Đà Lạt', caption: 'Chiều nay', format: 'photo', pillar: 'Du lịch', media: [{ path: '/m/1.jpg', kind: 'image' }] };

  it('maps pages and settings; unknown pages are undefined', () => {
    makePage('p1');
    setFbSetting('enabled', '1');
    const b = createKolBridge();
    expect(b.getSetting('enabled')).toBe('1');
    expect(b.getPage('p1')).toMatchObject({ id: 'p1', enabled: true, status: 'ACTIVE', connectionId: 'ca_p1' });
    expect(b.getPage('nope')).toBeUndefined();
  });

  it('creates rows with origin kol: review without a time, scheduled only with the owner-approved time, never published', () => {
    makePage('p1');
    const b = createKolBridge();
    const review = b.createContent(draft);
    expect(getFbContent(review)).toMatchObject({ status: 'review', origin: 'kol', source: 'kol', scheduled_at: null, page_id: 'p1' });
    const sched = b.createContent({ ...draft, scheduledAt: 1_900_000_000 });
    expect(getFbContent(sched)).toMatchObject({ status: 'scheduled', scheduled_at: 1_900_000_000 });
    expect(JSON.parse(getFbContent(sched)!.media_json)).toEqual(draft.media);
    expect(b.getContent(sched)).toMatchObject({ id: sched, pageId: 'p1', status: 'scheduled', fbPostId: null });
  });

  it('refuses a Page that is missing or not enabled', () => {
    makePage('p1', { enabled: 0 });
    const b = createKolBridge();
    expect(() => b.createContent(draft)).toThrow(/chưa được bật/);
    expect(() => b.createContent({ ...draft, pageId: 'nope' })).toThrow(/chưa được bật/);
  });

  it('marks missed only from the expected status and withdraws unclaimed rows only', () => {
    makePage('p1');
    const b = createKolBridge();
    const id = b.createContent({ ...draft, scheduledAt: 1 });
    expect(b.markContent(id, { status: 'missed', lastError: 'Quá giờ' }, ['draft'])).toBe(false);
    expect(b.markContent(id, { status: 'missed', lastError: 'Quá giờ' }, ['scheduled'])).toBe(true);
    expect(getFbContent(id)).toMatchObject({ status: 'missed', last_error: 'Quá giờ' });

    const a = b.createContent({ ...draft, scheduledAt: 1 });
    expect(b.withdrawContent(a)).toBe(true);
    expect(getFbContent(a)).toBeUndefined();
    const c = b.createContent({ ...draft, scheduledAt: 1 });
    b.markContent(c, { status: 'missed', lastError: 'x' });
    expect(b.withdrawContent(c)).toBe(false);
    expect(getFbContent(c)).toBeDefined();
  });

  it('reads post metrics in camelCase', () => {
    upsertFbPostMetrics({
      post_id: '1_2', page_id: 'p1', milestone: '1h', captured_at: 10, reach: 300, impressions: 500, reactions: 30, comments: 3, shares: 2,
      clicks: null, video_views_3s: null, avg_watch_s: null, video_length_s: null, follows: null, saves: null, raw_json: '{}',
    });
    expect(createKolBridge().getPostMetrics('1_2')).toEqual([{ capturedAt: 10, videoViews3s: null, impressions: 500, reactions: 30, comments: 3, shares: 2, saves: null, reach: 300 }]);
  });
});
