// Weekly review: written once per week (a restart after a missed Monday catches up exactly once), numbers from
// code, words from one lean run, and an owner-only approval that creates the chosen tasks.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LeanRunInput, LeanRunResult } from '../../../src/modules/sdk.js';
import { isoWeekOf, lastCompleteWeek, weekRange } from './metrics.js';
import { createPlaybook } from './playbook.js';
import { makeKit, writeLesson, writePost, type Kit } from './test-kit.js';
import { createWeekly, weeklyPath, type WeeklyDeps } from './weekly.js';

// Wednesday 25/11/2026 10:00 in Vietnam: the Monday 23/11 timer was missed (machine off)
const NOW = Date.UTC(2026, 10, 25, 3, 0, 0) / 1000;

let kit: Kit;
let runLean: ReturnType<typeof vi.fn<(i: LeanRunInput) => Promise<LeanRunResult>>>;
let created: Array<{ title?: string; agentId?: string; prompt: string }>;

beforeEach(() => {
  kit = makeKit();
  created = [];
  runLean = vi.fn(async (_i: LeanRunInput) => ({
    ok: true, taskId: 1, runId: 1,
    output: 'Đây: ```json\n{"duoc":["Video ướp trà cao hơn trung vị"],"hong":["Bài chữ thứ Bảy thấp"],"de_xuat":[{"viec":"Làm 2 video hướng dẫn ngắn","ly_do":"Theo bài học đã kiểm chứng"}]}\n```',
  }));
});
afterEach(() => kit.cleanup());

function makeWeekly(over: Partial<WeeklyDeps> = {}) {
  const playbook = createPlaybook({ db: kit.db, notes: kit.notes, folder: () => 'b1', trialPosts: () => 4, moc: () => '24h', attention: kit.attention, audit: kit.audit, log: kit.log, now: () => NOW });
  return createWeekly({
    db: kit.db, notes: kit.notes, folder: () => 'b1', moc: () => '24h', agentId: () => 'tro-ly', canUse: (id) => id === 'tro-ly' || id === 'noi-dung',
    runLean: runLean as unknown as WeeklyDeps['runLean'],
    tasks: { create: (input) => { created.push(input); return { id: 100 + created.length } as never; } },
    playbook, drafts: () => () => ({ botDrafts: 20, sentUnchanged: 15, sentEdited: 3, discarded: 1, notDelivered: 0, open: 1, unchangedRate: 15 / 19 }),
    log: kit.log, audit: kit.audit, now: () => NOW, ...over,
  });
}

describe('weeks', () => {
  it('ISO weeks and the last complete week, Vietnam time', () => {
    expect(isoWeekOf('2026-11-16')).toEqual({ year: 2026, week: 47 });
    expect(isoWeekOf('2027-01-01')).toEqual({ year: 2026, week: 53 });
    const w = lastCompleteWeek(NOW);
    expect(w).toMatchObject({ year: 2026, week: 47, from: '2026-11-16', to: '2026-11-22' });
    // Monday 00:00 in Vietnam is Sunday 17:00 UTC
    expect(new Date(weekRange({ year: 2026, week: 47 }).startSec * 1000).toISOString()).toBe('2026-11-15T17:00:00.000Z');
  });
});

