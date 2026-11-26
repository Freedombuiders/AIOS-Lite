// Installing packs end to end against a fake cloud and a git-backed brain folder.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCloudClient, PackYankedError } from '../integrations/agenticos-cloud/client.js';
import { createBrainGit, createCommitQueue } from '../shared/brain-git.js';
import { parseFrontmatter } from '../shared/frontmatter.js';
import { createNotes, type Notes } from '../shared/notes.js';
import { sampleBrain, testLog } from '../shared/test-kit.js';
import { createPackService, PlanChangedError, type PackService } from './service.js';
import { buildPackZip, fakeCloud, keyPair, makeZip, samplePack } from './test-packs.js';
import { PackTrustError } from './verify.js';
import { PackError } from './zip.js';

const ID = 'tra-va-qua-tang-co-ban';
const FOLDER = 'cong-ty-b';
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

let sb: ReturnType<typeof sampleBrain>;
let repo: string;
let notes: Notes;
let cloud: ReturnType<typeof fakeCloud>;
let kp: ReturnType<typeof keyPair>;
let packs: PackService;
const inflated: string[] = [];

const commits = () => Number(git(repo, 'rev-list', '--count', 'HEAD'));
const read = (rel: string) => fs.readFileSync(path.join(repo, rel), 'utf8');
const exists = (rel: string) => fs.existsSync(path.join(repo, rel));
const data = (rel: string) => parseFrontmatter(read(rel)).data;

function publish(version: string, zip: Buffer, opts: { signVersion?: string; signZip?: Buffer; keyId?: string } = {}) {
  cloud.publish(ID, version, { zip, keyId: opts.keyId ?? kp.keyId, signature: kp.sign(ID, opts.signVersion ?? version, opts.signZip ?? zip) });
}

async function install(version: string, folder = FOLDER) {
  const plan = await packs.preview(ID, version, folder);
  const result = await packs.install(ID, version, folder, plan.planId);
  await notes.flush();
  return { plan, result };
}

function untouched() {
  expect(git(repo, 'status', '--porcelain')).toBe('');
  expect(commits()).toBe(1);
  expect(packs.installed()).toEqual([]);
  expect(sb.db.prepare('SELECT COUNT(*) AS n FROM pack_files').get()).toEqual({ n: 0 });
}

beforeEach(() => {
  sb = sampleBrain();
  repo = path.join(sb.root, 'brain', FOLDER);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'Chủ shop');
  git(repo, 'config', 'user.email', 'chu@example.test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'khởi tạo');
  const brainGit = createBrainGit();
  notes = createNotes({
    brain: sb.brain, log: testLog, git: brainGit,
    commits: createCommitQueue({ git: brainGit, log: testLog, windowMs: 60_000 }),
    canRead: () => true, canWrite: () => true,
  });
  cloud = fakeCloud();
  kp = keyPair();
  inflated.length = 0;
  packs = createPackService({
    db: sb.db, notes, brain: sb.brain, log: testLog, appVersion: '0.1.0',
    keys: () => kp.keys,
    cloud: () => createCloudClient({ baseUrl: cloud.base, token: 'sess-token', fetchImpl: cloud.fetchImpl }),
    unzip: { onInflate: (n) => inflated.push(n) },
  });
});

