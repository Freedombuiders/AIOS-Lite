import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EffectiveAccess } from '../access/contracts.js';
import type { AppEvent } from '../core/events.js';
import { createBoardService } from './board.js';
import { createBrainService } from './brain.js';
import { globBaseDir, matchGlob } from './glob.js';
import { createMemoryService } from './memory.js';
import { createSkillLibrary } from './skills.js';
import { memDb, REPO_ROOT, sampleBrain, testBus, testLog, tmpDir, writeFile } from './test-kit.js';

const access = (readDirs: EffectiveAccess['readDirs']): EffectiveAccess => ({
  agentId: 'x', readDirs, writeDirs: [], addDirs: [], memory: { team: false, private: false }, mcpServers: [], envVars: {}, skills: [], moduleScopes: {}, permission: 'safe', tools: 'default',
});

describe('glob', () => {
  it('matches ** * ?', () => {
    expect(matchGlob('**', 'a/b/c.md')).toBe(true);
    expect(matchGlob('Ban-hang/**', 'Ban-hang/x/y.md')).toBe(true);
    expect(matchGlob('Ban-hang/**', 'Khac/x.md')).toBe(false);
    expect(matchGlob('*.md', 'a.md')).toBe(true);
    expect(matchGlob('*.md', 'a/b.md')).toBe(false);
    expect(matchGlob('**/*.md', 'b.md')).toBe(true);
    expect(matchGlob('**/*.md', 'a/b/c.md')).toBe(true);
    expect(matchGlob('a?.md', 'ab.md')).toBe(true);
    expect(matchGlob('a?.md', 'a/.md')).toBe(false);
    expect(matchGlob('**', '../x.md')).toBe(false);
  });
  it('finds the narrowest base dir', () => {
    expect(globBaseDir('**')).toBe('');
    expect(globBaseDir('Ban-hang/**')).toBe('Ban-hang');
    expect(globBaseDir('a/b/*.md')).toBe('a/b');
    expect(globBaseDir('a/b.md')).toBe('a');
    expect(globBaseDir('*.md')).toBe('');
  });
});

