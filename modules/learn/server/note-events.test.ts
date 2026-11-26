// D2 additions to learn: the durable note feed other modules read with their own cursor (dream's comparison), and a
// module proposing a gia-thuyet lesson (signed module:<id>, waiting in Chờ duyệt like an agent's proposal).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContentFeed, ContentSnapshot, ContentWithLineage } from '../../_lib/content-feed.js';
import { createPlaybook } from './playbook.js';
import { createPostNoteSync } from './post-notes.js';
import { makeKit, writePost, type Kit } from './test-kit.js';

const NOW = Date.UTC(2026, 10, 26, 3, 0, 0) / 1000;
let kit: Kit;
beforeEach(() => {
  kit = makeKit();
});
afterEach(() => kit.cleanup());

const snap = (milestone: string, er: number): ContentSnapshot => ({
  milestone, capturedAt: NOW, reach: 1000, impressions: null, reactions: 10, comments: 0, shares: 0, clicks: null, videoViews3s: null, avgWatchS: null, videoLengthS: null, follows: null, saves: null, er,
});

describe('note events', () => {
  it('one event per milestone that is new or whose ER changed, read with the reader’s own cursor', async () => {
    const row: ContentWithLineage = {
      id: 7, pageId: 'p1', status: 'published', format: 'reel', title: 'Pha trà', caption: 'x', pillar: '', hookType: '', source: 'user', origin: 'studio',
      fbPostId: '1_7', permalink: '', publishedAt: NOW - 86400, createdAt: NOW - 90000, lineage: { ideaId: 'd#1', formulaSlug: 'f', formulaVersion: 1, sourceVideoSlug: null, expectedRatio: 1.5 }, snapshots: [snap('1h', 1)],
    };
    let events = [{ id: 1, kind: 'published' as const, contentId: 7, postId: '1_7', milestone: null, at: NOW }];
    const feed: ContentFeed = {
      since: (c, l = 100) => { const e = events.filter((x) => x.id > c).slice(0, l); return { events: e, cursor: e.at(-1)?.id ?? c }; },
      get: () => structuredClone(row),
      publishedSince: () => [],
    };
    const sync = createPostNoteSync({ db: kit.db, notes: kit.notes, feed: () => feed, folder: () => 'b1', timezone: () => 'Asia/Ho_Chi_Minh', log: kit.log, now: () => NOW });
    await sync.run();
    let page = sync.events(0);
    expect(page.events.map((e) => [e.milestone, e.er, e.contentId])).toEqual([['1h', 1, 7]]);
    expect(page.events[0]!.relPath).toMatch(/^noi-dung\/bai\/.*pha-tra\.md$/);

    row.snapshots = [snap('1h', 1), snap('24h', 4)];
    events = [...events, { id: 2, kind: 'snapshot' as const, contentId: 7, postId: '1_7', milestone: '24h' as never, at: NOW }];
    await sync.run();
    page = sync.events(page.cursor);
    expect(page.events.map((e) => [e.milestone, e.er])).toEqual([['24h', 4]]);
    // the same numbers again: no event; a changed ER: one event
    events = [...events, { id: 3, kind: 'snapshot' as const, contentId: 7, postId: '1_7', milestone: '24h' as never, at: NOW }];
    await sync.run();
    expect(sync.events(page.cursor).events).toEqual([]);
    row.snapshots = [snap('1h', 1), snap('24h', 4.5)];
    events = [...events, { id: 4, kind: 'snapshot' as const, contentId: 7, postId: '1_7', milestone: '24h' as never, at: NOW }];
    await sync.run();
    expect(sync.events(page.cursor).events.map((e) => [e.milestone, e.er])).toEqual([['24h', 4.5]]);
  });
});

describe('proposeFromModule', () => {
  it('writes a gia-thuyet signed by the module and lists it in Chờ duyệt', () => {
    for (const s of ['a', 'b', 'c']) writePost(kit, s, 5);
    const pb = createPlaybook({ db: kit.db, notes: kit.notes, folder: () => 'b1', trialPosts: () => 4, moc: () => '24h', attention: kit.attention, audit: kit.audit, log: kit.log, now: () => NOW });
    const r = pb.proposeFromModule('dream', { tieu_de: 'Làm video theo công thức "Hướng dẫn 3 bước"', mang: 'noi-dung', trang_thai: 'da-kiem-chung', bang_chung: ['[[a]]', '[[b]]', '[[c]]'], ap_dung: { mo_dau: 'cau-hoi', do_dai_toi_da: 45 } });
    const note = kit.notes.read({ folderId: 'b1', relPath: r.path })!;
    expect(note.data).toMatchObject({ trang_thai: 'gia-thuyet', de_xuat_boi: 'module:dream', dung_boi: [], bang_chung: ['[[a]]', '[[b]]', '[[c]]'], ap_dung: { mo_dau: 'cau-hoi', do_dai_toi_da: 45 } });
    expect(pb.proposals()).toEqual([expect.objectContaining({ path: r.path, kind: 'new', proposedBy: 'module:dream' })]);
    expect(kit.attention.raised.at(-1)!.title).toContain('Máy đề xuất bài học mới');
  });
});
