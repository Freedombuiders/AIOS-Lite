// The comparison in code: learn's feed with dream's cursor, the post note and the formula recomputed, the agent's
// two sentences checked, and learn.propose when a formula becomes `hop`.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createComparer, parseRemark, type LearnNoteEvent } from './compare.js';
import { createFormula } from './formulas.js';
import { addPost, FOLDER, makeDreamKit, type DreamKit } from './test-kit.js';

let kit: DreamKit;
let events: LearnNoteEvent[];
let proposed: Array<{ moduleId: string; payload: Record<string, unknown> }>;

beforeEach(() => {
  kit = makeDreamKit();
  events = [];
  proposed = [];
  kit.provides.set('learn', {
    postNotes: { events: (cursor: number, limit = 100) => { const e = events.filter((x) => x.id > cursor).slice(0, limit); return { events: e, cursor: e.at(-1)?.id ?? cursor }; } },
    playbook: { proposeFromModule: (moduleId: string, payload: Record<string, unknown>) => (proposed.push({ moduleId, payload }), { path: 'bai-hoc/lam-video-theo-cong-thuc.md', proposalId: 1 }) },
  });
  kit.lean.answer = () => '{"nhan_xet":"Bài của mình dài hơn video gốc. Mở đầu giống nhau."}';
  createFormula(kit.ctx, FOLDER, { name: 'Hướng dẫn 3 bước', moDau: 'cau-hoi', cauTruc: 'huong-dan-buoc', maxLen: 45 });
  // the channel's other posts at 24h: median 4
  addPost(kit, 'kenh-1', { '24h': 2 }, { dang_luc: '2026-11-10T19:00:00+07:00' });
  addPost(kit, 'kenh-2', { '24h': 4 }, { dang_luc: '2026-11-11T19:00:00+07:00' });
  addPost(kit, 'kenh-3', { '24h': 6 }, { dang_luc: '2026-11-12T19:00:00+07:00' });
});
afterEach(() => kit.cleanup());

const push = (relPath: string, milestone = '24h') => events.push({ id: events.length + 1, folderId: FOLDER, relPath, contentId: events.length + 1, milestone, er: null, at: 0 });
const fm = (text: string) => text.split('\n---\n')[0]!;

describe('comparison', () => {
  it('three posts well above expectation make the formula hop: learn gets one gia-thuyet proposal pointing at the posts', async () => {
    const cmp = createComparer(kit.ctx);
    for (const i of [1, 2, 3]) {
      // ER 12; the formula's own earlier posts are part of the channel's baseline too: medians 4, 5, 6 → 2, 1.6, 1.33
      push(addPost(kit, `minh-${i}`, { '24h': 12 }, { cong_thuc: '[[huong-dan-3-buoc]]', ky_vong: 1.5, dang_luc: `2026-11-2${i}T19:00:00+07:00` }));
    }
    push('noi-dung/bai/kenh-1.md'); // no formula: skipped
    push('noi-dung/bai/minh-1.md', '1h'); // not a compared milestone: skipped
    const r = await cmp.run();
    expect(r).toEqual({ compared: 3, skipped: 2 });
    const f = kit.read('cong-thuc/huong-dan-3-buoc.md');
    expect(fm(f)).toContain('da_lam: 3');
    expect(fm(f)).toContain('ket_qua: 1.6');
    expect(fm(f)).toContain('trang_thai: hop');
    expect(fm(f)).toContain('bai_hoc: "[[lam-video-theo-cong-thuc]]"');
    expect(f).toContain('Bot nhận xét: Bài của mình dài hơn video gốc. Mở đầu giống nhau.');
    expect(f).toContain('(thăm dò)');
    expect(proposed).toHaveLength(1);
    expect(proposed[0]).toMatchObject({ moduleId: 'dream', payload: { mang: 'noi-dung', bang_chung: ['[[minh-1]]', '[[minh-2]]', '[[minh-3]]'], ap_dung: { mo_dau: 'cau-hoi', do_dai_toi_da: 45 } } });
    expect(String(proposed[0]!.payload.noi_dung)).toContain('thăm dò');
    // the cursor is kept: nothing new, nothing compared, no second proposal
    expect(await cmp.run()).toEqual({ compared: 0, skipped: 0 });
    expect(proposed).toHaveLength(1);
  });

  it('the 7d numbers add a second entry and become the post’s so_voi_ky_vong; a reconcile finds nothing more to do', async () => {
    const rel = addPost(kit, 'minh', { '24h': 6, '7d': 3 }, { cong_thuc: '[[huong-dan-3-buoc]]', ky_vong: 1.5, dang_luc: '2026-11-20T19:00:00+07:00' });
    addPost(kit, 'kenh-7d', { '7d': 2 }, { dang_luc: '2026-11-13T19:00:00+07:00' });
    const cmp = createComparer(kit.ctx);
    expect(await cmp.reconcile(FOLDER)).toBe(2);
    const post = fm(kit.read(rel));
    expect(post).toMatch(/doi_chieu:\n {2}- moc: 24h\n[\s\S]* {4}so_voi_ky_vong: 1\n {2}- moc: 7d\n[\s\S]* {4}ti_le: 1\.5\n[\s\S]* {4}so_voi_ky_vong: 1\n/);
    expect(post).toContain('so_voi_ky_vong: 1\n');
    expect(await cmp.reconcile(FOLDER)).toBe(0);
  });

  it('the agent’s remark must be one key, at most two sentences; anything else is dropped', async () => {
    expect(parseRemark({ nhan_xet: 'Một câu. Hai câu.' })).toBe('Một câu. Hai câu.');
    expect(parseRemark({ nhan_xet: 'Một. Hai. Ba.' })).toBeNull();
    expect(parseRemark({ nhan_xet: 'Một câu.', trang_thai: 'hop' })).toBeNull();
    expect(parseRemark({ nhan_xet: 'Xem https://x.test' })).toBeNull();
    kit.lean.answer = () => '{"nhan_xet":"Ổn.","ket_qua":9}';
    push(addPost(kit, 'minh', { '24h': 7.5 }, { cong_thuc: '[[huong-dan-3-buoc]]', ky_vong: 1.5, dang_luc: '2026-11-20T19:00:00+07:00' }));
    await createComparer(kit.ctx).run();
    const f = kit.read('cong-thuc/huong-dan-3-buoc.md');
    expect(f).not.toContain('Bot nhận xét');
    expect(fm(f)).toContain('ket_qua: 1.25');
  });
});