describe('brain', () => {
  it('reads folders (~ and relative paths, missing allowed)', () => {
    const root = tmpDir();
    writeFile(path.join(root, 'config', 'brain.yaml'), 'folders:\n  - {id: a, name: A, path: ./x}\n  - {id: b, name: B, path: ./missing}\n');
    fs.mkdirSync(path.join(root, 'x'));
    const brain = createBrainService({ db: memDb(), configFile: path.join(root, 'config', 'brain.yaml'), rootDir: root, log: testLog });
    expect(brain.folders().map((f) => [f.id, f.path])).toEqual([['a', path.join(root, 'x')], ['b', path.join(root, 'missing')]]);
    expect(brain.folderInfos().map((f) => f.exists)).toEqual([true, false]);
  });

  it('indexes sample notes and finds "khach hang" without diacritics', async () => {
    const { brain } = sampleBrain();
    const r = await brain.reindex();
    expect(r.indexed).toBe(9);
    const hits = brain.search('khach hang');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.title.includes('chăm sóc khách hàng'))).toBe(true);
    expect(hits[0]!.snippet.length).toBeGreaterThan(0);
    expect(brain.search('khach hang', { folders: ['cong-ty-b'] }).every((h) => h.folderId === 'cong-ty-b')).toBe(true);
    expect(brain.search('"; DROP TABLE x --')).toEqual([]);
    expect(brain.search('   ')).toEqual([]);
  });

  it('falls back to OR when AND finds nothing', async () => {
    const { brain } = sampleBrain();
    await brain.reindex();
    const hits = brain.search('bảng giá nội thất và doanh thu');
    expect(hits.map((h) => h.path)).toEqual(expect.arrayContaining(['bang-gia-noi-that-2026.md', 'bao-cao-doanh-thu-quy-3.md']));
  });

  it('is incremental by mtime and removes deleted files', async () => {
    const { brain, root } = sampleBrain();
    await brain.reindex();
    expect((await brain.reindex()).indexed).toBe(0);
    const f = path.join(root, 'brain', 'ca-nhan', 'muc-tieu-quy.md');
    fs.writeFileSync(f, '# Mục tiêu mới\n\nhọc piano\n');
    fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
    expect((await brain.reindex()).indexed).toBe(1);
    expect(brain.search('piano')[0]!.title).toBe('Mục tiêu mới');
    expect(brain.search('sách').length).toBeGreaterThan(0);
    fs.rmSync(path.join(root, 'brain', 'ca-nhan', 'sach-muon-doc.md'));
    const r = await brain.reindex();
    expect(r.removed).toBe(1);
    expect(brain.search('Thinking in Systems')).toEqual([]);
    expect((await brain.reindex({ full: true })).indexed).toBe(8);
  });

  it('skips .git, .obsidian, big and non-md files; titles fall back to file name', async () => {
    const root = tmpDir();
    writeFile(path.join(root, 'config', 'brain.yaml'), 'folders:\n  - {id: v, name: V, path: ./v}\n');
    writeFile(path.join(root, 'v', '.obsidian', 'a.md'), '# ẩn\nzebra');
    writeFile(path.join(root, 'v', '.git', 'b.md'), '# git\nzebra');
    writeFile(path.join(root, 'v', 'big.md'), `zebra ${'x'.repeat(1024 * 1024 + 10)}`);
    writeFile(path.join(root, 'v', 'note.txt'), 'zebra');
    writeFile(path.join(root, 'v', 'sub', 'khong-tieu-de.md'), 'chỉ có zebra thôi');
    const brain = createBrainService({ db: memDb(), configFile: path.join(root, 'config', 'brain.yaml'), rootDir: root, log: testLog });
    await brain.reindex();
    const hits = brain.search('zebra');
    expect(hits.map((h) => h.path)).toEqual(['sub/khong-tieu-de.md']);
    expect(hits[0]!.title).toBe('khong-tieu-de');
  });

  it('searchForAccess honours folder and glob grants', async () => {
    const { brain, root } = sampleBrain();
    writeFile(path.join(root, 'brain', 'cong-ty-a', 'Ban-hang', 'kich-ban.md'), '# Kịch bản\nkhách hàng hỏi giá');
    writeFile(path.join(root, 'brain', 'cong-ty-a', 'Ke-toan', 'luong.md'), '# Lương\nkhách hàng không liên quan');
    await brain.reindex();
    const a = path.join(root, 'brain', 'cong-ty-a');
    const only = brain.searchForAccess('khach hang', access([{ folderId: 'cong-ty-a', root: a, globs: ['Ban-hang/**'] }]), 10);
    expect(only.map((h) => h.path)).toEqual(['Ban-hang/kich-ban.md']);
    expect(brain.searchForAccess('khach hang', access([]), 10)).toEqual([]);
  });

  it('rejects traversal and symlinks escaping the folder; reads, writes, trees', async () => {
    const { brain, root } = sampleBrain();
    await brain.reindex();
    const outside = tmpDir();
    writeFile(path.join(outside, 'secret.md'), '# secret');
    fs.symlinkSync(outside, path.join(root, 'brain', 'ca-nhan', 'link'));
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'brain', 'ca-nhan', 'file-link.md'));
    for (const p of ['../cong-ty-a/bang-gia-noi-that-2026.md', '/etc/passwd', 'a/../../x.md', 'link/secret.md', 'file-link.md']) {
      expect(() => brain.read('ca-nhan', p), p).toThrow();
      expect(() => brain.write('ca-nhan', p, 'x'), p).toThrow();
    }
    expect(() => brain.write('ca-nhan', 'link/new.md', 'x')).toThrow('ngoài');
    expect(fs.existsSync(path.join(outside, 'new.md'))).toBe(false);
    expect(() => brain.read('nope', 'a.md')).toThrow('Không có thư mục');
    expect(brain.read('ca-nhan', 'muc-tieu-quy.md')).toMatchObject({ title: 'Mục tiêu quý này' });
    expect(() => brain.write('ca-nhan', 'x.txt', 'x')).toThrow('Markdown');

    brain.write('ca-nhan', 'moi/ghi-chu.md', '# Ghi chú mới\nnội dung độc đáo');
    expect(brain.read('ca-nhan', 'moi/ghi-chu.md').content).toContain('độc đáo');
    expect(brain.search('doc dao')[0]!.path).toBe('moi/ghi-chu.md');
    const tree = brain.tree('ca-nhan');
    expect(tree[0]).toMatchObject({ name: 'moi', type: 'dir' });
    expect(tree.some((n) => n.name === 'link')).toBe(false);
    expect(tree.some((n) => n.path === 'muc-tieu-quy.md' && n.type === 'file')).toBe(true);
  });
});

