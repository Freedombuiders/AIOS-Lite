// The lesson state machine against the real notes service: who may move what, evidence that must exist, the
// machine pass (third evidence, trials, the 5 latest posts), proposals in Chờ duyệt.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPlaybook, LessonError, MACHINE, type Playbook } from './playbook.js';
import { makeKit, writeLesson, writePost, type Kit } from './test-kit.js';

const NOW = Date.UTC(2026, 10, 26, 3, 0, 0) / 1000;
const OWNER = { kind: 'owner' } as const;
const AGENT = { kind: 'agent', id: 'noi-dung' } as const;

let kit: Kit;
let pb: Playbook;
let trialPosts = 4;

beforeEach(() => {
  kit = makeKit();
  trialPosts = 4;
  pb = createPlaybook({
    db: kit.db, notes: kit.notes, folder: () => 'b1', trialPosts: () => trialPosts, moc: () => '24h',
    attention: kit.attention, audit: kit.audit, log: kit.log, now: () => NOW,
  });
});
afterEach(() => kit.cleanup());

const ref = (relPath: string) => ({ folderId: 'b1', relPath });
const stateOf = (relPath: string) => kit.notes.read(ref(relPath))!.data.trang_thai;

async function rejects(fn: () => unknown, code: string) {
  let err: unknown;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(LessonError);
  expect((err as LessonError).code).toBe(code);
}

describe('transition', () => {
  it('rejects an agent principal moving a lesson to da-kiem-chung (required)', async () => {
    const p = writeLesson(kit, 'video-ngan', { trang_thai: 'dang-thu' });
    await rejects(() => pb.transition(ref(p), 'da-kiem-chung', AGENT), 'forbidden');
    expect(stateOf(p)).toBe('dang-thu');
    // the machine cannot either; the owner can
    await rejects(() => pb.transition(ref(p), 'da-kiem-chung', MACHINE), 'forbidden');
    expect(pb.transition(ref(p), 'da-kiem-chung', OWNER)).toMatchObject({ from: 'dang-thu', to: 'da-kiem-chung', changed: true });
    expect(stateOf(p)).toBe('da-kiem-chung');
    expect(pb.get(p)!.ownerVerified).toBe(true);
    expect(kit.audit.entries.at(-1)).toMatchObject({ action: 'lesson.transition', actor: 'owner' });
  });

  it('agents change no state at all, whatever the edge', async () => {
    const p = writeLesson(kit, 'gia', { trang_thai: 'gia-thuyet' });
    for (const to of ['dang-thu', 'bi-bac-bo', 'gia-thuyet'] as const) await rejects(() => pb.transition(ref(p), to, AGENT), 'forbidden');
    await rejects(() => pb.transition(ref(p), 'dang-thu', { kind: 'module', id: 'marketing' }), 'forbidden');
    expect(stateOf(p)).toBe('gia-thuyet');
  });

  it('needs 3 evidence links to notes that exist; dead links and other platforms do not count', async () => {
    writePost(kit, 'a', 5);
    writePost(kit, 'b', 6);
    writePost(kit, 'yt', 6, { nen_tang: 'youtube' });
    const p = writeLesson(kit, 'l', { bang_chung: ['[[a]]', '[[b]]', '[[khong-con]]', '[[yt]]', '[[a]]'] });
    expect(pb.get(p)!.liveEvidence).toBe(2);
    await rejects(() => pb.transition(ref(p), 'dang-thu', OWNER), 'bad_request');
    expect(pb.evaluate().moved).toEqual([]);
    expect(stateOf(p)).toBe('gia-thuyet');
  });

  it('refuses edges that are not in the diagram', async () => {
    const p = writeLesson(kit, 'l', { trang_thai: 'gia-thuyet' });
    await rejects(() => pb.transition(ref(p), 'da-kiem-chung', OWNER), 'bad_request');
    await rejects(() => pb.transition({ folderId: 'b1', relPath: 'khac/x.md' }, 'bi-bac-bo', OWNER), 'bad_request');
  });
});

