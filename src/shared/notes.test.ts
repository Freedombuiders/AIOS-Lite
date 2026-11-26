import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAccessPolicy } from '../access/policy.js';
import type { ConnectionsService } from '../access/contracts.js';
import type { SkillLibrary } from './contracts.js';
import { parseFrontmatter } from './frontmatter.js';
import { readBlock } from './note-blocks.js';
import { createNotes, hashOf, NoteAccessError, NoteConflictError, NoteInputError, NoteSchemaError, type Notes } from './notes.js';
import { sampleBrain, tempRegistry, testLog, tmpDir, writeFile } from './test-kit.js';

const KH = { loai: 'khach-hang', id: 'cus_01', ten: 'Chị Lan', giai_doan: 'dang-tu-van', the: ['hoi-si'] };
const BODY = '# Chị Lan\n\nGhi chú tay của chủ: "đừng gọi sau 9 giờ".\n';

let notes: Notes;
let sb: ReturnType<typeof sampleBrain>;
let folderPath: string;

beforeEach(() => {
  sb = sampleBrain();
  folderPath = path.join(sb.root, 'brain', 'cong-ty-b');
  const reg = tempRegistry();
  const agents = reg.registry();
  const access = { brain: { 'cong-ty-b': { read: ['khach-hang/**', 'danh-muc-tra-sen.md'], write: ['khach-hang/**'] } }, memory: { team: true, private: true }, skills: [], connections: {}, modules: {} };
  agents.create('bot-cham', { name: 'Bot chăm', runtime: 'mock', access });
  const policy = createAccessPolicy({
    agents,
    brain: sb.brain,
    connections: { get: () => undefined, resolveEnv: () => ({}) } as unknown as ConnectionsService,
    skills: { resolve: () => [] } as unknown as SkillLibrary,
    isModuleEnabled: () => true,
  });
  notes = createNotes({ brain: sb.brain, canRead: policy.canReadPath, canWrite: policy.canWritePath, log: testLog });
});

const ref = (relPath: string) => ({ folderId: 'cong-ty-b', relPath });
const file = (rel: string) => path.join(folderPath, ...rel.split('/'));