describe('memory', () => {
  const setup = () => {
    const bus = testBus();
    const events: AppEvent[] = [];
    bus.on('memory', (e) => events.push(e));
    return { mem: createMemoryService({ db: memDb(), bus }), events };
  };

  it('adds, updates, removes and emits events', () => {
    const { mem, events } = setup();
    const m = mem.add({ content: 'Khách ưu tiên màu gỗ sồi', agentId: null, source: 'user' });
    expect(m).toMatchObject({ agentId: null, pinned: false, useCount: 0, source: 'user' });
    expect(mem.update(m.id, { pinned: true, content: 'Khách ưu tiên màu sồi sáng' })).toMatchObject({ pinned: true });
    expect(mem.list({ q: 'soi sang' })).toHaveLength(1);
    mem.remove(m.id);
    expect(mem.get(m.id)).toBeUndefined();
    expect(events.map((e) => (e.type === 'memory' && e.deleted ? 'del' : 'set'))).toEqual(['set', 'set', 'del']);
    expect(() => mem.add({ content: '  ', agentId: null })).toThrow();
  });

  it('recalls pinned team, then pinned own, then FTS hits; respects scope, dedups, bumps use', () => {
    const { mem } = setup();
    const t1 = mem.add({ content: 'Quy tắc đội: báo giá luôn kèm bảo hành', agentId: null, pinned: true });
    const p1 = mem.add({ content: 'Tôi thích báo cáo ngắn', agentId: 'a', pinned: true });
    const hit = mem.add({ content: 'Công ty Sunrise đặt tủ bếp màu sồi', agentId: null });
    const own = mem.add({ content: 'Sunrise muốn bàn giao ngày 20/12', agentId: 'a' });
    mem.add({ content: 'Sunrise của agent khác', agentId: 'b' });
    mem.add({ content: 'không liên quan gì', agentId: null });

    const all = mem.recall('a', 'tiến độ Sunrise', { team: true, private: true, limit: 8 });
    expect(all.map((m) => m.id).slice(0, 2)).toEqual([t1.id, p1.id]);
    expect(all.map((m) => m.id).sort()).toEqual([t1.id, p1.id, hit.id, own.id].sort());
    expect(all.every((m) => m.useCount === 1 && m.lastUsedAt)).toBe(true);
    expect(mem.recall('a', 'Sunrise', { team: false, private: true, limit: 8 }).map((m) => m.id)).toEqual([p1.id, own.id]);
    expect(mem.recall('a', 'Sunrise', { team: true, private: false, limit: 8 }).map((m) => m.id)).toEqual([t1.id, hit.id]);
    expect(mem.recall('a', 'Sunrise', { team: false, private: false, limit: 8 })).toEqual([]);
    expect(mem.recall('a', 'Sunrise', { team: true, private: true, limit: 1 })).toHaveLength(1);
    expect(mem.get(t1.id)!.useCount).toBe(3);
  });

  it('survives odd queries', () => {
    const { mem } = setup();
    mem.add({ content: 'abc def', agentId: null });
    expect(() => mem.recall('a', '"*( OR', { team: true, private: true, limit: 3 })).not.toThrow();
  });
});

