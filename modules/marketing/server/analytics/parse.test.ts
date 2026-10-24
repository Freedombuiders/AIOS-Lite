import { describe, expect, it } from 'vitest';

import {
  deriveFormat, pageInsightsToDaily, parseInsightSeries, parsePagePosts, parsePost, parsePostInsights, parseVideoId,
  parseVideoInsights, titleFromMessage, toEpoch, toNumber, unwrapRecords,
} from './parse.js';

describe('unwrapRecords', () => {
  it('finds the array whatever the envelope', () => {
    const rows = [{ id: '1' }];
    expect(unwrapRecords(rows)).toBe(rows);
    expect(unwrapRecords({ data: rows })).toBe(rows);
    expect(unwrapRecords({ data: { data: rows, paging: {} } })).toBe(rows);
    expect(unwrapRecords({ response_data: { data: rows } })).toBe(rows);
  });

  it('returns an empty list for junk', () => {
    expect(unwrapRecords(null)).toEqual([]);
    expect(unwrapRecords('x')).toEqual([]);
    expect(unwrapRecords({ data: { foo: 1 } })).toEqual([]);
  });
});

describe('toNumber / toEpoch', () => {
  it('coerces numbers and numeric strings only', () => {
    expect(toNumber(5)).toBe(5);
    expect(toNumber('7.5')).toBe(7.5);
    expect(toNumber('')).toBeNull();
    expect(toNumber('abc')).toBeNull();
    expect(toNumber({ a: 1 })).toBeNull();
    expect(toNumber(Number.NaN)).toBeNull();
  });

  it('parses Graph timestamps with a compact UTC offset', () => {
    expect(toEpoch('2026-10-05T12:30:00+0000')).toBe(Date.parse('2026-10-05T12:30:00Z') / 1000);
    expect(toEpoch('2026-10-05T19:30:00+0700')).toBe(Date.parse('2026-10-05T12:30:00Z') / 1000);
    expect(toEpoch('2026-10-05T12:30:00Z')).toBe(Date.parse('2026-10-05T12:30:00Z') / 1000);
    expect(toEpoch(1760000000)).toBe(1760000000);
    expect(toEpoch(1760000000000)).toBe(1760000000);
    expect(toEpoch('nope')).toBeNull();
    expect(toEpoch(undefined)).toBeNull();
  });
});

describe('deriveFormat', () => {
  const base = { permalink: '', statusType: '', attachmentType: '', subattachments: 0, hasAttachment: false };
  it('detects reels from the permalink', () => {
    expect(deriveFormat({ ...base, permalink: 'https://www.facebook.com/reel/123', attachmentType: 'video_inline', hasAttachment: true })).toBe('reel');
    expect(deriveFormat({ ...base, permalink: 'https://www.facebook.com/page/reels/123' })).toBe('reel');
  });

  it('detects the other formats from the attachment', () => {
    expect(deriveFormat({ ...base, attachmentType: 'video_inline', hasAttachment: true })).toBe('video');
    expect(deriveFormat({ ...base, statusType: 'added_video' })).toBe('video');
    expect(deriveFormat({ ...base, permalink: 'https://facebook.com/p/videos/9' })).toBe('video');
    expect(deriveFormat({ ...base, attachmentType: 'photo', hasAttachment: true })).toBe('photo');
    expect(deriveFormat({ ...base, attachmentType: 'photo', subattachments: 5, hasAttachment: true })).toBe('album');
    expect(deriveFormat({ ...base, attachmentType: 'album', hasAttachment: true })).toBe('album');
    expect(deriveFormat({ ...base, attachmentType: 'share', hasAttachment: true })).toBe('link');
    expect(deriveFormat({ ...base, statusType: 'shared_story' })).toBe('link');
    expect(deriveFormat(base)).toBe('text');
    expect(deriveFormat({ ...base, statusType: 'mobile_status_update' })).toBe('text');
  });
});