describe('the machine pass', () => {
  it('the third evidence moves gia-thuyet to dang-thu and raises attention', () => {
    writePost(kit, 'a', 5);
    writePost(kit, 'b', 6);
    writePost(kit, 'c', 7);
    const p = writeLesson(kit, 'l', { bang_chung: ['[[a]]', '[[b]]'] });
    expect(pb.evaluate().moved).toEqual([]);
    expect(kit.attention.raised).toEqual([]);

    const note = kit.owner.read(ref(p))!;
    kit.owner.patch(ref(p), { bang_chung: ['[[a]]', '[[b]]', '[[noi-dung/bai/c]]'] }, { message: 'thêm', expectHash: note.hash });
    expect(pb.evaluate().moved).toEqual([{ path: p, from: 'gia-thuyet', to: 'dang-thu' }]);
    expect(stateOf(p)).toBe('dang-thu');
    expect(kit.notes.read(ref(p))!.data.thu_tu).toBeTruthy();
    expect(kit.attention.raised).toEqual([expect.objectContaining({ key: `lesson:${p}`, title: expect.stringContaining('Đang thử') })]);
    expect(pb.changes(NOW - 10, NOW + 10)).toEqual([expect.objectContaining({ path: p, from: 'gia-thuyet', to: 'dang-thu', actor: 'module:learn' })]);
    // nothing more to do on the next pass
    expect(pb.evaluate().moved).toEqual([]);
  });

  it('a lesson on trial is proposed for verification, labelled thăm dò, and only the owner accepts it', () => {
    for (const [s, er] of [['k1', 3], ['k2', 3.5], ['k3', 4], ['k4', 2.5]] as const) writePost(kit, s, er, { dinh_dang: 'anh' });
    for (const [s, er] of [['t1', 6], ['t2', 7], ['t3', 6.5], ['t4', 8]] as const) writePost(kit, s, er);
    const p = writeLesson(kit, 'l', { trang_thai: 'dang-thu', bai_thu: ['[[t1]]', '[[t2]]', '[[t3]]', '[[t4]]', '[[mat-roi]]'] });
    const v = pb.get(p)!;
    expect(v.trial).toMatchObject({ measured: 4, threshold: 4, medianEr: 6.75, channelMedian: 3.25, label: 'thăm dò', verdict: 'dat' });
    expect(v.trial!.label).not.toMatch(/chứng minh/);

    expect(pb.evaluate().proposed).toBe(1);
    expect(pb.evaluate().proposed).toBe(0); // one open proposal, not two
    expect(stateOf(p)).toBe('dang-thu'); // proposing changes nothing
    const [prop] = pb.proposals();
    expect(prop).toMatchObject({ kind: 'transition', path: p, from: 'dang-thu', to: 'da-kiem-chung' });
    expect(prop!.reason).toMatch(/thăm dò/);
    expect(() => pb.accept(prop!.id, AGENT)).toThrow(LessonError);
    pb.accept(prop!.id, OWNER);
    expect(stateOf(p)).toBe('da-kiem-chung');
    expect(pb.proposals()).toEqual([]);
  });

  it('a failed trial is proposed for rejection; a dismissed proposal comes back only with more posts', () => {
    for (const [s, er] of [['k1', 5], ['k2', 6], ['k3', 5.5]] as const) writePost(kit, s, er, { dinh_dang: 'anh' });
    for (const [s, er] of [['t1', 3], ['t2', 4], ['t3', 2], ['t4', 3]] as const) writePost(kit, s, er);
    const p = writeLesson(kit, 'l', { trang_thai: 'dang-thu', bai_thu: ['[[t1]]', '[[t2]]', '[[t3]]', '[[t4]]'] });
    expect(pb.evaluate().proposed).toBe(1);
    const [prop] = pb.proposals();
    expect(prop!.to).toBe('bi-bac-bo');
    pb.dismiss(prop!.id, OWNER);
    expect(pb.evaluate().proposed).toBe(0);
    writePost(kit, 't5', 2);
    const note = kit.notes.read(ref(p))!;
    kit.notes.patch(ref(p), { bai_thu: [...(note.data.bai_thu as string[]), '[[t5]]'] }, { message: 'x', expectHash: note.hash });
    expect(pb.evaluate().proposed).toBe(1);
  });

  it('trial posts can come from the lesson rules instead of links, from the day the trial started', () => {
    writePost(kit, 'cu', 9, { dang_luc: '2026-10-01T19:00:00+07:00' });
    writePost(kit, 'k1', 3, { dinh_dang: 'anh' });
    writePost(kit, 'sai-gio', 9, { dang_luc: '2026-11-21T10:00:00+07:00' });
    writePost(kit, 'dung', 6, { dang_luc: '2026-11-21T19:30:00+07:00' });
    const p = writeLesson(kit, 'l', { trang_thai: 'dang-thu', thu_tu: '2026-11-15T00:00:00Z', ap_dung: { dinh_dang: ['video-ngan'], gio_dang: '19-21' } });
    const t = pb.get(p)!.trial!;
    expect(t.posts).toBe(1);
    expect(t.recent.map((r) => r.title)).toEqual(['dung']);
    expect(t.label).toBe('ít mẫu');
  });

  it('a verified lesson whose 5 latest following posts are all below the median goes back to dang-thu', () => {
    for (const [s, er] of [['k1', 5], ['k2', 6], ['k3', 5.5], ['k4', 6]] as const) writePost(kit, s, er, { dinh_dang: 'anh' });
    const links: string[] = [];
    for (let i = 1; i <= 5; i++) {
      writePost(kit, `f${i}`, 2 + i / 10, { dang_luc: `2026-11-${10 + i}T19:00:00+07:00` });
      links.push(`[[f${i}]]`);
    }
    const p = writeLesson(kit, 'l', { trang_thai: 'dang-thu', bai_thu: links });
    pb.transition(ref(p), 'da-kiem-chung', OWNER);
    expect(pb.get(p)!.trial).toMatchObject({ measured: 5, verdict: 'giam' });
    expect(pb.evaluate().moved).toEqual([{ path: p, from: 'da-kiem-chung', to: 'dang-thu' }]);
    expect(kit.attention.raised.at(-1)!.title).toMatch(/quay về Đang thử/);
  });

  it('a verified lesson with one of the 5 latest above the median stays', () => {
    for (const [s, er] of [['k1', 5], ['k2', 6], ['k3', 5.5]] as const) writePost(kit, s, er, { dinh_dang: 'anh' });
    const links: string[] = [];
    for (let i = 1; i <= 5; i++) {
      writePost(kit, `f${i}`, i === 3 ? 9 : 2, { dang_luc: `2026-11-${10 + i}T19:00:00+07:00` });
      links.push(`[[f${i}]]`);
    }
    const p = writeLesson(kit, 'l', { trang_thai: 'dang-thu', bai_thu: links });
    pb.transition(ref(p), 'da-kiem-chung', OWNER);
    expect(pb.evaluate().moved).toEqual([]);
    expect(stateOf(p)).toBe('da-kiem-chung');
  });
});

