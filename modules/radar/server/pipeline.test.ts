import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase } from './test-db.js';
import { buildIndexPayload } from './index-payload.js';
import { runLayer, isLayerBusy, queueLayer } from './pipeline.js';
import { getReport, getRunLog } from './store.js';
import { collectResult, fakeRunner, mkItem } from './test-kit.js';
import type { RawItem, ReportPayload } from './types.js';
import { ledgerCounts } from './pipeline-test-helpers.js';

beforeEach(() => _initTestDatabase());

const D1 = new Date('2026-10-17T13:30:00Z'); // 20:30 local
const D2 = new Date('2026-10-18T13:30:00Z');

function ai(url: string, over: Partial<RawItem> = {}): RawItem {
  return mkItem(url, over);
}

function deps(items: RawItem[], runner = fakeRunner(), now = D1) {
  return {
    now: () => now,
    runner,
    collect: async () => collectResult(items, ['Facebook ghi "1 ngày", bài có thể thiếu giờ chính xác']),
    fetchComments: async (_c: unknown, urls: string[]) => new Map(urls.map((u) => [u, [{ text: 'ai share chung không ạ', url: `${u}#c1` }, { text: 'giá bao nhiêu vậy' }, { text: 'Mình bán slot 150k/tháng, inbox mình' }]])),
  };
}