describe('the weekly note', () => {
  it('a restart after a missed Monday writes last week once, with one agent run', async () => {
    writePost(kit, 'video', 6.3, { dang_luc: '2026-11-18T19:00:00+07:00' });
    writePost(kit, 'chu', 2.1, { dang_luc: '2026-11-21T10:00:00+07:00', dinh_dang: 'chu' });
    writePost(kit, 'cu', 4, { dang_luc: '2026-11-10T19:00:00+07:00' });
    writePost(kit, 'cu2', 3.8, { dang_luc: '2026-11-11T19:00:00+07:00' });
    const weekly = makeWeekly();
    // start() and the Monday timer racing
    const [a, b] = await Promise.all([weekly.catchUp(), weekly.catchUp()]);
    expect(a).toEqual({ created: true, path: 'tong-ket/2026-tuan-47.md' });
    expect(b).toEqual(a);
    expect(runLean).toHaveBeenCalledTimes(1);
    expect(runLean.mock.calls[0]![0].moduleContext).toMatch(/<<<BEGIN so-lieu-tuan>>>/);

    // another restart: nothing new
    expect(await makeWeekly().catchUp()).toEqual({ created: false, path: 'tong-ket/2026-tuan-47.md' });
    expect(runLean).toHaveBeenCalledTimes(1);
    expect((kit.db.prepare('SELECT COUNT(*) AS n FROM learn_weekly').get() as { n: number }).n).toBe(1);

    const note = kit.notes.read({ folderId: 'b1', relPath: weeklyPath({ year: 2026, week: 47 }) })!;
    expect(note.data).toMatchObject({ loai: 'tong-ket', nam: 2026, tuan: 47, tu: '2026-11-16', den: '2026-11-22', da_duyet: false, nguoi_viet: 'tro-ly' });
    expect(note.data.so_lieu).toMatchObject({ bai_dang: 2, er_trung_vi: 4.2, er_tuan_truoc: 3.9, nhap_gui_nguyen: 15, nhap_da_xu_ly: 19 });
    expect(note.body).toContain('# Tuần 47 · 16/11 đến 22/11');
    expect(note.body).toContain('- Video ướp trà cao hơn trung vị');
    expect(note.body).toContain('- [ ] Làm 2 video hướng dẫn ngắn — Theo bài học đã kiểm chứng');
  });

  it('a note left by a pass that stopped before remembering it is not written again', async () => {
    kit.notes.create({ folderId: 'b1', relPath: 'tong-ket/2026-tuan-47.md' }, { loai: 'tong-ket' }, '# cũ\n', { message: 'x' });
    expect(await makeWeekly().catchUp()).toEqual({ created: false, path: 'tong-ket/2026-tuan-47.md' });
    expect(runLean).not.toHaveBeenCalled();
  });

  it('without an agent the numbers are still written', async () => {
    const weekly = makeWeekly({ agentId: () => '' });
    await weekly.catchUp();
    const note = kit.notes.read({ folderId: 'b1', relPath: 'tong-ket/2026-tuan-47.md' })!;
    expect(runLean).not.toHaveBeenCalled();
    expect(note.body).toMatch(/Chưa chọn agent viết phần lời/);
    expect(note.body).toMatch(/Bài đã đăng: 0/);
  });

  it('plan lines from lessons on trial come from code', async () => {
    writeLesson(kit, 'cau-hoi', { trang_thai: 'dang-thu', dung_boi: ['noi-dung'], tieu_de: 'Mở đầu bằng câu hỏi' });
    await makeWeekly().catchUp();
    const w = makeWeekly().get(2026, 47)!;
    expect(w.plan[0]).toEqual({ viec: 'Làm 4 bài thử theo bài học "Mở đầu bằng câu hỏi"', ly_do: 'Đang thử: 0/4 bài đã đo ở mốc 24 giờ.', agent: 'noi-dung' });
    expect(w.plan[1]).toMatchObject({ viec: 'Làm 2 video hướng dẫn ngắn', agent: 'tro-ly' });
  });
});

describe('approving the plan', () => {
  it('creates exactly the chosen tasks, once, for the owner only', async () => {
    writeLesson(kit, 'cau-hoi', { trang_thai: 'dang-thu', dung_boi: ['noi-dung'], tieu_de: 'Mở đầu bằng câu hỏi' });
    const weekly = makeWeekly();
    await weekly.catchUp();
    expect(() => weekly.approve(2026, 47, [0], { kind: 'agent', id: 'tro-ly' })).toThrow(/Chỉ chủ/);
    expect(created).toEqual([]);

    const r = weekly.approve(2026, 47, [1, 0, 1, 9], { kind: 'owner' });
    expect(r.tasks).toEqual([{ line: 0, taskId: 101 }, { line: 1, taskId: 102 }]);
    expect(created.map((t) => [t.title, t.agentId])).toEqual([['Làm 4 bài thử theo bài học "Mở đầu bằng câu hỏi"', 'noi-dung'], ['Làm 2 video hướng dẫn ngắn', 'tro-ly']]);
    expect(() => weekly.approve(2026, 47, [0], { kind: 'owner' })).toThrow(/đã được duyệt/);
    expect(created).toHaveLength(2);

    const w = weekly.get(2026, 47)!;
    expect(w.approved).toBe(true);
    expect(w.tasks).toEqual(r.tasks);
    expect(w.body).toContain('- [x] Làm 4 bài thử');
    expect(weekly.list()).toEqual([expect.objectContaining({ year: 2026, week: 47, approved: true, posts: 0 })]);
  });
});
