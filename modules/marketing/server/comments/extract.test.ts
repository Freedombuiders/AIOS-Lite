import { describe, expect, it } from 'vitest';

import { extractId, extractList, parseComment, parsePost, toSec } from './extract.js';

describe('extractList', () => {
  it('finds arrays at several nesting levels', () => {
    expect(extractList({ data: [{ id: '1' }] })).toEqual([{ id: '1' }]);
    expect(extractList({ data: { data: [{ id: '2' }], paging: {} } })).toEqual([{ id: '2' }]);
    expect(extractList([{ id: '3' }])).toEqual([{ id: '3' }]);
    expect(extractList({ comments: { data: [{ id: '4' }] } })).toEqual([{ id: '4' }]);
  });

  it('returns [] for anything else', () => {
    expect(extractList(null)).toEqual([]);
    expect(extractList({ data: [] })).toEqual([]);
    expect(extractList({ other: 1 })).toEqual([]);
    expect(extractList('x')).toEqual([]);
  });
});

describe('extractId', () => {
  it('reads the id of a created object', () => {
    expect(extractId({ id: '123_456' })).toBe('123_456');
    expect(extractId({ data: { id: '789' } })).toBe('789');
    expect(extractId({ id: 42 })).toBe('42');
    expect(extractId({})).toBe('');
    expect(extractId(null)).toBe('');
  });
});

describe('toSec', () => {
  it('parses Facebook ISO timestamps with +0000', () => {
    expect(toSec('2026-10-07T03:00:00+0000')).toBe(Date.UTC(2026, 9, 7, 3, 0, 0) / 1000);
    expect(toSec('2026-10-07T10:00:00+0700')).toBe(Date.UTC(2026, 9, 7, 3, 0, 0) / 1000);
  });

  it('accepts unix seconds, milliseconds and numeric strings', () => {
    expect(toSec(1_800_000_000)).toBe(1_800_000_000);
    expect(toSec(1_800_000_000_000)).toBe(1_800_000_000);
    expect(toSec('1800000000')).toBe(1_800_000_000);
  });

  it('returns null for garbage', () => {
    expect(toSec('not a date')).toBeNull();
    expect(toSec(undefined)).toBeNull();
    expect(toSec('')).toBeNull();
  });
});

describe('parsePost / parseComment', () => {
  it('reads the comment count from the summary', () => {
    const p = parsePost({
      id: '1_2', message: 'Bài viết', created_time: '2026-10-07T03:00:00+0000', permalink_url: 'https://fb.com/x',
      comments: { data: [], summary: { total_count: 7 } },
    });
    expect(p).toMatchObject({ id: '1_2', message: 'Bài viết', permalink: 'https://fb.com/x', commentCount: 7 });
  });

  it('counts embedded comments when there is no summary, and zero when nothing is given', () => {
    expect(parsePost({ id: 'a', comments: { data: [{ id: 'x' }, { id: 'y' }] } })?.commentCount).toBe(2);
    expect(parsePost({ id: 'a' })?.commentCount).toBe(0);
    expect(parsePost({ message: 'no id' })).toBeNull();
  });

  it('reads author, parent and hidden flag of a comment', () => {
    const c = parseComment({
      id: '1_2_3', message: 'Giá?', created_time: '2026-10-07T03:00:00+0000',
      from: { id: '99', name: 'Lan' }, parent: { id: '1_2_1' }, is_hidden: true,
    }, '1_2');
    expect(c).toMatchObject({ id: '1_2_3', authorId: '99', authorName: 'Lan', parentId: '1_2_1', isHidden: true });
  });

  it('treats a parent equal to the post as top level and tolerates a missing author', () => {
    const c = parseComment({ id: 'c', parent: { id: 'P' }, message: 'x' }, 'P');
    expect(c).toMatchObject({ parentId: null, authorId: '', authorName: '', isHidden: false });
    expect(parseComment({ message: 'no id' }, 'P')).toBeNull();
  });
});