describe('install the cloud sample pack', () => {
  it('installs every note, forces lessons to hypotheses, in exactly one commit', async () => {
    publish('1.0.0', samplePack().zip);
    const { plan, result } = await install('1.0.0');

    expect(plan.counts).toMatchObject({ create: 5, update: 0, skip: 0 });
    expect(plan.assets).toEqual(['assets/bia.svg']);
    expect(plan.from).toBeNull();
    expect(result.written.sort()).toEqual([
      'bai-hoc/mo-dau-bang-cau-hoi.md', 'bai-hoc/tra-loi-gia-ngay.md', 'bai-hoc/video-huong-dan-ngan.md',
      'cong-thuc/huong-dan-3-buoc.md', 'cong-thuc/truoc-va-sau.md',
    ]);
    const lessons = result.written.filter((p) => p.startsWith('bai-hoc/'));
    expect(lessons).toHaveLength(3);
    for (const p of lessons) {
      const d = data(p);
      expect(d.trang_thai).toBe('gia-thuyet');
      expect(d).not.toHaveProperty('dung_boi');
      expect(d).not.toHaveProperty('bang_chung');
      expect(d.nguon_goi).toBe(`${ID}@1.0.0`);
    }
    for (const p of result.written.filter((x) => x.startsWith('cong-thuc/'))) {
      expect(data(p)).toMatchObject({ trang_thai: 'chua-thu', da_lam: 0, nguon_goi: `${ID}@1.0.0` });
      expect(data(p)).not.toHaveProperty('ket_qua');
    }
    // assets are not written into the brain
    expect(exists('assets/bia.svg')).toBe(false);

    expect(commits()).toBe(2);
    expect(git(repo, 'log', '-1', '--format=%an|%s')).toBe(`system:packs|goi: cài ${ID}@1.0.0`);
    expect(git(repo, 'show', '--name-only', '--format=', 'HEAD').split('\n')).toHaveLength(5);
    expect(git(repo, 'status', '--porcelain')).toBe('');

    expect(packs.installed()).toMatchObject([{ packId: ID, version: '1.0.0', folderId: FOLDER, module: 'learn', files: 5 }]);
    // the bot finds the new lessons when it searches the brain
    expect(sb.brain.search('mở đầu bằng một câu hỏi', { folders: [FOLDER] }).map((h) => h.path)).toContain('bai-hoc/mo-dau-bang-cau-hoi.md');
    // the download never carried the session token to storage
    expect(cloud.calls.find((c) => c.url.startsWith('https://r2.test/'))?.auth).toBeNull();
  });

  it('a pack can never deliver verified knowledge', async () => {
    const { zip } = samplePack({
      edit: (files) => files.map((f) =>
        f.path === 'notes/bai-hoc/tra-loi-gia-ngay.md'
          ? { ...f, data: '---\nloai: bai-hoc\nmang: noi-dung\ntrang_thai: da-kiem-chung\nbang_chung: ["[[bai-dang-1]]"]\ndung_boi: [bot-noi-dung]\nnguon_goi: gia-mao@9.9.9\n---\n# Đã kiểm chứng?\n' }
          : f.path === 'notes/cong-thuc/truoc-va-sau.md'
            ? { ...f, data: '---\nloai: cong-thuc\ntrang_thai: hop\nda_lam: 40\nket_qua: 3.2\nbang_chung: 12\n---\n# Công thức "đã chứng minh"\n' }
            : f),
    });
    publish('1.0.0', zip);
    await install('1.0.0');
    expect(data('bai-hoc/tra-loi-gia-ngay.md')).toEqual({ loai: 'bai-hoc', mang: 'noi-dung', trang_thai: 'gia-thuyet', nguon_goi: `${ID}@1.0.0` });
    expect(data('cong-thuc/truoc-va-sau.md')).toEqual({ loai: 'cong-thuc', trang_thai: 'chua-thu', da_lam: 0, nguon_goi: `${ID}@1.0.0` });
    expect(read('bai-hoc/tra-loi-gia-ngay.md')).toContain('# Đã kiểm chứng?');
  });
});

