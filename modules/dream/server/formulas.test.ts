// Formulas: matching an analysed video, proposing a formula from 3 videos, the owner creating one, and nobody else.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NoteAccessError } from '../../../src/shared/notes.js';
import dream from './index.js';
import { afterVideo, createFormula, dismissProposal, FormulaError, listProposals, matchFormula, readFormulas } from './formulas.js';
import { addVideo, FOLDER, makeDreamKit, type DreamKit } from './test-kit.js';

let kit: DreamKit;
beforeEach(() => {
  kit = makeDreamKit();
});
afterEach(() => kit.cleanup());

const fm = (text: string) => text.split('\n---\n')[0]!;

describe('formulas', () => {
  it('3 unassigned videos with the same labels in 30 days raise a proposal; the owner turns it into a formula', () => {
    addVideo(kit, 'v1', { duration_s: 31 });
    expect(afterVideo(kit.ctx, 'v1')).toEqual({});
    addVideo(kit, 'v2', { duration_s: 42 });
    addVideo(kit, 'old', { captured_at: Date.now() - 40 * 86_400_000 });
    addVideo(kit, 'other', { mo_dau: 'con-so' });
    expect(afterVideo(kit.ctx, 'v2')).toEqual({});
    addVideo(kit, 'v3', { duration_s: 38 });
    const r = afterVideo(kit.ctx, 'v3');
    expect(r.proposal).toBeGreaterThan(0);
    expect(kit.attention.raised.at(-1)).toMatchObject({ key: `formula-proposal:${r.proposal}`, link: '/m/dream/formulas' });
    const [p] = listProposals(kit.ctx, FOLDER);
    expect(p).toMatchObject({ moDau: 'cau-hoi', cauTruc: 'huong-dan-buoc', maxDuration: 45 });
    expect(p!.videos.map((v) => v.id).sort()).toEqual(['v1', 'v2', 'v3']);
    // a 4th video refreshes the same proposal, it does not open a second one
    addVideo(kit, 'v4');
    expect(afterVideo(kit.ctx, 'v4').proposal).toBe(r.proposal);
    expect(listProposals(kit.ctx, FOLDER)).toHaveLength(1);

    const f = createFormula(kit.ctx, FOLDER, { name: 'Hướng dẫn 3 bước dưới 45 giây', moDau: 'cau-hoi', cauTruc: 'huong-dan-buoc', proposalId: r.proposal!, pillar: 'Cách pha' });
    expect(f).toMatchObject({ slug: 'huong-dan-3-buoc-duoi-45-giay', state: 'chua-thu', kyVong: 1.5, made: 0, version: 1, maxLen: 45, evidence: 5, pillar: 'Cách pha' });
    const text = kit.read('cong-thuc/huong-dan-3-buoc-duoi-45-giay.md');
    expect(fm(text)).toContain('loai: cong-thuc');
    expect(fm(text)).toContain('ky_vong: 1.5');
    expect(fm(text)).toContain('trang_thai: chua-thu');
    expect(fm(text)).toContain('da_lam: 0');
    expect(fm(text)).toContain('phien_ban: 1');
    expect(fm(text)).toContain('bang_chung: 5');
    expect(text).toContain('[[2026-11-26-kenh-mau-v1]]');
    expect(kit.read('dream-100/video/2026-11-26-kenh-mau-v2.md')).toContain('cong_thuc: "[[huong-dan-3-buoc-duoi-45-giay]]"');
    // the old video (40 days) fits too: every unassigned video that fits becomes evidence
    expect((kit.h.deps.db.prepare("SELECT formula_slug FROM dream_videos WHERE id = 'old'").get() as { formula_slug: string }).formula_slug).toBe('huong-dan-3-buoc-duoi-45-giay');
    expect((kit.h.deps.db.prepare("SELECT formula_slug FROM dream_videos WHERE id = 'other'").get() as { formula_slug: string | null }).formula_slug).toBeNull();
    expect(kit.attention.resolved).toContain(`formula-proposal:${r.proposal}`);
    expect(listProposals(kit.ctx, FOLDER)).toEqual([]);
    expect(() => createFormula(kit.ctx, FOLDER, { name: 'Hướng dẫn 3 bước dưới 45 giây', moDau: 'cau-hoi', cauTruc: 'huong-dan-buoc' })).toThrow(FormulaError);
  });

  it('a new video joins the formula whose labels and length it fits, and the evidence count grows', () => {
    createFormula(kit.ctx, FOLDER, { name: 'Ngắn', moDau: 'cau-hoi', cauTruc: 'huong-dan-buoc', maxLen: 30 });
    createFormula(kit.ctx, FOLDER, { name: 'Dài', moDau: 'cau-hoi', cauTruc: 'huong-dan-buoc', maxLen: 60 });
    addVideo(kit, 'a', { duration_s: 25 });
    addVideo(kit, 'b', { duration_s: 50 });
    addVideo(kit, 'c', { duration_s: 90 });
    addVideo(kit, 'd', { mo_dau: null, label_note: 'Thiếu dữ liệu' });
    expect(afterVideo(kit.ctx, 'a')).toEqual({ matched: 'ngan' });
    expect(afterVideo(kit.ctx, 'b')).toEqual({ matched: 'dai' });
    expect(afterVideo(kit.ctx, 'c')).toEqual({});
    expect(afterVideo(kit.ctx, 'd')).toEqual({});
    const fs = readFormulas(kit.ctx, FOLDER);
    expect(fs.find((f) => f.slug === 'ngan')!.evidence).toBe(1);
    expect(fs.find((f) => f.slug === 'dai')!.evidence).toBe(1);
    expect(matchFormula(fs, { mo_dau: 'cau-hoi', cau_truc: 'huong-dan-buoc', duration_s: null })).toBeUndefined();
  });

  it('a dismissed proposal is closed; bad input is refused in Vietnamese', () => {
    for (const id of ['x1', 'x2', 'x3']) addVideo(kit, id, { cau_truc: 'danh-sach' });
    const { proposal } = afterVideo(kit.ctx, 'x3');
    dismissProposal(kit.ctx, FOLDER, proposal!);
    expect(listProposals(kit.ctx, FOLDER)).toEqual([]);
    expect(() => dismissProposal(kit.ctx, FOLDER, proposal!)).toThrow(/đã được xử lý/);
    expect(() => createFormula(kit.ctx, FOLDER, { name: 'ab', moDau: 'cau-hoi', cauTruc: 'danh-sach' })).toThrow(/3 đến 120/);
    expect(() => createFormula(kit.ctx, FOLDER, { name: 'Tên được', moDau: 'thieu-du-lieu', cauTruc: 'danh-sach' })).toThrow(/mở đầu/);
  });

  it('an agent principal cannot write cong-thuc/**, whatever its grants say (case does not help)', () => {
    createFormula(kit.ctx, FOLDER, { name: 'Có sẵn', moDau: 'con-so', cauTruc: 'danh-sach' });
    const agent = kit.notes.forAgent('bot-noi-dung'); // canWrite returns true for everything in this kit
    const data = { loai: 'cong-thuc', trang_thai: 'hop', da_lam: 40, ket_qua: 3.2 };
    expect(() => agent.create({ folderId: FOLDER, relPath: 'cong-thuc/tu-tao.md' }, data, '# x\n', { message: 'x' })).toThrow(NoteAccessError);
    expect(() => agent.create({ folderId: FOLDER, relPath: 'Cong-Thuc/tu-tao.md' }, data, '# x\n', { message: 'x' })).toThrow(NoteAccessError);
    expect(() => agent.patch({ folderId: FOLDER, relPath: 'cong-thuc/co-san.md' }, { trang_thai: 'hop' }, { message: 'x', overwrite: true })).toThrow(NoteAccessError);
    expect(() => agent.write({ folderId: FOLDER, relPath: 'cong-thuc/co-san.md' }, '---\nloai: cong-thuc\ntrang_thai: hop\n---\n', { message: 'x', overwrite: true })).toThrow(NoteAccessError);
    expect(() => agent.remove({ folderId: FOLDER, relPath: 'cong-thuc/co-san.md' }, { message: 'x', overwrite: true })).toThrow(NoteAccessError);
    expect(() => kit.ctx.brain.notes.asAgent('bot-noi-dung').setBlock({ folderId: FOLDER, relPath: 'cong-thuc/co-san.md' }, 'doi-chieu', 'x', { message: 'x', overwrite: true })).toThrow(NoteAccessError);
    // the same agent still writes where its grants allow
    agent.create({ folderId: FOLDER, relPath: 'noi-dung/nhap.md' }, {}, '# nháp\n', { message: 'x' });
    expect(kit.read('cong-thuc/co-san.md')).toContain('trang_thai: chua-thu');
    // and no agent action exists for formulas
    expect(dream.actions).toBeUndefined();
  });
});
