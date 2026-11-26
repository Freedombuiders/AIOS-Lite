// The whole loop through the real module manager, with marketing, learn and dream side by side:
//   suggestion → "Giao Bot Nội dung viết" → idea row with lineage (marketing's own create path) → owner approves →
//   publish with a fake Composio → 24h snapshot → learn's note (contentFeed) → dream compares → formula note updated.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ execute: vi.fn(), graph: vi.fn(), notify: vi.fn(async () => {}) }));
vi.mock('../../_lib/composio.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../_lib/composio.js')>();
  return { ...actual, execute: mocks.execute, graphAsPage: mocks.graph, hasComposioKey: () => true };
});
vi.mock('../../marketing/server/notify.js', () => ({ notifyOwner: mocks.notify }));

import { createModuleManager } from '../../../src/modules/manager.js';
import { createTestHarness, fakeAgent, type TestHarness } from '../../../src/modules/test-deps.js';
import { approveContent, updateContent } from '../../marketing/server/core/content.js';
import { _resetPublisher, publisherTick } from '../../marketing/server/core/publisher.js';
import { makePage } from '../../marketing/server/core/test-fixtures.js';
import { getFbContent, insertFbContent, markFbContentPublished, upsertFbPostMetrics, type FbPostMetricsRow } from '../../marketing/server/store.js';

const MODULES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const POST_ID = '555_777';
const HOUR = 3600;

let h: TestHarness | undefined;
let brainDir = '';
afterEach(() => {
  vi.useRealTimers();
  h?.cleanup();
});

function metric(postId: string, milestone: string, engaged: number, capturedAt: number): FbPostMetricsRow {
  // ER (marketing's erOf) = (reactions + comments + shares) ÷ reach × 100, reach 400
  return {
    post_id: postId, page_id: 'P1', milestone, captured_at: capturedAt, reach: 400, impressions: 600, reactions: engaged, comments: 0, shares: 0,
    clicks: null, video_views_3s: null, avg_watch_s: null, video_length_s: null, follows: null, saves: null, raw_json: '{}',
  };
}

/** A post of the channel published days ago, already measured at 24h (the baseline). */
function pastPost(caption: string, postId: string, publishedAt: number, engaged: number): void {
  const id = insertFbContent({ page_id: 'P1', title: '', caption, format: 'text', pillar: 'Khác', hook_type: '', status: 'publishing' });
  markFbContentPublished(id, { published_at: publishedAt, fb_post_id: postId, permalink: `https://facebook.com/${postId}`, published_as: 'text', last_error: '' });
  upsertFbPostMetrics(metric(postId, '24h', engaged, publishedAt + 25 * HOUR));
}

const fm = (text: string) => text.split('\n---\n')[0]!;