describe('notes: read, create, patch', () => {
  it('creates, reads, lists and patches a note, keeping the body; the write is indexed', () => {
    const m = notes.forModule('crm');
    expect(m.principal).toBe('module:crm');
    const created = m.create(ref('khach-hang/chi-lan.md'), KH, BODY, { message: 'tạo khách' });
    expect(created.data).toEqual(KH);
    const r = m.read(ref('khach-hang/chi-lan.md'))!;
    expect(r).toMatchObject({ data: KH, body: BODY, mtimeMs: created.mtimeMs, hash: created.hash });
    expect(r.hash).toBe(hashOf(fs.readFileSync(file('khach-hang/chi-lan.md'), 'utf8')));
    expect(m.list('cong-ty-b', 'khach-hang', { loai: 'khach-hang' }).map((n) => n.relPath)).toEqual(['khach-hang/chi-lan.md']);
    expect(m.list('cong-ty-b', '', { loai: 'bai-hoc' })).toEqual([]);

    const p = m.patch(ref('khach-hang/chi-lan.md'), { giai_doan: 'da-bao-gia', gia_tri: 14352000 }, { message: 'báo giá', expectMtimeMs: r.mtimeMs });
    expect(p.data).toMatchObject({ giai_doan: 'da-bao-gia', gia_tri: 14352000, ten: 'Chị Lan' });
    expect(parseFrontmatter(fs.readFileSync(file('khach-hang/chi-lan.md'), 'utf8')).body).toBe(BODY);
    expect(sb.brain.search('đừng gọi sau', { folders: ['cong-ty-b'] }).map((h) => h.path)).toContain('khach-hang/chi-lan.md');
    expect(m.read(ref('khach-hang/khong-co.md'))).toBeUndefined();
    // no temp file is left behind
    expect(fs.readdirSync(file('khach-hang')).filter((f) => f.includes('aios-tmp'))).toEqual([]);
  });

  it('requires the version that was read (or an explicit overwrite) to change an existing note', () => {
    const m = notes.forModule('crm');
    const c = m.create(ref('khach-hang/chi-lan.md'), KH, BODY, { message: 'x' });
    const before = fs.readFileSync(file('khach-hang/chi-lan.md'), 'utf8');
    expect(() => m.patch(ref('khach-hang/chi-lan.md'), { hang: 'A' }, { message: 'x' })).toThrow(NoteInputError);
    expect(() => m.patch(ref('khach-hang/chi-lan.md'), { hang: 'A' }, { message: 'x', expectMtimeMs: c.mtimeMs - 5000 })).toThrow(NoteConflictError);
    expect(() => m.patch(ref('khach-hang/chi-lan.md'), { hang: 'A' }, { message: 'x', expectHash: hashOf('khác') })).toThrow(NoteConflictError);
    expect(() => notes.owner().write(ref('khach-hang/chi-lan.md'), 'mới', { message: 'x', expectMtimeMs: c.mtimeMs + 5000 })).toThrow(NoteConflictError);
    expect(() => notes.owner().write(ref('khach-hang/chi-lan.md'), 'mới', { message: 'x' })).toThrow(NoteInputError);
    expect(fs.readFileSync(file('khach-hang/chi-lan.md'), 'utf8')).toBe(before);
    expect(() => m.create(ref('khach-hang/chi-lan.md'), KH, '', { message: 'x' })).toThrow(NoteConflictError);
    // same millisecond, different content: the hash catches it
    fs.writeFileSync(file('khach-hang/chi-lan.md'), before.replace('Chị Lan', 'Chị Lành'));
    fs.utimesSync(file('khach-hang/chi-lan.md'), new Date(c.mtimeMs), new Date(c.mtimeMs));
    expect(() => m.patch(ref('khach-hang/chi-lan.md'), { hang: 'A' }, { message: 'x', expectHash: c.hash })).toThrow(NoteConflictError);
    // explicit overwrite and a deleted note
    expect(m.patch(ref('khach-hang/chi-lan.md'), { hang: 'A' }, { message: 'x', overwrite: true }).data).toMatchObject({ hang: 'A', ten: 'Chị Lành' });
    fs.unlinkSync(file('khach-hang/chi-lan.md'));
    expect(() => notes.owner().write(ref('khach-hang/chi-lan.md'), 'x', { message: 'x', expectMtimeMs: c.mtimeMs })).toThrow(NoteConflictError);
  });

  it('refuses data that breaks the schema of its loai, and writes nothing', () => {
    const m = notes.forModule('crm');
    const c = m.create(ref('khach-hang/chi-lan.md'), KH, BODY, { message: 'x' });
    const before = fs.readFileSync(file('khach-hang/chi-lan.md'), 'utf8');
    let err: unknown;
    try {
      m.patch(ref('khach-hang/chi-lan.md'), { giai_doan: 'dang-ngu', hang: 'Z' }, { message: 'x', expectHash: c.hash });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NoteSchemaError);
    expect((err as NoteSchemaError).issues.join('\n')).toMatch(/giai_doan[\s\S]*hang/);
    expect(fs.readFileSync(file('khach-hang/chi-lan.md'), 'utf8')).toBe(before);
    expect(() => m.create(ref('khach-hang/x.md'), { loai: 'khach-hang', ten: 'Thiếu id' }, '', { message: 'x' })).toThrow(NoteSchemaError);
    expect(fs.existsSync(file('khach-hang/x.md'))).toBe(false);
    // machines cannot sneak a bad note in through a whole-file write; the owner can (like in Obsidian)
    expect(() => m.write(ref('bai-hoc/a.md'), '---\nloai: bai-hoc\n---\n', { message: 'x' })).toThrow(NoteSchemaError);
    expect(notes.owner().write(ref('bai-hoc/a.md'), '---\nloai: bai-hoc\n---\n', { message: 'x' }).data).toEqual({ loai: 'bai-hoc' });
  });

  it('keeps unknown keys the owner added, does not check an unknown loai, accepts the lineage keys of bai-dang', () => {
    const m = notes.forModule('learn');
    writeFile(file('khach-hang/anh-minh.md'), '---\nloai: khach-hang\nid: cus_02\nten: Anh Minh\nsinh_nhat: 12/3\n---\nthân\n');
    const p = m.patch(ref('khach-hang/anh-minh.md'), { hang: 'B' }, { message: 'x', overwrite: true });
    expect(p.data).toMatchObject({ sinh_nhat: '12/3', hang: 'B' });
    expect(m.create(ref('y/rieng.md'), { loai: 'cua-toi', bat_ky: 1 }, '', { message: 'x' }).data).toEqual({ loai: 'cua-toi', bat_ky: 1 });
    const bai = { loai: 'bai-dang', id: 1042, nen_tang: 'facebook', de_xuat: 'dx_2026-11-24_1', cong_thuc: '[[huong-dan-3-buoc]]', cong_thuc_phien_ban: 2, hoc_tu: '[[2026-11-23-bep-nha-moc-7301]]', so_do: [{ moc: '1h', luc_do: '2026-11-24T20:00:00+07:00', reach: 900, er: 5.2, tb_xem: 14 }] };
    expect(m.create(ref('noi-dung/bai/2026-11-24-uop-tra-sen.md'), bai, '', { message: 'x' }).data).toEqual(bai);
    expect(() => m.create(ref('noi-dung/bai/sai.md'), { ...bai, so_do: [{ reach: 1 }] }, '', { message: 'x' })).toThrow(NoteSchemaError);
  });
});

