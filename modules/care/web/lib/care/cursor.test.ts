import { describe, expect, it } from 'vitest';
import {
  appendPage, compareConversations, emptyList, emptyWindow, mergeHead, mergeLatest, mergeNewer, mergeOlder, replaceConversation,
  snapshotIsAhead, windowFromPage,
} from './cursor';
import type { CareMessagePageDto } from './dto';
import { conv, msg } from './fixtures.test-util';

const c = (id: string, at: number, rev = 1) => conv({ id, lastActivityMs: at, revision: rev });

describe('conversation list merging', () => {
  it('orders like the server: activity desc then id desc', () => {
    const sorted = [c('a', 5), c('b', 9), c('c', 9)].sort(compareConversations).map((x) => x.id);
    expect(sorted).toEqual(['c', 'b', 'a']);
  });

  it('append dedupes rows that moved between pages and takes the new cursor', () => {
    const s = { items: [c('a', 9), c('b', 8)], nextCursor: 'cur1' };
    const next = appendPage(s, { items: [c('b', 8), c('c', 7)], nextCursor: 'cur2' });
    expect(next.items.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(next.nextCursor).toBe('cur2');
  });

  it('a refreshed head keeps the older pages the reader already scrolled to', () => {
    const s = { items: [c('a', 9), c('b', 8), c('c', 7), c('d', 6)], nextCursor: 'deep' };
    // 'x' arrived, 'a' got a revision bump; 'd' and 'c' are beyond the head page
    const next = mergeHead(s, { items: [c('x', 10), c('a', 9, 2), c('b', 8)], nextCursor: 'head' });
    expect(next.items.map((x) => x.id)).toEqual(['x', 'a', 'b', 'c', 'd']);
    expect(next.items[1].revision).toBe(2);
    expect(next.nextCursor).toBe('deep');
  });

  it('a row that left the filter (newer than the head tail but missing from it) is dropped', () => {
    const s = { items: [c('gone', 9), c('b', 8)], nextCursor: null };
    const next = mergeHead(s, { items: [c('b', 8), c('z', 7)], nextCursor: null });
    expect(next.items.map((x) => x.id)).toEqual(['b', 'z']);
  });

  it('head refresh of an empty list adopts the server cursor', () => {
    expect(mergeHead(emptyList(), { items: [c('a', 1)], nextCursor: 'n' })).toEqual({ items: [c('a', 1)], nextCursor: 'n' });
  });

  it('replaceConversation only touches loaded rows', () => {
    const s = { items: [c('a', 1)], nextCursor: null };
    expect(replaceConversation(s, c('a', 1, 5)).items[0].revision).toBe(5);
    expect(replaceConversation(s, c('zzz', 1))).toBe(s);
  });
});

describe('snapshotIsAhead', () => {
  const loaded = [c('a', 9, 3), c('b', 8, 1)];
  it('detects a newer revision of a loaded row', () => {
    expect(snapshotIsAhead(loaded, [{ id: 'a', revision: 4, lastActivityMs: 9 }], true)).toBe(true);
  });
  it('detects a row the list does not have inside the loaded range', () => {
    expect(snapshotIsAhead(loaded, [{ id: 'new', revision: 1, lastActivityMs: 20 }], true)).toBe(true);
  });
  it('ignores rows older than the loaded range when more pages exist', () => {
    expect(snapshotIsAhead(loaded, [{ id: 'old', revision: 1, lastActivityMs: 2 }], true)).toBe(false);
  });
  it('is false when everything matches', () => {
    expect(snapshotIsAhead(loaded, [{ id: 'a', revision: 3, lastActivityMs: 9 }, { id: 'b', revision: 1, lastActivityMs: 8 }], false)).toBe(false);
    expect(snapshotIsAhead(loaded, [], false)).toBe(false);
  });
});

describe('message windows', () => {
  const m = (id: string, at: number, text = id) => msg({ id, sentAtMs: at, text });
  const page = (ids: Array<[string, number]>, older: string | null, newer: string | null, around: string | null = null): CareMessagePageDto => ({
    items: ids.map(([id, at]) => m(id, at)), olderCursor: older, newerCursor: newer, aroundId: around,
  });

  it('keeps newest-first order and dedupes when older pages overlap', () => {
    let w = windowFromPage(page([['m5', 5], ['m4', 4]], 'o1', null));
    w = mergeOlder(w, page([['m4', 4], ['m3', 3], ['m2', 2]], 'o2', 'x'));
    expect(w.items.map((x) => x.id)).toEqual(['m5', 'm4', 'm3', 'm2']);
    expect(w.olderCursor).toBe('o2');
    expect(w.newerCursor).toBeNull(); // newer end unchanged by an older page
  });

  it('newer pages move the newer cursor and never touch the older one', () => {
    let w = windowFromPage(page([['m3', 3], ['m2', 2]], 'o1', 'n1', 'm2'));
    w = mergeNewer(w, page([['m5', 5], ['m4', 4]], 'ignored', null));
    expect(w.items.map((x) => x.id)).toEqual(['m5', 'm4', 'm3', 'm2']);
    expect(w.olderCursor).toBe('o1');
    expect(w.newerCursor).toBeNull();
  });

  it('an edited message replaces its stale copy', () => {
    let w = windowFromPage(page([['m2', 2], ['m1', 1]], null, null));
    w = mergeOlder(w, { ...page([['m1', 1]], null, null), items: [msg({ id: 'm1', sentAtMs: 1, text: 'đã sửa' })] });
    expect(w.items.find((x) => x.id === 'm1')?.text).toBe('đã sửa');
  });

  it('mergeLatest appends new tail messages when the window reaches the newest end', () => {
    const w = windowFromPage(page([['m2', 2], ['m1', 1]], 'o', null));
    const r = mergeLatest(w, page([['m3', 3], ['m2', 2]], 'o2', null));
    expect(r.window.items.map((x) => x.id)).toEqual(['m3', 'm2', 'm1']);
    expect(r.window.olderCursor).toBe('o');
    expect(r.behind).toBe(false);
  });

  it('mergeLatest does not yank a reader who opened an older hit; it reports behind', () => {
    const w = windowFromPage(page([['m2', 2], ['m1', 1]], null, 'newer', 'm2'));
    const r = mergeLatest(w, page([['m9', 9], ['m8', 8]], 'o', null));
    expect(r.window).toBe(w);
    expect(r.behind).toBe(true);
  });

  it('mergeLatest replaces the window when the fresh page leaves a hole (no overlap)', () => {
    const w = windowFromPage(page([['m2', 2], ['m1', 1]], null, null));
    const r = mergeLatest(w, page([['m90', 90], ['m89', 89]], 'older-of-new', null));
    expect(r.window.items.map((x) => x.id)).toEqual(['m90', 'm89']);
    expect(r.window.olderCursor).toBe('older-of-new');
  });

  it('mergeLatest on an empty window adopts the page', () => {
    const r = mergeLatest(emptyWindow(), page([['m1', 1]], null, null));
    expect(r.window.items).toHaveLength(1);
  });
});
