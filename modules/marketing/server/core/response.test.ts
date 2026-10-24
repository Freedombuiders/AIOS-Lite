import { describe, expect, it } from 'vitest';

import { extractFollowers, extractPhotoIds, extractPictureUrl, extractPostId, findNextCursor, findRows } from './response.js';

describe('response helpers', () => {
  it('finds rows at every nesting level', () => {
    expect(findRows([{ id: '1' }])).toHaveLength(1);
    expect(findRows({ data: [{ id: '1' }, { id: '2' }] })).toHaveLength(2);
    expect(findRows({ data: { data: [{ id: '1' }] } })).toHaveLength(1);
    expect(findRows({ response_data: { data: [{ id: '1' }] } })).toHaveLength(1);
    expect(findRows({ nothing: true })).toEqual([]);
    expect(findRows(null)).toEqual([]);
  });

  it('reads the next cursor only when there is a next page', () => {
    expect(findNextCursor({ paging: { cursors: { after: 'abc' }, next: 'https://…' } })).toBe('abc');
    expect(findNextCursor({ paging: { cursors: { after: 'abc' } } })).toBeNull();
    expect(findNextCursor({ data: { paging: { cursors: { after: 'zzz' }, next: 'x' } } })).toBe('zzz');
    expect(findNextCursor({})).toBeNull();
  });

  it('prefers post_id over id', () => {
    expect(extractPostId({ id: '111', post_id: '999_111' })).toBe('999_111');
    expect(extractPostId({ data: { response_data: { id: '12345' } } })).toBe('12345');
    expect(extractPostId({ id: 42 })).toBe('42');
    expect(extractPostId({})).toBeNull();
  });

  it('collects photo ids from various shapes', () => {
    expect(extractPhotoIds({ photos: [{ id: '1' }, { id: '2' }] })).toEqual(['1', '2']);
    expect(extractPhotoIds({ data: { results: [{ photo_id: '10' }, { photo_id: '11' }] } })).toEqual(['10', '11']);
    // Real FACEBOOK_UPLOAD_PHOTOS_BATCH shape (captured 2026-10-07): batch responses with a JSON-string body.
    expect(extractPhotoIds({
      responses: [
        { code: 200, body: '{"id":"122152102407015890"}', headers: [{ name: 'Content-Length', value: '17' }] },
        { code: 200, body: '{"id":"122152102407015891"}', headers: [] },
      ],
    })).toEqual(['122152102407015890', '122152102407015891']);
    expect(extractPhotoIds({ ids: ['5', '6', '5'] })).toEqual(['5', '6']);
    expect(extractPhotoIds({ error: 'x' })).toEqual([]);
  });

  it('reads pictures and follower counts', () => {
    expect(extractPictureUrl({ picture: { data: { url: 'https://a/b.jpg' } } })).toBe('https://a/b.jpg');
    expect(extractPictureUrl({ picture: 'https://c/d.jpg' })).toBe('https://c/d.jpg');
    expect(extractPictureUrl({})).toBe('');
    expect(extractFollowers({ followers_count: 1200, fan_count: 1100 })).toBe(1200);
    expect(extractFollowers({ fan_count: '900' })).toBe(900);
    expect(extractFollowers({})).toBeNull();
  });
});