describe('parsePost', () => {
  it('reads counts from summaries and treats a missing shares key as zero', () => {
    const p = parsePost({
      id: '1_2', message: 'Xin chào', created_time: '2026-10-05T12:30:00+0000', permalink_url: 'https://facebook.com/1/posts/2',
      reactions: { summary: { total_count: 12 } }, comments: { summary: { total_count: 3 } },
    });
    expect(p).toMatchObject({ id: '1_2', reactions: 12, comments: 3, shares: 0, format: 'text', message: 'Xin chào' });
    expect(p?.createdAt).toBe(Date.parse('2026-10-05T12:30:00Z') / 1000);
  });

  it('reads shares.count and the attachment type', () => {
    const p = parsePost({
      id: '1_3', shares: { count: 4 }, reactions: { summary: { total_count: 1 } },
      attachments: { data: [{ type: 'photo', subattachments: { data: [{}, {}, {}] } }] },
    });
    expect(p).toMatchObject({ shares: 4, format: 'album' });
  });

  it('keeps null for counts that were not returned and skips rows without an id', () => {
    expect(parsePost({ id: '9' })).toMatchObject({ reactions: null, comments: null, shares: 0 });
    expect(parsePost({ message: 'no id' })).toBeNull();
    expect(parsePost('x')).toBeNull();
  });

  it('parses a whole response and drops bad rows', () => {
    const out = parsePagePosts({ data: { data: [{ id: 'a' }, { nope: 1 }, { id: 'b' }] } });
    expect(out.map((p) => p.id)).toEqual(['a', 'b']);
  });
});

describe('titleFromMessage', () => {
  it('uses the first non-empty line, truncated to 80 characters', () => {
    expect(titleFromMessage('\n  Dòng một  \nDòng hai')).toBe('Dòng một');
    expect(titleFromMessage('')).toBe('(Không có nội dung)');
    const long = titleFromMessage('x'.repeat(200));
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.endsWith('...')).toBe(true);
  });
});

describe('insight parsing', () => {
  const postInsights = {
    data: [
      { name: 'post_media_view', period: 'lifetime', values: [{ value: 5400 }] },
      { name: 'post_total_media_view_unique', period: 'lifetime', values: [{ value: '3100' }] },
      { name: 'post_reactions_by_type_total', values: [{ value: { like: 3 } }] },
    ],
  };

  it('reads post metrics by name and drops breakdown objects', () => {
    expect(parsePostInsights(postInsights)).toEqual({ post_media_view: 5400, post_total_media_view_unique: 3100, post_reactions_by_type_total: null });
    expect(parsePostInsights({ data: [] })).toEqual({});
    expect(parsePostInsights(null)).toEqual({});
  });

  it('keeps every point of a series in order', () => {
    const s = parseInsightSeries({ data: [{ name: 'm', values: [{ value: 1, end_time: '2026-10-08T07:00:00+0000' }, { value: 2, end_time: '2026-10-09T07:00:00+0000' }] }] });
    expect(s.get('m')?.map((p) => p.value)).toEqual([1, 2]);
  });

  it('folds page insights into one row per day, mapping metric names to columns', () => {
    const end = (d: number) => `2026-10-${String(d).padStart(2, '0')}T07:00:00+0000`;
    const days = pageInsightsToDaily({
      data: [
        { name: 'page_total_media_view_unique', values: [{ value: 100, end_time: end(8) }, { value: 120, end_time: end(9) }] },
        { name: 'page_media_view', values: [{ value: 300, end_time: end(8) }] },
        { name: 'page_daily_follows_unique', values: [{ value: 5, end_time: end(8) }] },
        { name: 'page_daily_unfollows_unique', values: [{ value: 1, end_time: end(8) }] },
        { name: 'page_follows', values: [{ value: 5000, end_time: end(8) }] },
        { name: 'page_post_engagements', values: [{ value: 40, end_time: end(8) }] },
        { name: 'page_total_actions', values: [{ value: 7, end_time: end(8) }] },
        { name: 'page_something_new', values: [{ value: 1, end_time: end(8) }] },
      ],
    });
    expect([...days.keys()].sort()).toEqual(['2026-10-07', '2026-10-08']);
    expect(days.get('2026-10-07')).toEqual({
      reach: 100, impressions: 300, new_follows: 5, unfollows: 1, followers_total: 5000, engaged_users: 40, link_clicks: 7,
    });
    expect(days.get('2026-10-08')).toEqual({ reach: 120 });
  });

  it('understands the pre-rename metric names and ignores points without end_time', () => {
    const days = pageInsightsToDaily({
      data: [
        { name: 'page_impressions_unique', values: [{ value: 9, end_time: '2026-10-08T07:00:00+0000' }, { value: 99 }] },
        { name: 'page_fans', values: [{ value: 77, end_time: '2026-10-08T07:00:00+0000' }] },
      ],
    });
    expect(days.get('2026-10-07')).toEqual({ reach: 9, followers_total: 77 });
    expect(days.size).toBe(1);
  });
});

