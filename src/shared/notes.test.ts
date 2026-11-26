import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAccessPolicy } from '../access/policy.js';
import type { ConnectionsService } from '../access/contracts.js';
import type { SkillLibrary } from './contracts.js';
import { parseFrontmatter } from './frontmatter.js';
import { createNotesService, NoteAccessError, NoteConflictError, NoteInputError, NoteSchemaError, type NotesService } from './notes.js';
import { sampleBrain, tempRegistry, testLog, tmpDir, writeFile } from './test-kit.js';

const KH = { loai: 'khach-hang', id: 'cus_01', ten: 'Chị Lan', giai_doan: 'dang-tu-van', the: ['hoi-si'] };
const BODY = '# Chị Lan\n\nGhi chú tay của chủ: "đừng gọi sau 9 giờ".\n';

let notes: NotesService;
let sb: ReturnType<typeof sampleBrain>;
let folderPath: string;

beforeEach(() => {
  sb = sampleBrain();
  folderPath = path.join(sb.root, 'brain', 'cong-ty-b');
  const reg = tempRegistry();
  const agents = reg.registry();
  const access = { brain: { 'cong-ty-b': { read: ['**'], write: ['khach-hang/**'] } }, memory: { team: true, private: true }, skills: [], connections: {}, modules: {} };
  agents.create('bot-cham', { name: 'Bot chăm', runtime: 'mock', access });
  const policy = createAccessPolicy({
    agents,
    brain: sb.brain,
    connections: { get: () => undefined, resolveEnv: () => ({}) } as unknown as ConnectionsService,
    skills: { resolve: () => [] } as unknown as SkillLibrary,
    isModuleEnabled: () => true,
  });
  notes = createNotesService({ brain: sb.brain, canWrite: policy.canWritePath, log: testLog });
});

const ref = (relPath: string) => ({ folderId: 'cong-ty-b', relPath });