describe('nothing in a pack is trusted blindly', () => {
  it('wrong signature: nothing is unzipped or written', async () => {
    const { zip } = samplePack();
    const other = keyPair('k-test'); // same key id, different key
    cloud.publish(ID, '1.0.0', { zip, keyId: kp.keyId, signature: other.sign(ID, '1.0.0', zip) });
    await expect(packs.preview(ID, '1.0.0', FOLDER)).rejects.toThrow(PackTrustError);
    expect(inflated).toEqual([]);
    untouched();
  });

  it('a signature from a key this machine does not trust is refused', async () => {
    const { zip } = samplePack();
    const stranger = keyPair('k-la');
    cloud.publish(ID, '1.0.0', { zip, keyId: 'k-la', signature: stranger.sign(ID, '1.0.0', zip) });
    await expect(packs.preview(ID, '1.0.0', FOLDER)).rejects.toThrow(/chưa tin khoá "k-la"/);
    expect(inflated).toEqual([]);
    untouched();
  });

  it('a signature valid for another version of the same pack is rejected', async () => {
    const v1 = samplePack({ version: '1.0.0' }).zip;
    const v2 = samplePack({ version: '1.0.1' }).zip;
    // replay: 1.0.0's zip and its genuine signature served as 1.0.1
    cloud.publish(ID, '1.0.1', { zip: v1, keyId: kp.keyId, signature: kp.sign(ID, '1.0.0', v1) });
    await expect(packs.preview(ID, '1.0.1', FOLDER)).rejects.toThrow(/Chữ ký .* không hợp lệ/);
    // 1.0.1's own bytes, signed as if they were 1.0.0
    publish('1.0.1', v2, { signVersion: '1.0.0' });
    packs.forget(ID, '1.0.1');
    await expect(packs.preview(ID, '1.0.1', FOLDER)).rejects.toThrow(/Chữ ký .* không hợp lệ/);
    expect(inflated).toEqual([]);
    untouched();
  });

  it('the cloud lying about the hash is refused before the signature is even looked at', async () => {
    const { zip } = samplePack();
    cloud.publish(ID, '1.0.0', { zip, keyId: kp.keyId, signature: kp.sign(ID, '1.0.0', zip), sha256: 'f'.repeat(64) });
    await expect(packs.preview(ID, '1.0.0', FOLDER)).rejects.toThrow(/SHA-256/);
    untouched();
  });

  it('a signed zip with ../ or an absolute path is rejected as a whole', async () => {
    for (const bad of ['notes/../../.env', '/etc/x.md', 'notes/../../../../tmp/x.md']) {
      const { zip } = buildPackZip(
        { id: ID, version: '1.0.0', name: 'x', module: 'learn', license: 'CC0' },
        [{ path: 'notes/bai-hoc/a.md', data: '---\nloai: bai-hoc\nmang: noi-dung\ntrang_thai: gia-thuyet\n---\n' }],
        [{ name: bad, data: 'AIOS_TOKEN=lay-cap\n' }],
      );
      publish('1.0.0', zip); // validly signed: the signature only says who published it
      packs.forget(ID, '1.0.0');
      await expect(packs.preview(ID, '1.0.0', FOLDER)).rejects.toThrow(PackError);
      expect(inflated).toEqual([]);
      untouched();
    }
  });

  it('a signed zip bomb stops at the cap and writes nothing', async () => {
    const bomb = makeZip([
      { name: 'pack.json', data: '{}' },
      { name: 'notes/bai-hoc/bom.md', data: Buffer.alloc(80 * 1024 * 1024), declaredSize: 120 },
    ]);
    publish('1.0.0', bomb);
    await expect(packs.preview(ID, '1.0.0', FOLDER)).rejects.toThrow(/vượt trần/);
    untouched();
  });

  it('a pack carrying loai khach-hang is rejected, whatever module it claims', async () => {
    const kh = '---\nloai: khach-hang\nid: cus_1\nten: Chị Lan\nsdt: "0900000000"\n---\n';
    for (const module of ['crm', 'learn', 'brain'] as const) {
      const { zip } = buildPackZip(
        { id: ID, version: '1.0.0', name: 'x', module, license: 'CC0' },
        [{ path: 'notes/khach-hang/chi-lan.md', data: kh }],
      );
      publish('1.0.0', zip);
      packs.forget(ID, '1.0.0');
      await expect(packs.preview(ID, '1.0.0', FOLDER)).rejects.toThrow(/khach-hang/);
      untouched();
    }
    // and loai the module may not carry, even if allowed elsewhere
    const { zip } = buildPackZip({ id: ID, version: '1.0.0', name: 'x', module: 'brain', license: 'CC0' }, [{ path: 'notes/a.md', data: '---\nloai: bai-hoc\nmang: noi-dung\ntrang_thai: gia-thuyet\n---\n' }]);
    publish('1.0.0', zip);
    packs.forget(ID, '1.0.0');
    await expect(packs.preview(ID, '1.0.0', FOLDER)).rejects.toThrow(/không được phép trong gói brain/);
  });

  it('a pack whose id or version inside differs from the release is refused', async () => {
    publish('2.0.0', samplePack({ version: '1.0.0' }).zip); // signed for 2.0.0, but pack.json says 1.0.0
    await expect(packs.preview(ID, '2.0.0', FOLDER)).rejects.toThrow(/version "1.0.0" khác/);
    untouched();
  });

  it('a yanked release is HTTP 410', async () => {
    publish('1.0.0', samplePack().zip);
    cloud.yank(ID, '1.0.0');
    await expect(packs.preview(ID, '1.0.0', FOLDER)).rejects.toThrow(PackYankedError);
    untouched();
  });
});

