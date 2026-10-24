import { describe, expect, it } from 'vitest';
import { mergeTimeline } from './timeline';
import { msg } from './fixtures.test-util';
import type { CareNoteDto } from './dto';

const note = (id: string, createdAtMs: number): CareNoteDto => ({ id, conversationId: 'c1', body: `ghi chú ${id}`, author: 'owner', createdAtMs });
const m = (id: string, sentAtMs: number) => msg({ id, sentAtMs });
const ids = (rows: ReturnType<typeof mergeTimeline>) => rows.map((r) => r.id);
const both = { hasOlder: false, hasNewer: false };

describe('timeline merge (notes + messages)', () => {
  it('orders oldest first and puts each note after the messages sent before it', () => {
    // window is newest first, like the API
    const rows = mergeTimeline([m('m3', 3000), m('m2', 2000), m('m1', 1000)], [note('n2', 2500), note('n1', 1500)], both);
    expect(ids(rows)).toEqual(['m1', 'n1', 'm2', 'n2', 'm3']);
    expect(rows.map((r) => r.kind)).toEqual(['message', 'note', 'message', 'note', 'message']);
  });
  it('a note at the exact time of a message comes after it', () => {
    expect(ids(mergeTimeline([m('m1', 1000)], [note('n1', 1000)], both))).toEqual(['m1', 'n1']);
  });
  it('notes before the first / after the last message keep their place', () => {
    expect(ids(mergeTimeline([m('m1', 1000)], [note('n0', 500), note('n9', 9000)], both))).toEqual(['n0', 'm1', 'n9']);
  });
  it('same-time notes sort by id so the order never flickers', () => {
    expect(ids(mergeTimeline([], [note('b', 1000), note('a', 1000)], both))).toEqual(['a', 'b']);
  });
  it('no messages: every note is shown', () => {
    expect(ids(mergeTimeline([], [note('n1', 1)], { hasOlder: true, hasNewer: true }))).toEqual(['n1']);
  });
  it('while older history is not loaded, notes older than the oldest loaded message are held back', () => {
    const win = [m('m2', 2000), m('m1', 1000)];
    expect(ids(mergeTimeline(win, [note('old', 500), note('mid', 1500)], { hasOlder: true, hasNewer: false }))).toEqual(['m1', 'mid', 'm2']);
    expect(ids(mergeTimeline(win, [note('old', 500)], both))).toEqual(['old', 'm1', 'm2']);
  });
  it('while newer messages are not loaded (window around a search hit), notes newer than the window are held back', () => {
    const win = [m('m2', 2000), m('m1', 1000)];
    expect(ids(mergeTimeline(win, [note('late', 5000), note('mid', 1500)], { hasOlder: false, hasNewer: true }))).toEqual(['m1', 'mid', 'm2']);
  });
  it('does not mutate its inputs', () => {
    const win = [m('m2', 2000), m('m1', 1000)];
    const notes = [note('n2', 2500), note('n1', 1500)];
    mergeTimeline(win, notes, both);
    expect(win.map((x) => x.id)).toEqual(['m2', 'm1']);
    expect(notes.map((x) => x.id)).toEqual(['n2', 'n1']);
  });
});
