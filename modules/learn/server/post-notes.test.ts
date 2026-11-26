// The note sync against a fake contentFeed and the real notes service on a temporary brain folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ContentFeed, ContentFeedEvent, ContentSnapshot, ContentWithLineage } from '../../_lib/content-feed.js';
import { openDb } from '../../../src/core/db.js';
import { createLogger } from '../../../src/core/log.js';
import { createNotes } from '../../../src/shared/notes.js';
import { createPostNoteSync, type PostNoteSyncDeps } from './post-notes.js';

const MIGRATION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations', '001_init.sql');
const NOW = Date.UTC(2026, 10, 26, 3, 0, 0) / 1000; // 10:00 Vietnam time
const DAY = 86400;

function snapshot(milestone: string, over: Partial<ContentSnapshot> = {}): ContentSnapshot {
  return {
    milestone, capturedAt: NOW, reach: 1000, impressions: null, reactions: 40, comments: 5, shares: 5, clicks: null,
    videoViews3s: null, avgWatchS: null, videoLengthS: null, follows: null, saves: null, er: 5, ...over,
  };
}

function post(id: number, over: Partial<ContentWithLineage> = {}): ContentWithLineage {
  return {
    id, pageId: 'p1', status: 'published', format: 'reel', title: `Cách ướp trà sen ${id}`, caption: 'Bạn có biết một cân trà sen cần bao nhiêu bông?',
    pillar: 'Cách pha, ướp', hookType: 'câu hỏi', source: 'user', origin: 'studio', fbPostId: `1_${id}`, permalink: `https://facebook.com/1_${id}`,
    publishedAt: NOW - DAY, createdAt: NOW - 2 * DAY, lineage: null, snapshots: [], ...over,
  };
}

/** In-memory stand-in for marketing's contentFeed. */
class FakeFeed implements ContentFeed {
  rows = new Map<number, ContentWithLineage>();
  events: ContentFeedEvent[] = [];
  sinceCalls: number[] = [];
  add(row: ContentWithLineage, event = true): void {
    this.rows.set(row.id, row);
    if (event) this.push('published', row.id, null);
  }
  measure(id: number, s: ContentSnapshot): void {
    const row = this.rows.get(id)!;
    row.snapshots = [...row.snapshots.filter((x) => x.milestone !== s.milestone), s];
    this.push('snapshot', id, s.milestone);
  }
  push(kind: 'published' | 'snapshot', contentId: number, milestone: string | null): void {
    this.events.push({ id: this.events.length + 1, kind, contentId, postId: `1_${contentId}`, milestone, at: NOW });
  }
  since(cursor: number, limit = 100) {
    this.sinceCalls.push(cursor);
    const events = this.events.filter((e) => e.id > cursor).slice(0, limit);
    return { events, cursor: events.length ? events[events.length - 1]!.id : cursor };
  }
  get(id: number) {
    const r = this.rows.get(id);
    return r ? structuredClone(r) : undefined;
  }
  publishedSince(sinceSec: number, afterId = 0, limit = 100) {
    return [...this.rows.values()]
      .filter((r) => r.status === 'published' && r.publishedAt !== null && r.publishedAt >= sinceSec && r.id > afterId)
      .map((r) => r.id).sort((a, b) => a - b).slice(0, limit);
  }
}

let root = '';
let brainDir = '';
let db: ReturnType<typeof openDb>;
let feed: FakeFeed;
let folder = 'b1';

const notes = () => createNotes({
  brain: { folders: () => [{ id: 'b1', name: 'Brain', path: brainDir }], indexPaths: () => ({ indexed: 0, removed: 0 }), backlinks: () => [] },
  canRead: () => true,
  canWrite: () => true,
  log: createLogger({ level: 'silent' }),
}).forModule('learn');

function makeSync(over: Partial<PostNoteSyncDeps> = {}) {
  return createPostNoteSync({
    db, notes: notes(), feed: () => feed, folder: () => folder, timezone: () => 'Asia/Ho_Chi_Minh', log: createLogger({ level: 'silent' }), now: () => NOW, ...over,
  });
}

const noteFiles = () => {
  const dir = path.join(brainDir, 'noi-dung', 'bai');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort() : [];
};
const readNote = (name: string) => fs.readFileSync(path.join(brainDir, 'noi-dung', 'bai', name), 'utf8');
const dataOf = (name: string) => notes().read({ folderId: 'b1', relPath: `noi-dung/bai/${name}` })!.data as Record<string, unknown>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-notes-'));
  brainDir = path.join(root, 'brain');
  fs.mkdirSync(brainDir);
  db = openDb(':memory:');
  db.exec(fs.readFileSync(MIGRATION, 'utf8'));
  feed = new FakeFeed();
  folder = 'b1';
});

afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('post notes', () => {
  it('creates one note per published post, even when the feed is replayed', async () => {
    const sync = makeSync();
    await sync.run(); // backfill of an empty feed
    feed.add(post(1));
    const first = await sync.run();
    expect(first).toMatchObject({ state: 'ok', created: 1 });
    expect(noteFiles()).toEqual(['2026-11-25-cach-uop-tra-sen-1.md']);

    // the same event again, then the whole feed again from the start
    feed.push('published', 1, null);
    await sync.run();
    db.prepare("UPDATE learn_state SET value = '0' WHERE key = 'feed_cursor'").run();
    db.prepare('DELETE FROM learn_post_index').run(); // even without the index the note is found by its id
    await sync.run();
    expect(noteFiles()).toEqual(['2026-11-25-cach-uop-tra-sen-1.md']);

    const data = dataOf('2026-11-25-cach-uop-tra-sen-1.md');
    expect(data).toMatchObject({
      loai: 'bai-dang', id: 1, nen_tang: 'facebook', dinh_dang: 'video-ngan', tru_cot: 'Cách pha, ướp', mo_dau: 'cau-hoi', kieu_hook: 'câu hỏi',
      dang_luc: '2026-11-25T10:00:00+07:00', link: 'https://facebook.com/1_1', so_do: [],
    });
  });

  it('copies the lineage and names a second post with the same title apart', async () => {
    feed.add(post(1, { lineage: { ideaId: 'idea-7', formulaSlug: 'huong-dan-3-buoc', formulaVersion: 2, sourceVideoSlug: 'bep-nha-moc-7301', expectedRatio: 1.5 } }));
    feed.add(post(2, { title: 'Cách ướp trà sen 1' }));
    await makeSync().run();
    expect(noteFiles()).toEqual(['2026-11-25-cach-uop-tra-sen-1-2.md', '2026-11-25-cach-uop-tra-sen-1.md']);
    expect(dataOf('2026-11-25-cach-uop-tra-sen-1.md')).toMatchObject({
      de_xuat: 'idea-7', cong_thuc: '[[huong-dan-3-buoc]]', cong_thuc_phien_ban: 2, hoc_tu: '[[bep-nha-moc-7301]]', ky_vong: 1.5,
    });
    expect(dataOf('2026-11-25-cach-uop-tra-sen-1-2.md')).toMatchObject({ id: 2 });
    expect(dataOf('2026-11-25-cach-uop-tra-sen-1-2.md')).not.toHaveProperty('cong_thuc');
  });

  it('keeps a 24h and then a 7d snapshot side by side in so_do; missing values stay absent', async () => {
    const sync = makeSync();
    feed.add(post(1));
    await sync.run();
    feed.measure(1, snapshot('24h', { capturedAt: NOW, reach: 1000, er: 5, avgWatchS: 21.4, videoLengthS: 38 }));
    await sync.run();
    feed.measure(1, snapshot('7d', { capturedAt: NOW + 6 * DAY, reach: 3000, er: 4.2, reactions: null, avgWatchS: null }));
    await sync.run();

    const data = dataOf('2026-11-25-cach-uop-tra-sen-1.md');
    expect(data.so_do).toEqual([
      { moc: '24h', luc_do: '2026-11-26T10:00:00+07:00', reach: 1000, er: 5, tb_xem: 21.4, cam_xuc: 40, binh_luan: 5, chia_se: 5 },
      { moc: '7d', luc_do: '2026-12-02T10:00:00+07:00', reach: 3000, er: 4.2, binh_luan: 5, chia_se: 5 },
    ]);
    expect(data.moc_da_do).toEqual(['24h', '7d']);
    expect(data.do_dai).toBe(38); // a video length filled in once Facebook returned it
    const text = readNote('2026-11-25-cach-uop-tra-sen-1.md');
    expect(text).toContain('| 24 giờ | 2026-11-26 10:00 | 1.000 | 5% | 21,4 giây | 5 | 5 |');
    expect(text).toContain('| 7 ngày |');
    expect(text).not.toMatch(/hien_thi|click|luu:/);
  });

  it('a later snapshot of the same milestone replaces only that milestone', async () => {
    const sync = makeSync();
    feed.add(post(1));
    feed.measure(1, snapshot('1h', { reach: 100, er: 9 }));
    feed.measure(1, snapshot('24h', { reach: 1000 }));
    await sync.run();
    feed.measure(1, snapshot('24h', { reach: 1200, er: 6 }));
    await sync.run();
    const soDo = dataOf('2026-11-25-cach-uop-tra-sen-1.md').so_do as Array<Record<string, unknown>>;
    expect(soDo.map((e) => [e.moc, e.reach, e.er])).toEqual([['1h', 100, 9], ['24h', 1200, 6]]);
  });

  it('resumes from the stored cursor after a restart without duplicates', async () => {
    feed.add(post(1));
    feed.measure(1, snapshot('1h'));
    await makeSync().run();
    const cursor = Number((db.prepare("SELECT value FROM learn_state WHERE key = 'feed_cursor'").get() as { value: string }).value);
    expect(cursor).toBe(2);

    // the app was off: new events piled up
    feed.add(post(2, { title: 'Bài thứ hai', publishedAt: NOW - 3600 }));
    feed.measure(1, snapshot('24h'));
    feed.sinceCalls = [];
    const restarted = makeSync(); // fresh instance, same database
    const r = await restarted.run();
    expect(feed.sinceCalls[0]).toBe(2); // read from where it stopped, not from the start
    expect(r).toMatchObject({ created: 1, updated: 1, backfilled: false });
    expect(noteFiles()).toEqual(['2026-11-25-cach-uop-tra-sen-1.md', '2026-11-26-bai-thu-hai.md']);
    expect(restarted.status()).toMatchObject({ state: 'ok', cursor: 4, notes: 2 });
  });

  it('never touches the person’s text: body outside the block and their own keys survive byte for byte', async () => {
    const sync = makeSync();
    feed.add(post(1));
    feed.measure(1, snapshot('1h'));
    await sync.run();
    const name = '2026-11-25-cach-uop-tra-sen-1.md';
    const file = path.join(brainDir, 'noi-dung', 'bai', name);
    const original = fs.readFileSync(file, 'utf8');
    // the owner writes in Obsidian: a note under "Ghi chú", text after the block, a corrected pillar and a key of their own
    const edited = original
      .replace('## Ghi chú\n\n', '## Ghi chú\n\nKhách hỏi nhiều về giá sỉ — làm thêm bài về đại lý.\n')
      .replace('tru_cot: Cách pha, ướp', 'tru_cot: Hướng dẫn # chủ sửa')
      .replace('nen_tang: facebook', 'nen_tang: facebook\nnhan_rieng: thu-nghiem') + '\nViết thêm ở cuối file.\n';
    fs.writeFileSync(file, edited);

    feed.measure(1, snapshot('24h', { reach: 2000 }));
    await sync.run();
    const after = fs.readFileSync(file, 'utf8');
    const outside = (t: string) => {
      const body = t.slice(t.indexOf('\n---\n', 4) + 5);
      return body.replace(/<!-- aios:begin so-do -->[\s\S]*<!-- aios:end so-do -->/, '<BLOCK>');
    };
    expect(outside(after)).toBe(outside(edited));
    expect(after).toContain('tru_cot: Hướng dẫn # chủ sửa');
    expect(after).toContain('nhan_rieng: thu-nghiem');
    expect(after).toContain('| 24 giờ |');
  });

  it('does nothing while no folder is chosen, and says so', async () => {
    folder = '';
    const spy = vi.spyOn(feed, 'since');
    feed.add(post(1));
    const sync = makeSync();
    expect(await sync.run()).toMatchObject({ state: 'no-folder', created: 0 });
    expect(spy).not.toHaveBeenCalled();
    expect(noteFiles()).toEqual([]);
    expect(sync.status()).toMatchObject({ state: 'no-folder', folder: '', cursor: 0, notes: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM learn_state').get()).toEqual({ n: 0 });

    // an unknown folder id, and marketing turned off, are reported too
    folder = 'khong-co';
    expect((await sync.run()).state).toBe('folder-missing');
    folder = 'b1';
    expect((await makeSync({ feed: () => undefined }).run()).state).toBe('no-marketing');

    // once chosen, the post is picked up
    expect(await sync.run()).toMatchObject({ state: 'ok', created: 1, backfilled: true });
  });

  it('backfills the last 90 days in batches, studio posts only', async () => {
    for (let i = 1; i <= 120; i++) feed.add(post(i, { title: `Bài số ${i}`, publishedAt: NOW - i * 3600 * 12 }), false);
    feed.add(post(500, { title: 'Bài cũ', publishedAt: NOW - 120 * DAY }), false);
    feed.add(post(501, { title: 'Bài nhập', origin: 'imported' }), false);
    feed.add(post(502, { title: 'Bài đã xoá', status: 'deleted' }), false);
    const batch = vi.fn();
    const n = notes();
    const sync = makeSync({ notes: { ...n, batch: (m: string, fn: Parameters<typeof n.batch>[1]) => { batch(m); return n.batch(m, fn); } } as never });
    const r = await sync.run();
    expect(r).toMatchObject({ backfilled: true, created: 120 });
    expect(noteFiles()).toHaveLength(120);
    expect(noteFiles().some((f) => f.includes('bai-cu') || f.includes('bai-nhap') || f.includes('bai-da-xoa'))).toBe(false);
    expect(batch.mock.calls.filter(([m]) => String(m).includes('90 ngày'))).toHaveLength(2); // 100 + 20

    // not again for the same folder
    expect((await sync.run()).backfilled).toBe(false);
  });

  it('finds a note the owner renamed instead of writing a second one', async () => {
    const sync = makeSync();
    feed.add(post(1));
    await sync.run();
    const dir = path.join(brainDir, 'noi-dung', 'bai');
    fs.renameSync(path.join(dir, '2026-11-25-cach-uop-tra-sen-1.md'), path.join(dir, 'uop-tra-sen.md'));
    feed.measure(1, snapshot('24h'));
    await sync.run();
    expect(noteFiles()).toEqual(['uop-tra-sen.md']);
    expect(dataOf('uop-tra-sen.md').moc_da_do).toEqual(['24h']);
  });
});