describe('board', () => {
  it('returns newest first and emits', () => {
    const bus = testBus();
    const seen: string[] = [];
    bus.on('board', (e) => seen.push(e.entry.text));
    const board = createBoardService({ db: memDb(), bus });
    board.add({ agentId: 'a', taskId: 1, kind: 'run', text: 'một' });
    board.add({ agentId: null, text: 'hai' });
    expect(board.recent(10).map((b) => b.text)).toEqual(['hai', 'một']);
    expect(board.recent(1)).toHaveLength(1);
    expect(seen).toEqual(['một', 'hai']);
    expect(() => board.add({ agentId: null, text: ' ' })).toThrow();
  });
});

describe('skills', () => {
  it('lists sample skills with frontmatter', () => {
    const lib = createSkillLibrary({ dirs: [path.join(REPO_ROOT, 'skills')], log: testLog });
    expect(lib.list().map((s) => s.id).sort()).toEqual(['review-code', 'tom-tat-tai-lieu', 'viet-bao-cao']);
    expect(lib.get('review-code')).toMatchObject({ name: 'review-code', source: 'library' });
    expect(lib.get('review-code')!.description).toContain('Review');
    expect(lib.read('viet-bao-cao')).toContain('# Viết báo cáo');
    expect(() => lib.read('nope')).toThrow();
    expect(lib.resolve(['review-code', 'ghost']).map((s) => s.id)).toEqual(['review-code']);
    expect(lib.resolve('all')).toHaveLength(3);
  });

  it('first root wins; module roots add and remove', () => {
    const a = tmpDir();
    const b = tmpDir();
    writeFile(path.join(a, 'dup', 'SKILL.md'), '---\nname: A\ndescription: từ a\n---\nbody');
    writeFile(path.join(b, 'dup', 'SKILL.md'), '---\nname: B\ndescription: từ b\n---\nbody');
    writeFile(path.join(b, 'only-b', 'SKILL.md'), 'Không có frontmatter.\n');
    writeFile(path.join(b, 'no-file', 'readme.md'), 'x');
    const lib = createSkillLibrary({ dirs: [a], log: testLog });
    lib.addRoot(b, 'module:care');
    expect(lib.get('dup')!.description).toBe('từ a');
    expect(lib.get('only-b')).toMatchObject({ source: 'module:care', description: 'Không có frontmatter.' });
    expect(lib.get('no-file')).toBeUndefined();
    lib.removeRoot(b);
    expect(lib.get('only-b')).toBeUndefined();
  });

  it('links into a workspace and prunes only AIOS-made links', () => {
    const root = tmpDir();
    for (const id of ['s1', 's2', 's3']) writeFile(path.join(root, 'lib', id, 'SKILL.md'), `---\nname: ${id}\ndescription: d\n---\n`);
    const lib = createSkillLibrary({ dirs: [path.join(root, 'lib')], log: testLog });
    const ws = path.join(root, 'ws');
    const base = path.join(ws, '.claude', 'skills');
    fs.mkdirSync(base, { recursive: true });
    writeFile(path.join(base, 's3', 'mine.txt'), 'user file'); // user's own dir with a library id
    fs.symlinkSync(root, path.join(base, 'user-link'), 'dir');

    lib.linkIntoWorkspace(ws, lib.resolve(['s1', 's2', 's3']));
    expect(fs.readlinkSync(path.join(base, 's1'))).toBe(path.join(root, 'lib', 's1'));
    expect(fs.lstatSync(path.join(base, 's3')).isDirectory()).toBe(true); // untouched
    expect(JSON.parse(fs.readFileSync(path.join(base, '.aios-managed.json'), 'utf8')).links).toEqual(['s1', 's2']);

    lib.linkIntoWorkspace(ws, lib.resolve(['s2']));
    expect(fs.existsSync(path.join(base, 's1'))).toBe(false);
    expect(fs.lstatSync(path.join(base, 's2')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(base, 's3', 'mine.txt'))).toBe(true);
    expect(fs.lstatSync(path.join(base, 'user-link')).isSymbolicLink()).toBe(true);

    lib.linkIntoWorkspace(ws, []);
    expect(fs.existsSync(path.join(base, 's2'))).toBe(false);
    expect(fs.existsSync(path.join(base, 'user-link'))).toBe(true);
    expect(fs.existsSync(path.join(base, 's3', 'mine.txt'))).toBe(true);
  });
});