describe('runLayer end to end', () => {
  it('builds a valid payload for nganh', async () => {
    const items = [
      ai('https://fb.test/1'),
      ai('https://fb.test/2', { metrics: { comments: 8 }, text: 'Dùng AI soạn giáo án thế nào' }),
      ai('https://fb.test/3', { text: 'Hôm nay trời đẹp, đi chợ mua rau', metrics: { comments: 99 } }), // not about AI: filtered by keyword
    ];
    const run = await runLayer('nganh', { trigger: 'schedule', deps: deps(items) });
    expect(run.status).toBe('ok');
    expect(run.phase).toBe('done');
    expect(run.sessionKey).toBe('s1');
    expect(run.itemCount).toBe(2);
    expect(run.costUsd).toBeGreaterThan(0);
    expect(getRunLog(run.id).join('\n')).toMatch(/Bắt đầu quét lớp Ngành nghề/);

    const payload = getReport('2026-10-17', 'nganh')!.payload as ReportPayload;
    expect(payload).toMatchObject({ version: 1, layer: 'nganh', layerLabel: 'Ngành nghề', date: '2026-10-17', dateLabel: '17/10/2026', weekday: 'Thứ Bảy', slotLabel: 'phiên 20h' });
    expect(payload.sessions).toHaveLength(1);
    const s = payload.sessions[0];
    expect(s.key).toBe('s1');
    expect(s.label).toBe('Phiên 20h');
    expect(s.scan.when).toMatch(/^Phiên 20h \(UTC\+7\)\. Lần quét đầu của lớp này nên lấy bài AI trong 7 ngày gần đây\.$/);
    expect(s.scan.sources).toBe('1 cộng đồng (151.000 thành viên)');
    expect(s.scan.top).toMatch(/^2 bài, 4\d bình luận, \d bài có tín hiệu mua$/);
    expect(s.items).toHaveLength(2);
    const first = s.items.find((i) => i.url === 'https://fb.test/1')!;
    expect(first).toMatchObject({ isNew: true, top: true, buy: true, within24h: true, sessionKey: 's1', profession: 'Giáo viên', typeLabel: 'Bài nhóm' });
    expect(first.topics).toContain('chi-phi');
    expect(s.pains[0]).toMatchObject({ id: 'P001', rank: 1, isNew: true, times: 1, firstSeen: '2026-10-17' });
    expect(s.quotes).toHaveLength(1);
    expect(s.buySignals[0].type).toBe('intent');
    expect(s.sellerNote).toMatch(/người bán/);
    expect(s.ideas[0]).toMatchObject({ channel: 'Mọi kênh', status: 'todo', painIds: ['P001'] });
    expect(s.ideas[0].title).toMatch(/^Gợi ý: /);
    expect(s.professions[0]).toMatchObject({ name: 'Giáo viên', initials: 'GV', painIds: ['P001'] });
    expect(s.missingProfessions).not.toContain('Giáo viên');
    expect(s.missingProfessions).toContain('Kế toán');
    expect(s.communities[0]).toMatchObject({ name: 'Giáo Viên Tiếng Anh', members: 151000, painId: 'P001' });
    expect(s.dataNotes).toEqual(expect.arrayContaining(['Facebook ghi "1 ngày", bài có thể thiếu giờ chính xác', 'Một nhóm chỉ xem được 3 giờ gần nhất']));

    const idx = buildIndexPayload();
    expect(idx.layers.find((l) => l.key === 'nganh')!.latest).toMatchObject({ date: '2026-10-17', newPosts: 2, newPains: 1, recurringPains: 0 });
    expect(idx.archive[0].layers.find((l) => l.key === 'nganh')!.newPosts).toBe(2);
  });

  it('a second run the same day adds a session and an "all" view without double counting', async () => {
    const items = [ai('https://fb.test/1')];
    await runLayer('nganh', { trigger: 'schedule', deps: deps(items) });
    const run2 = await runLayer('nganh', { trigger: 'manual', deps: deps([...items, ai('https://fb.test/9')], fakeRunner({ matchId: 'P001' }), new Date('2026-10-17T15:00:00Z')) });
    expect(run2.status).toBe('ok');
    expect(run2.sessionKey).toBe('s2');
    const payload = getReport('2026-10-17', 'nganh')!.payload;
    expect(payload.sessions.map((s) => s.key)).toEqual(['all', 's1', 's2']);
    expect(payload.sessions[0].label).toBe('Cả ngày');
    expect(payload.sessions[0].items).toHaveLength(2);
    expect(payload.sessions[0].items.every((i) => i.isNew)).toBe(true);
    expect(payload.sessions[2].label).toBe('Phiên 22h');
    expect(ledgerCounts()).toEqual({ pains: 1, painTimes: 1 }); // same pain, same day: still one report day
  });

  it('the next day: recurring pain counts up, known post is not new', async () => {
    const items = [ai('https://fb.test/1')];
    await runLayer('nganh', { trigger: 'schedule', deps: deps(items) });
    await runLayer('nganh', {
      trigger: 'schedule',
      deps: deps([ai('https://fb.test/1', { metrics: { comments: 80 } })], fakeRunner({ matchId: 'P001' }), D2),
    });
    const s = getReport('2026-10-18', 'nganh')!.payload.sessions[0];
    expect(s.pains[0]).toMatchObject({ id: 'P001', isNew: false, times: 2, firstSeen: '2026-10-17' });
    expect(s.items[0]).toMatchObject({ isNew: false, rising: { times: 2, prevComments: 40 } });
    expect(s.scan.when).not.toMatch(/Lần quét đầu/);
    const latest = buildIndexPayload().layers.find((l) => l.key === 'nganh')!.latest!;
    expect(latest).toMatchObject({ date: '2026-10-18', newPosts: 0, newPains: 0, recurringPains: 1 });
  });

  it('keeps going when the analyst fails and says so', async () => {
    const run = await runLayer('nganh', { trigger: 'manual', deps: deps([ai('https://fb.test/1')], fakeRunner({ failSteps: ['enrich', 'synthesize'] })) });
    expect(run.status).toBe('ok');
    const s = getReport('2026-10-17', 'nganh')!.payload.sessions[0];
    expect(s.items).toHaveLength(1);
    expect(s.items[0].title).toMatch(/Mình muốn mua ChatGPT Plus/);
    expect(s.pains).toEqual([]);
    expect(s.buySignals.length).toBeGreaterThan(0); // keyword fallback
    expect(s.dataNotes.some((n) => /Phân tích AI lỗi ở bước/.test(n))).toBe(true);
  });

  it('marks the run as error with a safe message when collection throws', async () => {
    const run = await runLayer('vn', {
      trigger: 'manual',
      deps: { now: () => D1, runner: fakeRunner(), collect: async () => { throw new Error('Apify 401 token=abcdefghijklmnopqrstuvwxyz0123456789ABCD'); } },
    });
    expect(run.status).toBe('error');
    expect(run.error).not.toMatch(/abcdefghijklmnop/);
    expect(run.finishedAt).toBeTruthy();
    expect(getReport('2026-10-17', 'vn')).toBeNull();
  });

  it('runs one layer at a time and refuses a duplicate', async () => {
    const slow = { ...deps([ai('https://fb.test/1')]), collect: async () => { await new Promise((r) => setTimeout(r, 30)); return collectResult([ai('https://fb.test/1')]); } };
    const a = queueLayer('nganh', { trigger: 'manual', deps: slow });
    expect(isLayerBusy('nganh')).toBe(true);
    expect(isLayerBusy('vn')).toBe(false);
    expect(a.run.status).toBe('queued');
    const done = await a.done;
    expect(done.status).toBe('ok');
    expect(isLayerBusy('nganh')).toBe(false);
  });

  it('world layer asks what Vietnamese X discusses', async () => {
    let asked = 0;
    const d = {
      ...deps([ai('https://x.com/a/status/1', { layer: 'world', kind: 'x', sourceName: '@a', text: 'Claude Code agents on laptops', metrics: { likes: 500 } })]),
      vnChatter: async () => { asked++; return { topics: [{ topic: 'ChatGPT', posts: 10, examples: [] }] }; },
    };
    const run = await runLayer('world', { trigger: 'manual', deps: d });
    expect(run.status).toBe('ok');
    expect(asked).toBe(1);
  });
});