describe('agents propose', () => {
  it('a proposal is a new gia-thuyet nobody uses yet, whatever the payload says', () => {
    const r = pb.propose('noi-dung', { tieu_de: 'Bài hỏi đáp kéo tin Zalo', mang: 'noi-dung', noi_dung: 'Thấy ở 2 bài.', trang_thai: 'da-kiem-chung', dung_boi: ['noi-dung'], bang_chung: ['noi-dung/bai/a.md', 'rác ]]'] });
    const note = kit.notes.read(ref(r.path))!;
    expect(note.data).toMatchObject({ loai: 'bai-hoc', trang_thai: 'gia-thuyet', dung_boi: [], de_xuat_boi: 'noi-dung', bang_chung: ['[[a]]'] });
    expect(pb.proposals()).toEqual([expect.objectContaining({ kind: 'new', path: r.path, proposedBy: 'agent:noi-dung' })]);
    expect(kit.attention.raised.at(-1)!.title).toMatch(/đề xuất bài học mới/);
    // the owner drops it: kept as bi-bac-bo so it is not proposed again
    pb.dismiss(r.proposalId, OWNER);
    expect(note && kit.notes.read(ref(r.path))!.data.trang_thai).toBe('bi-bac-bo');
  });

  it('a da-kiem-chung written by hand is not trusted until the owner confirms it in the app', () => {
    const p = writeLesson(kit, 'tay', { trang_thai: 'da-kiem-chung', dung_boi: ['noi-dung'] });
    expect(pb.verified()).toEqual([]);
    expect(pb.transition(ref(p), 'da-kiem-chung', OWNER).changed).toBe(true);
    expect(pb.verified().map((l) => l.path)).toEqual([p]);
  });
});