describe('notes: managed blocks', () => {
  it('replaces only the block text, appends it when absent, never touches the rest', () => {
    const m = notes.forModule('crm');
    let n = m.create(ref('khach-hang/chi-lan.md'), KH, BODY, { message: 'x' });
    n = m.setBlock(ref('khach-hang/chi-lan.md'), 'nhat-ky', '- 26/11: hỏi giá sỉ', { message: 'nhật ký', expectHash: n.hash });
    const t1 = fs.readFileSync(file('khach-hang/chi-lan.md'), 'utf8');
    expect(t1).toContain(BODY);
    expect(readBlock(t1, 'nhat-ky')).toBe('- 26/11: hỏi giá sỉ\n');
    // the owner writes below the block in Obsidian; the next machine update keeps it
    fs.appendFileSync(file('khach-hang/chi-lan.md'), '\nChủ viết thêm ở cuối.\n');
    const cur = m.read(ref('khach-hang/chi-lan.md'))!;
    m.setBlock(ref('khach-hang/chi-lan.md'), 'nhat-ky', '- 26/11: hỏi giá sỉ\n- 27/11: đã báo giá', { message: 'nhật ký', expectHash: cur.hash });
    const t2 = fs.readFileSync(file('khach-hang/chi-lan.md'), 'utf8');
    expect(t2).toContain(BODY);
    expect(t2.endsWith('\nChủ viết thêm ở cuối.\n')).toBe(true);
    expect(readBlock(t2, 'nhat-ky')).toBe('- 26/11: hỏi giá sỉ\n- 27/11: đã báo giá\n');
    expect(parseFrontmatter(t2).data).toEqual(KH);
    expect(() => m.setBlock(ref('khach-hang/chi-lan.md'), 'Sai Ten', 'x', { message: 'x', overwrite: true })).toThrow();
    expect(() => m.setBlock(ref('khach-hang/chi-lan.md'), 'nhat-ky', '<!-- aios:end nhat-ky -->', { message: 'x', overwrite: true })).toThrow();
  });
});