describe('formula loop, end to end', () => {
  it('suggestion → give to bot → publish → 24h snapshot → formula note with da_lam 1 and the right ket_qua', async () => {
    const T0 = Date.UTC(2026, 10, 26, 1, 0, 0) / 1000; // 08:00 Vietnam time
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0 * 1000);

    h = createTestHarness({ modulesDir: MODULES_DIR });
    brainDir = path.join(h.root, 'brain');
    fs.mkdirSync(brainDir);
    (h.deps.brain as { folders: () => unknown[] }).folders = () => [{ id: 'b1', name: 'Trà sen', path: brainDir }];
    h.fakes.connections.set('composio', { id: 'composio', type: 'composio' } as never);
    h.fakes.agents.set('main', fakeAgent('main'));
    h.fakes.agents.set('bot-noi-dung', fakeAgent('bot-noi-dung', { access: { brain: { b1: { read: ['**'], write: ['**'] } }, memory: { team: true, private: true }, skills: [], connections: {}, modules: { marketing: ['content.write'] } } }));
    // agent turns: the suggestion's words and the comparison's remark; the writer's task is left queued
    h.fakes.state.autoFinish = (t) => {
      if (t.title.startsWith('Dream 100: đề xuất')) return { output: JSON.stringify({ tieu_de: '3 bước pha ô long sen lạnh', cau_mo_dau: 'Vì sao ô long pha lạnh hay bị chát?', viec_can_lam: 'Quay 3 cảnh cận tay.', nen_tang: 'facebook' }) };
      if (t.title.startsWith('Dream 100: đối chiếu')) return { output: '{"nhan_xet":"Bài của mình là bài chữ, video gốc dài khoảng 38 giây."}' };
      return { status: 'queued' as never };
    };
    _resetPublisher();
    mocks.execute.mockReset();
    mocks.execute.mockImplementation(async (slug: string) => {
      if (slug === 'FACEBOOK_CREATE_POST') return { id: POST_ID };
      throw new Error(`unexpected ${slug}`);
    });
    mocks.graph.mockResolvedValue({ status: 200, data: {} });

    const mgr = createModuleManager(h.deps, { fromDist: false });
    (h.deps as { modules: unknown }).modules = mgr;
    await mgr.add('marketing', { installAgents: false });
    mgr.updateSettings('marketing', { enabled: true });
    makePage('P1');
    await mgr.add('learn', { installAgents: false });
    mgr.updateSettings('learn', { folder: 'b1' });
    await mgr.add('dream', { installAgents: false });
    mgr.updateSettings('dream', { brain_folder: 'b1' });
    const app = new Hono();
    mgr.mount(app);
    const call = async (method: string, url: string, body?: unknown) => {
      const res = await app.request(`/api/m/dream${url}`, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: res.status, json: (await res.json()) as any };
    };
    type LearnP = { postNotes: { syncNow(): Promise<unknown> } };
    const learn = () => mgr.provides<LearnP>('learn')!.postNotes;

    // the channel: three posts measured at 24h, ER 2 %, 4 %, 6 % (median 4 %)
    pastPost('Bài cũ một', '9_1', T0 - 5 * 86400, 8);
    pastPost('Bài cũ hai', '9_2', T0 - 4 * 86400, 16);
    pastPost('Bài cũ ba', '9_3', T0 - 3 * 86400, 24);
    await learn().syncNow();

    // a reference video analysed earlier, and the owner's formula made from it
    h.deps.db.prepare(
      `INSERT INTO dream_videos (id, url, folder_id, status, platform, views, duration_s, cuts_per_min, mo_dau, cau_truc, keu_goi, note_path, captured_at, created_at, finished_at)
       VALUES ('vd_1', 'https://www.tiktok.com/@bep/video/1', 'b1', 'done', 'tiktok', 412000, 38, 14, 'cau-hoi', 'huong-dan-buoc', 'theo-doi', 'dream-100/video/2026-11-25-bep-vd_1.md', ?, ?, ?)`,
    ).run(T0 * 1000 - 86_400_000, T0 * 1000 - 86_400_000, T0 * 1000 - 86_400_000);
    h.deps.notes.forModule('dream').create({ folderId: 'b1', relPath: 'dream-100/video/2026-11-25-bep-vd_1.md' }, { loai: 'video-dream', kenh: 'bep', mo_dau: 'cau-hoi', do_dai: 38 }, '# Video mẫu\n', { message: 't' });
    const created = await call('POST', '/formulas', { name: 'Hướng dẫn 3 bước', moDau: 'cau-hoi', cauTruc: 'huong-dan-buoc', maxLen: 45, pillar: 'Cách pha' });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ slug: 'huong-dan-3-buoc', evidence: 1, state: 'chua-thu' });

    // morning: one formula, one suggestion
    const run = await call('POST', '/ideas/run');
    expect(run.json).toMatchObject({ state: 'ok', picked: 1, written: 1 });
    const day = run.json.day as string;
    const list = await call('GET', `/ideas?day=${day}`);
    expect(list.json.items[0]).toMatchObject({ slot: 1, formula_slug: 'huong-dan-3-buoc', expected_ratio: 1.5, status: 'new', source_video_slug: '2026-11-25-bep-vd_1' });
    expect(fs.readFileSync(path.join(brainDir, 'noi-dung', 'de-xuat', `${day}.md`), 'utf8')).toContain('3 bước pha ô long sen lạnh');

    // "Giao Bot Nội dung viết": an idea row through marketing's create path, lineage fixed now, a task for the writer
    const given = await call('POST', `/ideas/${day}/1/give`);
    expect(given.status).toBe(200);
    const contentId = given.json.content_id as number;
    expect(getFbContent(contentId)).toMatchObject({
      status: 'idea', source: 'user', origin: 'studio', idea_id: `${day}#1`, formula_slug: 'huong-dan-3-buoc', formula_version: 1, source_video_slug: '2026-11-25-bep-vd_1', expected_ratio: 1.5,
    });
    expect(h.fakes.tasks.at(-1)).toMatchObject({ agentId: 'bot-noi-dung', source: 'module:dream' });
    expect(() => updateContent(contentId, { lineage: { expectedRatio: 9 } }, { kind: 'user' })).toThrow(/Dòng dõi/);

    // the bot's draft (here: the owner edits it), the owner approves, the publisher posts it through fake Composio
    updateContent(contentId, { pageId: 'P1', format: 'text', caption: 'Vì sao ô long pha lạnh hay bị chát? Ba bước để hết chát.' }, { kind: 'user' });
    const publishAt = T0 + HOUR;
    approveContent(contentId, publishAt, T0);
    vi.setSystemTime(publishAt * 1000);
    await publisherTick(publishAt);
    expect(getFbContent(contentId)).toMatchObject({ status: 'published', fb_post_id: POST_ID });

    // 24 hours later: the snapshot (ER 7.5 %) reaches learn through marketing's contentFeed, then dream compares
    vi.setSystemTime((publishAt + 25 * HOUR) * 1000);
    upsertFbPostMetrics(metric(POST_ID, '24h', 30, publishAt + 25 * HOUR));
    await learn().syncNow();
    const cmp = await call('POST', '/compare/run');
    expect(cmp.json.compared).toBe(1);

    const postFile = fs.readdirSync(path.join(brainDir, 'noi-dung', 'bai')).find((f) => fs.readFileSync(path.join(brainDir, 'noi-dung', 'bai', f), 'utf8').includes('huong-dan-3-buoc'))!;
    const post = fs.readFileSync(path.join(brainDir, 'noi-dung', 'bai', postFile), 'utf8');
    expect(fm(post)).toContain('cong_thuc: "[[huong-dan-3-buoc]]"');
    expect(fm(post)).toContain('ky_vong: 1.5');
    // 7.5 ÷ median(2, 4, 6) = 1.875 times the channel; ÷ 1.5 expected = 1.25 — the post itself is not in the median
    expect(fm(post)).toMatch(/doi_chieu:\n {2}- moc: 24h\n {4}er: 7\.5\n {4}trung_vi_kenh: 4\n {4}so_bai_nen: 3\n {4}ti_le: 1\.88\n {4}ky_vong: 1\.5\n {4}so_voi_ky_vong: 1\.25\n/);
    expect(fm(post)).toContain('so_voi_ky_vong: 1.25');

    const formula = fs.readFileSync(path.join(brainDir, 'cong-thuc', 'huong-dan-3-buoc.md'), 'utf8');
    expect(fm(formula)).toContain('da_lam: 1');
    expect(fm(formula)).toContain('ket_qua: 1.25');
    expect(fm(formula)).toContain('trang_thai: co-ve-hop');
    expect(formula).toContain('(thăm dò)');
    expect(formula).toContain('Bot nhận xét: Bài của mình là bài chữ, video gốc dài khoảng 38 giây.');

    // replaying the feed changes nothing; a restart of dream catches up from its cursor without comparing twice
    expect((await call('POST', '/compare/run')).json.compared).toBe(0);
    await mgr.remove('dream');
    await mgr.add('dream', { installAgents: false });
    expect((await call('POST', '/compare/run')).json.compared).toBe(0);
    expect(fs.readFileSync(path.join(brainDir, 'cong-thuc', 'huong-dan-3-buoc.md'), 'utf8')).toBe(formula);

    await mgr.remove('dream');
    await mgr.remove('learn');
    await mgr.remove('marketing');
    await mgr.stop();
  });
});
