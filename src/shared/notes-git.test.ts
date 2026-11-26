// NotesService with a git-backed brain folder: commits, batch, history, revert, events.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppEvent } from '../core/events.js';
import { createBrainGit, createCommitQueue } from './brain-git.js';
import { createNotes, NoteInputError, type BrainChanged, type Notes } from './notes.js';
import { sampleBrain, testBus, testLog } from './test-kit.js';

const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const count = (dir: string) => Number(git(dir, 'rev-list', '--count', 'HEAD'));

const KH = { loai: 'khach-hang', id: 'cus_01', ten: 'Chị Lan', giai_doan: 'moi' };
const ref = (relPath: string) => ({ folderId: 'cong-ty-b', relPath });

let notes: Notes;
let sb: ReturnType<typeof sampleBrain>;
let repo: string;
let events: BrainChanged[];

beforeEach(() => {
  sb = sampleBrain();
  repo = path.join(sb.root, 'brain', 'cong-ty-b');
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'Chủ shop');
  git(repo, 'config', 'user.email', 'chu@example.test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'khởi tạo');
  const bus = testBus();
  events = [];
  bus.on('custom', (e: Extract<AppEvent, { type: 'custom' }>) => {
    if (e.name === 'brain:changed') events.push(e.payload as BrainChanged);
  });
  const brainGit = createBrainGit();
  notes = createNotes({
    brain: sb.brain, bus, log: testLog, git: brainGit,
    commits: createCommitQueue({ git: brainGit, log: testLog, windowMs: 60_000 }),
    canRead: () => true, canWrite: () => true,
  });
});

describe('notes + git', () => {
  it('one write through the service makes exactly one commit, signed by the principal', async () => {
    notes.forModule('crm').create(ref('khach-hang/chi-lan.md'), KH, '# Chị Lan\n', { message: 'Khách mới: Chị Lan' });
    await notes.flush();
    expect(count(repo)).toBe(2);
    expect(git(repo, 'log', '-1', '--format=%an|%s')).toBe('module:crm|Khách mới: Chị Lan');
    expect(git(repo, 'show', '--name-only', '--format=', 'HEAD')).toBe('khach-hang/chi-lan.md');
    expect(events).toEqual([{ folderId: 'cong-ty-b', paths: ['khach-hang/chi-lan.md'], by: 'module:crm' }]);
    await notes.flush();
    expect(count(repo)).toBe(2); // flushing again commits nothing
  });

  it('writes in the same window share one commit; batch() makes one commit and one event', async () => {
    const m = notes.forModule('learn');
    let n = m.create(ref('khach-hang/a.md'), { ...KH, id: 'a' }, '', { message: 'a' });
    n = m.patch(ref('khach-hang/a.md'), { hang: 'A' }, { message: 'xếp hạng a', expectHash: n.hash });
    m.create(ref('khach-hang/b.md'), { ...KH, id: 'b' }, '', { message: 'b' });
    await notes.flush();
    expect(count(repo)).toBe(2);
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('AIOS ghi 2 ghi chú');

    events.length = 0;
    const out = await m.batch('Cập nhật số liệu tuần 48', async (b) => {
      for (const id of ['c', 'd', 'e']) {
        b.create(ref(`khach-hang/${id}.md`), { ...KH, id }, '', { message: `tạo ${id}` });
        await new Promise((r) => setTimeout(r, 5));
      }
      return 'xong';
    });
    expect(out).toBe('xong');
    await notes.flush();
    expect(count(repo)).toBe(3);
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('Cập nhật số liệu tuần 48');
    expect(git(repo, 'show', '--name-only', '--format=', 'HEAD').split('\n')).toEqual(['khach-hang/c.md', 'khach-hang/d.md', 'khach-hang/e.md']);
    expect(events).toEqual([{ folderId: 'cong-ty-b', paths: ['khach-hang/c.md', 'khach-hang/d.md', 'khach-hang/e.md'], by: 'module:learn' }]);
  });

  it('a batch that throws still commits what it wrote', async () => {
    await expect(
      notes.forModule('crm').batch('lô lỗi', (b) => {
        b.create(ref('khach-hang/x.md'), { ...KH, id: 'x' }, '', { message: 'x' });
        throw new Error('hỏng giữa chừng');
      }),
    ).rejects.toThrow('hỏng giữa chừng');
    await notes.flush();
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('lô lỗi');
  });

  it('history lists commits and revert puts the file back through a new commit', async () => {
    const m = notes.forModule('crm');
    const c = m.create(ref('khach-hang/chi-lan.md'), KH, '# Chị Lan\n', { message: 'tạo' });
    await notes.flush();
    m.patch(ref('khach-hang/chi-lan.md'), { giai_doan: 'mat' }, { message: 'đánh dấu mất', expectHash: c.hash });
    await notes.flush();
    const h = m.history(ref('khach-hang/chi-lan.md'));
    expect(h.map((x) => x.message)).toEqual(['đánh dấu mất', 'tạo']);
    const before = fs.readFileSync(path.join(repo, 'khach-hang/chi-lan.md'), 'utf8');
    expect(before).toContain('giai_doan: mat');

    events.length = 0;
    const r = notes.owner().revert(ref('khach-hang/chi-lan.md'), h[0]!.hash);
    expect(r.data).toMatchObject({ giai_doan: 'moi' });
    expect(fs.readFileSync(path.join(repo, 'khach-hang/chi-lan.md'), 'utf8')).toBe(git(repo, 'show', `${h[1]!.hash}:khach-hang/chi-lan.md`) + '\n');
    expect(events).toEqual([{ folderId: 'cong-ty-b', paths: ['khach-hang/chi-lan.md'], by: 'owner' }]);
    await notes.flush();
    expect(count(repo)).toBe(4);
    expect(git(repo, 'log', '-1', '--format=%an|%s')).toBe(`owner|Hoàn tác khach-hang/chi-lan.md về trước ${h[0]!.hash.slice(0, 7)}`);
    // a note that did not exist before the commit has nothing to go back to
    expect(() => m.revert(ref('khach-hang/chi-lan.md'), h[1]!.hash)).toThrow(NoteInputError);
    expect(() => m.revert(ref('khach-hang/chi-lan.md'), 'not-a-hash')).toThrow(NoteInputError);
  });

  it('a folder that is not a git repo: writes work, nothing is committed, history is empty', async () => {
    const m = notes.forModule('crm');
    m.create({ folderId: 'cong-ty-a', relPath: 'khach-hang/a.md' }, KH, '', { message: 'x' });
    await notes.flush();
    expect(fs.existsSync(path.join(sb.root, 'brain', 'cong-ty-a', '.git'))).toBe(false);
    expect(m.history({ folderId: 'cong-ty-a', relPath: 'khach-hang/a.md' })).toEqual([]);
  });

  it('backlinks come from the index, filtered to what the principal may read', () => {
    const m = notes.forModule('crm');
    m.create(ref('khach-hang/chi-lan.md'), KH, '', { message: 'x' });
    m.create(ref('ghi-chu/hen.md'), {}, 'Hẹn gặp [[chi-lan|chị Lan]] thứ Sáu.', { message: 'x' });
    expect(m.backlinks(ref('khach-hang/chi-lan.md'))).toEqual([ref('ghi-chu/hen.md')]);
  });
});