describe('duplicate metric entries (real GET_POST_INSIGHTS shape)', () => {
  it('prefers the lifetime entry over a zero entry of another period', () => {
    const real = { data: [
      { name: 'post_total_media_view_unique', period: 'lifetime', values: [{ value: 348 }] },
      { name: 'post_total_media_view_unique', period: 'day', values: [{ value: 0 }] },
    ] };
    expect(parsePostInsights(real)).toEqual({ post_total_media_view_unique: 348 });
    expect(parsePostInsights({ data: [...real.data].reverse() })).toEqual({ post_total_media_view_unique: 348 });
  });

  it('takes the largest value when no entry is lifetime, and ignores a null lifetime', () => {
    expect(parsePostInsights({ data: [
      { name: 'm', period: 'day', values: [{ value: 0 }] }, { name: 'm', period: 'week', values: [{ value: 9 }] },
    ] })).toEqual({ m: 9 });
    expect(parsePostInsights({ data: [
      { name: 'm', period: 'lifetime', values: [{ value: { a: 1 } }] }, { name: 'm', period: 'day', values: [{ value: 4 }] },
    ] })).toEqual({ m: 4 });
  });
});

describe('video details', () => {
  const post = (a: unknown) => ({ id: '1_2', attachments: { data: [a] }, permalink_url: 'https://facebook.com/reel/9' });

  it('reads the video id from a video attachment target', () => {
    expect(parseVideoId(post({ media_type: 'video', type: 'video_inline', target: { id: '555' } }))).toBe('555');
    expect(parseVideoId(post({ media_type: 'video', target: { id: 556 } }))).toBe('556');
    expect(parseVideoId(post({ type: 'video_autoplay', target: { id: '557' } }))).toBe('557');
  });

  it('returns null for photos, missing targets and junk', () => {
    expect(parseVideoId(post({ media_type: 'photo', type: 'photo', target: { id: '1' } }))).toBeNull();
    expect(parseVideoId(post({ media_type: 'video' }))).toBeNull();
    expect(parseVideoId({ id: 'x' })).toBeNull();
    expect(parseVideoId(null)).toBeNull();
  });

  it('reads plays, average watch time (ms → s) and followers from video_insights', () => {
    const real = { data: [
      { name: 'blue_reels_play_count', values: [{ value: 363 }] },
      { name: 'fb_reels_total_plays', values: [{ value: 393 }] },
      { name: 'fb_reels_replay_count', values: [{ value: 30 }] },
      { name: 'post_video_avg_time_watched', values: [{ value: 5999 }] },
      { name: 'post_video_retention_graph', values: [{ value: { 0: 1, 1: 0.5 } }] },
      { name: 'post_video_followers', values: [{ value: 4 }] },
    ] };
    expect(parseVideoInsights(real)).toEqual({ plays: 363, avgWatchS: 5.999, follows: 4 });
  });

  it('falls back to total plays and keeps nulls for what is missing', () => {
    expect(parseVideoInsights({ data: [{ name: 'fb_reels_total_plays', values: [{ value: 12 }] }] })).toEqual({ plays: 12, avgWatchS: null, follows: null });
    expect(parseVideoInsights({ data: [] })).toEqual({ plays: null, avgWatchS: null, follows: null });
  });
});