describe('notes: principals and access', () => {
  it('an agent is always checked against its brain globs, for reads and writes', () => {
    const agent = notes.forModule('care').asAgent('bot-cham');
    expect(agent.principal).toBe('agent:bot-cham');
    expect(() => agent.create(ref('chinh-sach/moi.md'), { loai: 'tong-ket' }, '', { message: 'x' })).toThrow(NoteAccessError);
    expect(() => agent.write(ref('danh-muc-tra-sen.md'), 'xoá', { message: 'x', overwrite: true })).toThrow(NoteAccessError);
    expect(() => agent.read(ref('chinh-sach-dai-ly.md'))).toThrow(NoteAccessError);
    expect(agent.read(ref('danh-muc-tra-sen.md'))?.body).toContain('Trà');
    expect(fs.existsSync(file('chinh-sach/moi.md'))).toBe(false);
    expect(agent.create(ref('khach-hang/a.md'), KH, '', { message: 'x' }).relPath).toBe('khach-hang/a.md');
    expect(agent.list('cong-ty-b', '').map((n) => n.relPath)).toEqual(['danh-muc-tra-sen.md', 'khach-hang/a.md']);
    // an unknown agent may do nothing
    const ghost = notes.forAgent('khong-co');
    expect(() => ghost.create(ref('khach-hang/b.md'), KH, '', { message: 'x' })).toThrow(NoteAccessError);
    // only a module service can switch to an agent
    expect(() => (notes.owner() as ReturnType<Notes['forModule']>).asAgent('bot-cham')).toThrow(NoteAccessError);
  });

  it('refuses paths that leave the folder, absolute paths, symlinks at any segment and non-markdown', () => {
    const owner = notes.owner();
    const opts = { message: 'x', overwrite: true };
    for (const bad of ['../x.md', 'khach-hang/../../x.md', '/etc/x.md', 'C:/x.md', '', 'a.txt', '.git/x.md', '.obsidian/a.md']) {
      expect(() => owner.write(ref(bad), 'x', opts), bad).toThrow(NoteInputError);
    }
    expect(fs.existsSync(path.join(sb.root, 'brain', 'x.md'))).toBe(false);
    const outside = tmpDir();
    fs.mkdirSync(file('sau'));
    fs.symlinkSync(outside, file('link'));
    fs.symlinkSync(folderPath, file('sau/vong')); // a symlink pointing back inside is refused too
    fs.symlinkSync(file('danh-muc-tra-sen.md'), file('alias.md'));
    expect(() => owner.write(ref('link/x.md'), 'x', opts)).toThrow(NoteInputError);
    expect(() => owner.write(ref('sau/vong/x.md'), 'x', opts)).toThrow(NoteInputError);
    expect(() => owner.write(ref('alias.md'), 'x', opts)).toThrow(NoteInputError);
    expect(() => owner.read(ref('link/x.md'))).toThrow(NoteInputError);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(owner.list('cong-ty-b', 'link')).toEqual([]);
    expect(() => owner.write({ folderId: 'khong-co', relPath: 'a.md' }, 'x', opts)).toThrow(NoteInputError);
    expect(() => owner.write(ref('to.md'), 'x'.repeat(1024 * 1024 + 1), opts)).toThrow(NoteInputError);
  });
});

describe('notes: remove and the system principal', () => {
  it('removes only the version the caller saw, refuses agents without write access and symlinks, and is unindexed', () => {
    const sys = notes.forSystem('packs');
    expect(sys.principal).toBe('system:packs');
    const created = sys.create(ref('khach-hang/xoa.md'), KH, BODY, { message: 'tạo' });
    // a stale expectation is a conflict, the file stays
    expect(() => sys.remove(ref('khach-hang/xoa.md'), { message: 'xoá', expectHash: 'f'.repeat(64) })).toThrow(NoteConflictError);
    expect(fs.existsSync(file('khach-hang/xoa.md'))).toBe(true);
    // an agent that may read but not write danh-muc-tra-sen.md cannot delete it
    expect(() => notes.forAgent('bot-cham').remove(ref('danh-muc-tra-sen.md'), { message: 'x', overwrite: true })).toThrow(NoteAccessError);
    expect(sys.remove(ref('khach-hang/xoa.md'), { message: 'xoá', expectHash: created.hash })).toBe(true);
    expect(fs.existsSync(file('khach-hang/xoa.md'))).toBe(false);
    expect(sys.read(ref('khach-hang/xoa.md'))).toBeUndefined();
    expect(sb.brain.search('cus_01', { folders: ['cong-ty-b'] }).some((h) => h.path === 'khach-hang/xoa.md')).toBe(false);
    // already gone: false without an expectation, conflict with one
    expect(sys.remove(ref('khach-hang/xoa.md'), { message: 'xoá', overwrite: true })).toBe(false);
    expect(() => sys.remove(ref('khach-hang/xoa.md'), { message: 'xoá', expectHash: created.hash })).toThrow(NoteConflictError);
    fs.symlinkSync(file('danh-muc-tra-sen.md'), file('alias.md'));
    expect(() => sys.remove(ref('alias.md'), { message: 'x', overwrite: true })).toThrow(NoteInputError);
    expect(fs.existsSync(file('danh-muc-tra-sen.md'))).toBe(true);
  });
});
