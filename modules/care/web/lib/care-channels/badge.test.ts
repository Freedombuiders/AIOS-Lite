import { describe, expect, it } from 'vitest';
import { INBOX_BADGE_PATH, INBOX_BADGE_POLL_MS, meCountFrom } from './badge-view';

const counts = (me: number) => ({ inboxCounts: { byView: { me, ai: 0, none: 0, all: 9 }, byStatus: { open: 0, pending: 0, snoozed: 0, done: 0 } } });

describe('sidebar badge of the shared inbox', () => {
  it('is the "Cần tôi" count of the conversations payload', () => {
    expect(meCountFrom(counts(4))).toBe(4);
    expect(meCountFrom(counts(0))).toBe(0);
  });

  it('is 0 for anything unexpected (older server, error body, garbage)', () => {
    expect(meCountFrom(null)).toBe(0);
    expect(meCountFrom(undefined)).toBe(0);
    expect(meCountFrom({})).toBe(0);
    expect(meCountFrom({ inboxCounts: null })).toBe(0);
    expect(meCountFrom({ inboxCounts: { byView: undefined } })).toBe(0);
    expect(meCountFrom(counts(-3))).toBe(0);
    expect(meCountFrom(counts(Number.NaN))).toBe(0);
    expect(meCountFrom({ inboxCounts: { byView: { me: '7' } } } as never)).toBe(0);
  });

  it('polls every 30 seconds the cheap way: one row is enough for the counts', () => {
    expect(INBOX_BADGE_POLL_MS).toBe(30_000);
    expect(INBOX_BADGE_PATH).toBe('/api/m/care/conversations?view=me&limit=1');
  });
});