describe("the owner's work is never overwritten", () => {
  it('a note already in the brain at the same path is skipped and listed', async () => {
    const mine = '---\nloai: bai-hoc\nmang: noi-dung\ntrang_thai: da-kiem-chung\n---\n# Của tôi\n';
    notes.owner().write({ folderId: FOLDER, relPath: 'bai-hoc/mo-dau-bang-cau-hoi.md' }, mine, { message: 'của tôi' });
    await notes.flush();
    publish('1.0.0', samplePack().zip);
    const { plan, result } = await install('1.0.0');
    expect(plan.items.find((i) => i.path === 'bai-hoc/mo-dau-bang-cau-hoi.md')).toMatchObject({ action: 'skip', reason: expect.stringMatching(/không ghi đè/) });
    expect(result.skipped.map((s) => s.path)).toEqual(['bai-hoc/mo-dau-bang-cau-hoi.md']);
    expect(read('bai-hoc/mo-dau-bang-cau-hoi.md')).toBe(mine);
    expect(packs.installed()[0]!.files).toBe(4);
  });

  it('an owner-edited note survives an update; unchanged ones are updated, dropped, added', async () => {
    publish('1.0.0', samplePack().zip);
    await install('1.0.0');
    const edited = 'bai-hoc/tra-loi-gia-ngay.md';
    const n = notes.owner().read({ folderId: FOLDER, relPath: edited })!;
    const mine = `${read(edited)}\nGhi chú riêng của chủ shop.\n`;
    notes.owner().write({ folderId: FOLDER, relPath: edited }, mine, { message: 'chủ sửa', expectHash: n.hash });
    await notes.flush();
    const before = commits();

    const v2 = samplePack({
      version: '1.1.0',
      edit: (files) => [
        ...files
          .filter((f) => f.path !== 'notes/cong-thuc/huong-dan-3-buoc.md') // dropped in 1.1.0
          .map((f) => (f.path.startsWith('notes/bai-hoc/') ? { ...f, data: `${f.data.toString()}\nCập nhật 1.1.0.\n` } : f)),
        { path: 'notes/bai-hoc/moi.md', data: '---\nloai: bai-hoc\nmang: noi-dung\ntrang_thai: gia-thuyet\n---\n# Mới\n' },
      ],
    }).zip;
    publish('1.1.0', v2);
    const { plan, result } = await install('1.1.0');

    expect(plan.from).toBe('1.0.0');
    const byPath = Object.fromEntries(plan.items.map((i) => [i.path, i.action]));
    expect(byPath).toMatchObject({
      [edited]: 'skip',
      'bai-hoc/mo-dau-bang-cau-hoi.md': 'update',
      'bai-hoc/video-huong-dan-ngan.md': 'update',
      'bai-hoc/moi.md': 'create',
      'cong-thuc/truoc-va-sau.md': 'update', // same text, but nguon_goi moves to @1.1.0
      'cong-thuc/huong-dan-3-buoc.md': 'delete',
    });
    expect(read(edited)).toBe(mine);
    expect(read('bai-hoc/mo-dau-bang-cau-hoi.md')).toContain('Cập nhật 1.1.0.');
    expect(data('bai-hoc/mo-dau-bang-cau-hoi.md').nguon_goi).toBe(`${ID}@1.1.0`);
    expect(exists('cong-thuc/huong-dan-3-buoc.md')).toBe(false);
    expect(exists('bai-hoc/moi.md')).toBe(true);
    expect(result.skipped).toEqual([{ path: edited, reason: expect.stringMatching(/đã sửa/) }]);
    expect(commits()).toBe(before + 1);
    expect(git(repo, 'log', '-1', '--format=%s')).toBe(`goi: cập nhật ${ID} 1.0.0 → 1.1.0`);
    expect(packs.installed()).toMatchObject([{ version: '1.1.0' }]);
    expect(packs.files(ID, FOLDER).find((f) => f.path === edited)?.status).toBe('edited');
  });

  it('a dropped note the owner edited is kept on update', async () => {
    publish('1.0.0', samplePack().zip);
    await install('1.0.0');
    const rel = 'cong-thuc/huong-dan-3-buoc.md';
    const n = notes.owner().read({ folderId: FOLDER, relPath: rel })!;
    notes.owner().write({ folderId: FOLDER, relPath: rel }, `${read(rel)}\nđã thử trên kênh mình\n`, { message: 'sửa', expectHash: n.hash });
    publish('1.1.0', samplePack({ version: '1.1.0', edit: (f) => f.filter((x) => x.path !== `notes/${rel}`) }).zip);
    const { result } = await install('1.1.0');
    expect(result.kept.map((k) => k.path)).toEqual([rel]);
    expect(read(rel)).toContain('đã thử trên kênh mình');
    // no longer the pack's file: an uninstall will not consider it
    expect(packs.files(ID, FOLDER).map((f) => f.path)).not.toContain(rel);
  });

  it('uninstall removes only unchanged files, in one commit', async () => {
    publish('1.0.0', samplePack().zip);
    await install('1.0.0');
    const rel = 'bai-hoc/video-huong-dan-ngan.md';
    const n = notes.owner().read({ folderId: FOLDER, relPath: rel })!;
    notes.owner().write({ folderId: FOLDER, relPath: rel }, `${read(rel)}\nKết quả trên kênh tôi: tốt.\n`, { message: 'sửa', expectHash: n.hash });
    await notes.flush();
    const before = commits();

    const plan = packs.uninstallPreview(ID, FOLDER);
    expect(plan.counts).toMatchObject({ delete: 4, keep: 1 });
    const result = await packs.uninstall(ID, FOLDER, plan.planId);
    await notes.flush();
    expect(result.deleted).toHaveLength(4);
    expect(result.kept).toEqual([{ path: rel, reason: expect.stringMatching(/đã sửa/) }]);
    expect(exists(rel)).toBe(true);
    expect(exists('bai-hoc/mo-dau-bang-cau-hoi.md')).toBe(false);
    expect(commits()).toBe(before + 1);
    expect(git(repo, 'log', '-1', '--format=%an|%s')).toBe(`system:packs|goi: gỡ ${ID}@1.0.0`);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(packs.installed()).toEqual([]);
    expect(sb.db.prepare('SELECT COUNT(*) AS n FROM pack_files').get()).toEqual({ n: 0 });
    // removed notes leave the search index
    expect(sb.brain.search('mở đầu bằng một câu hỏi', { folders: [FOLDER] }).map((h) => h.path)).not.toContain('bai-hoc/mo-dau-bang-cau-hoi.md');
  });

  it('install then uninstall: git log shows exactly the two commits', async () => {
    publish('1.0.0', samplePack().zip);
    await install('1.0.0');
    const plan = packs.uninstallPreview(ID, FOLDER);
    await packs.uninstall(ID, FOLDER, plan.planId);
    await notes.flush();
    expect(git(repo, 'log', '--format=%s').split('\n')).toEqual([`goi: gỡ ${ID}@1.0.0`, `goi: cài ${ID}@1.0.0`, 'khởi tạo']);
  });

  it('the install needs the plan the owner saw: a change in between is refused', async () => {
    publish('1.0.0', samplePack().zip);
    const plan = await packs.preview(ID, '1.0.0', FOLDER);
    notes.owner().write({ folderId: FOLDER, relPath: 'bai-hoc/tra-loi-gia-ngay.md' }, '# của tôi\n', { message: 'x' });
    await expect(packs.install(ID, '1.0.0', FOLDER, plan.planId)).rejects.toThrow(PlanChangedError);
    await expect(packs.install(ID, '1.0.0', FOLDER, '0'.repeat(64))).rejects.toThrow(PlanChangedError);
    expect(packs.installed()).toEqual([]);
  });
});