describe('NotesService', () => {
  it('creates, reads, lists and patches a note, keeping the body', async () => {
    const created = notes.create(ref('khach-hang/chi-lan.md'), KH, BODY, { actor: 'system', message: 'tạo khách' });
    expect(created.data).toEqual(KH);
    const r = notes.read(ref('khach-hang/chi-lan.md'))!;
    expect(r).toMatchObject({ data: KH, body: BODY, mtimeMs: created.mtimeMs });
    expect(notes.list('cong-ty-b', 'khach-hang', { loai: 'khach-hang' }).map((n) => n.relPath)).toEqual(['khach-hang/chi-lan.md']);
    expect(notes.list('cong-ty-b', '', { loai: 'bai-hoc' })).toEqual([]);

    const p = notes.patch(ref('khach-hang/chi-lan.md'), { giai_doan: 'da-bao-gia', gia_tri: 14352000 }, { actor: 'bot-cham', message: 'báo giá', expectMtimeMs: r.mtimeMs });
    expect(p.data).toMatchObject({ giai_doan: 'da-bao-gia', gia_tri: 14352000, ten: 'Chị Lan' });
    const text = fs.readFileSync(path.join(folderPath, 'khach-hang', 'chi-lan.md'), 'utf8');
    expect(parseFrontmatter(text).body).toBe(BODY);
    // the write was indexed
    expect(sb.brain.search('đừng gọi sau', { folders: ['cong-ty-b'] }).map((h) => h.path)).toContain('khach-hang/chi-lan.md');
    expect(notes.read(ref('khach-hang/khong-co.md'))).toBeUndefined();
  });

  it('refuses a stale expectMtimeMs without writing', () => {
    const c = notes.create(ref('khach-hang/chi-lan.md'), KH, BODY, { actor: 'system', message: 'x' });
    const file = path.join(folderPath, 'khach-hang', 'chi-lan.md');
    const before = fs.readFileSync(file, 'utf8');
    expect(() => notes.patch(ref('khach-hang/chi-lan.md'), { hang: 'A' }, { actor: 'system', message: 'x', expectMtimeMs: c.mtimeMs - 5000 })).toThrow(NoteConflictError);
    expect(() => notes.write(ref('khach-hang/chi-lan.md'), 'mới', { actor: 'owner', message: 'x', expectMtimeMs: c.mtimeMs + 5000 })).toThrow(NoteConflictError);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(() => notes.create(ref('khach-hang/chi-lan.md'), KH, '', { actor: 'system', message: 'x' })).toThrow(NoteConflictError);
  });

  it('refuses data that breaks the schema of its loai, and writes nothing', () => {
    notes.create(ref('khach-hang/chi-lan.md'), KH, BODY, { actor: 'system', message: 'x' });
    const file = path.join(folderPath, 'khach-hang', 'chi-lan.md');
    const before = fs.readFileSync(file, 'utf8');
    const err = (() => {
      try {
        notes.patch(ref('khach-hang/chi-lan.md'), { giai_doan: 'dang-ngu', hang: 'Z' }, { actor: 'system', message: 'x' });
      } catch (e) {
        return e;
      }
    })() as NoteSchemaError;
    expect(err).toBeInstanceOf(NoteSchemaError);
    expect(err.issues.join('\n')).toMatch(/giai_doan/);
    expect(err.issues.join('\n')).toMatch(/hang/);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(() => notes.create(ref('khach-hang/x.md'), { loai: 'khach-hang', ten: 'Thiếu id' }, '', { actor: 'system', message: 'x' })).toThrow(NoteSchemaError);
    expect(fs.existsSync(path.join(folderPath, 'khach-hang', 'x.md'))).toBe(false);
    // machines cannot sneak a bad note in through a whole-file write; the owner can (like in Obsidian)
    expect(() => notes.write(ref('bai-hoc/a.md'), '---\nloai: bai-hoc\n---\n', { actor: 'system', message: 'x' })).toThrow(NoteSchemaError);
    expect(notes.write(ref('bai-hoc/a.md'), '---\nloai: bai-hoc\n---\n', { actor: 'owner', message: 'x' }).data).toEqual({ loai: 'bai-hoc' });
  });

  it('keeps unknown keys the owner added, and does not check an unknown loai', () => {
    writeFile(path.join(folderPath, 'khach-hang', 'anh-minh.md'), '---\nloai: khach-hang\nid: cus_02\nten: Anh Minh\nsinh_nhat: 12/3\n---\nthân\n');
    const p = notes.patch(ref('khach-hang/anh-minh.md'), { hang: 'B' }, { actor: 'system', message: 'x' });
    expect(p.data).toMatchObject({ sinh_nhat: '12/3', hang: 'B' });
    expect(notes.create(ref('y/rieng.md'), { loai: 'cua-toi', bat_ky: 1 }, '', { actor: 'system', message: 'x' }).data).toEqual({ loai: 'cua-toi', bat_ky: 1 });
  });

  it('checks the write grant of an agent', () => {
    expect(() => notes.create(ref('chinh-sach/moi.md'), { loai: 'bai-hoc', mang: 'noi-dung', trang_thai: 'gia-thuyet' }, '', { actor: 'bot-cham', message: 'x' })).toThrow(NoteAccessError);
    expect(() => notes.create(ref('khach-hang/a.md'), KH, '', { actor: 'khong-co-agent', message: 'x' })).toThrow(NoteAccessError);
    expect(() => notes.write(ref('danh-muc-tra-sen.md'), 'xoá', { actor: 'bot-cham', message: 'x' })).toThrow(NoteAccessError);
    expect(fs.existsSync(path.join(folderPath, 'chinh-sach', 'moi.md'))).toBe(false);
    expect(notes.create(ref('khach-hang/a.md'), KH, '', { actor: 'bot-cham', message: 'x' }).relPath).toBe('khach-hang/a.md');
    // module code is trusted like the system
    expect(notes.create(ref('chinh-sach/tu-module.md'), { loai: 'tong-ket' }, '', { actor: 'module:learn', message: 'x' }).data).toEqual({ loai: 'tong-ket' });
  });

  it('refuses paths that leave the folder, absolute paths, symlinks and non-markdown', () => {
    const opts = { actor: 'owner', message: 'x' };
    for (const bad of ['../x.md', 'khach-hang/../../x.md', '/etc/x.md', 'C:/x.md', '', 'a.txt', '.git/x.md', '.obsidian/a.md']) {
      expect(() => notes.write(ref(bad), 'x', opts), bad).toThrow(NoteInputError);
    }
    expect(fs.existsSync(path.join(sb.root, 'brain', 'x.md'))).toBe(false);
    const outside = tmpDir();
    fs.symlinkSync(outside, path.join(folderPath, 'link'));
    fs.symlinkSync(path.join(folderPath, 'danh-muc-tra-sen.md'), path.join(folderPath, 'alias.md'));
    expect(() => notes.write(ref('link/x.md'), 'x', opts)).toThrow(NoteInputError);
    expect(() => notes.write(ref('alias.md'), 'x', opts)).toThrow(NoteInputError);
    expect(() => notes.read(ref('link/x.md'))).toThrow(NoteInputError);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(notes.list('cong-ty-b', 'link')).toEqual([]);
    expect(() => notes.write({ folderId: 'khong-co', relPath: 'a.md' }, 'x', opts)).toThrow(NoteInputError);
    expect(() => notes.write(ref('to.md'), 'x'.repeat(1024 * 1024 + 1), opts)).toThrow(NoteInputError);
  });
});
