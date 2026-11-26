import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { encodeUtf8 } from '../lib/encoding';
import { goodPack, note, rawPack } from '../../test/packs';
import { compareSemver, frontMatterLoai, pathProblem } from './format';
import { checkPackZip } from './zip-check';

const fail = async (zip: Uint8Array, expect_: Parameters<typeof checkPackZip>[1] = {}) => {
  try {
    await checkPackZip(zip, expect_);
  } catch (err) {
    return err as { file: string; reason: string };
  }
  throw new Error('expected the pack to be rejected');
};

describe('checkPackZip', () => {
  it('accepts a well-formed pack and counts its notes', async () => {
    const { zip } = await goodPack();
    const checked = await checkPackZip(zip, { id: 'tra-va-qua-tang-co-ban', version: '1.0.0', module: 'learn' });
    expect(checked.notesCount).toBe(2);
    expect(checked.manifest.files).toHaveLength(3);
  });

  it('rejects a path that climbs out with ..', async () => {
    const err = await fail(await rawPack({ 'notes/../../x.md': note('bai-hoc') }));
    expect(err.file).toBe('notes/../../x.md');
    expect(err.reason).toContain('..');
  });

  it.each([
    ['/etc/passwd.md', 'tuyệt đối'],
    ['notes\\x.md', '\\'],
    ['scripts/run.sh', 'notes/'],
    ['notes/a.txt', '.md'],
    ['notes//a.md', 'rỗng'],
  ])('rejects %s', async (path, reason) => {
    const err = await fail(await rawPack({ [path]: note('bai-hoc') }));
    expect(err.reason).toContain(reason);
  });

  it('rejects a file in the zip that pack.json does not declare', async () => {
    const zip = await rawPack(
      { 'notes/a.md': note('bai-hoc'), 'notes/extra.md': note('bai-hoc') },
      { declare: [{ path: 'notes/a.md', loai: 'bai-hoc' }] },
    );
    expect((await fail(zip)).file).toBe('notes/extra.md');
  });

  it('rejects a declared file missing from the zip', async () => {
    const zip = await rawPack({ 'notes/a.md': note('bai-hoc') }, {
      declare: [{ path: 'notes/a.md', loai: 'bai-hoc' }, { path: 'notes/ghost.md', data: note('bai-hoc'), loai: 'bai-hoc' }],
    });
    expect((await fail(zip)).file).toBe('notes/ghost.md');
  });

  it('rejects a SHA-256 mismatch', async () => {
    const zip = await rawPack({ 'notes/a.md': note('bai-hoc') }, { declare: [{ path: 'notes/a.md', loai: 'bai-hoc', sha256: '0'.repeat(64) }] });
    const err = await fail(zip);
    expect(err).toMatchObject({ file: 'notes/a.md' });
    expect(err.reason).toContain('SHA-256');
  });

  it('rejects a learn pack carrying a customer note (loai: khach-hang)', async () => {
    const err = await fail(await rawPack({ 'notes/khach-hang/chi-lan.md': note('khach-hang') }));
    expect(err.file).toBe('notes/khach-hang/chi-lan.md');
    expect(err.reason).toContain('khach-hang');
  });

  it('rejects a note whose front matter disagrees with pack.json', async () => {
    const zip = await rawPack({ 'notes/a.md': note('khach-hang') }, { declare: [{ path: 'notes/a.md', loai: 'bai-hoc' }] });
    expect((await fail(zip)).reason).toContain('khác pack.json');
  });

  it('rejects a note without loai', async () => {
    const zip = await rawPack({ 'notes/a.md': encodeUtf8('# Không có thuộc tính\n') }, { declare: [{ path: 'notes/a.md', loai: 'bai-hoc' }] });
    expect((await fail(zip)).file).toBe('notes/a.md');
  });

  it('rejects an asset over 512 KB', async () => {
    const err = await fail(await rawPack({ 'assets/big.png': new Uint8Array(512 * 1024 + 1) }));
    expect(err.file).toBe('assets/big.png');
  });

  it('rejects more than 500 files', async () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i <= 500; i++) files[`notes/n${i}.md`] = note('bai-hoc', String(i));
    expect((await fail(await rawPack(files))).reason).toContain('500');
  });

  it('rejects a manifest for another pack, version or module', async () => {
    const { zip } = await goodPack();
    expect((await fail(zip, { id: 'khac' })).file).toBe('pack.json');
    expect((await fail(zip, { version: '2.0.0' })).file).toBe('pack.json');
    expect((await fail(zip, { module: 'dream' })).file).toBe('pack.json');
  });

  it('rejects a missing or malformed pack.json and a corrupt zip', async () => {
    expect((await fail(zipSync({ 'notes/a.md': note('bai-hoc') }))).file).toBe('pack.json');
    expect((await fail(zipSync({ 'pack.json': encodeUtf8('{"id": 1}') }))).file).toBe('pack.json');
    expect((await fail(encodeUtf8('not a zip at all'))).file).toBe('pack.zip');
  });
});

describe('format helpers', () => {
  it('orders versions by semver', () => {
    expect(compareSemver('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareSemver('1.0.0-beta', '1.0.0')).toBeLessThan(0);
    expect(compareSemver('1.0.0-beta.2', '1.0.0-beta.10')).toBeLessThan(0);
    expect(compareSemver('2.0.0', '2.0.0')).toBe(0);
  });

  it('reads loai from front matter only', () => {
    expect(frontMatterLoai('---\nloai: "bai-hoc" # ghi chú\n---\nx')).toBe('bai-hoc');
    expect(frontMatterLoai('# tiêu đề\nloai: bai-hoc\n')).toBeNull();
  });

  it('accepts ordinary paths', () => {
    expect(pathProblem('notes/bai-hoc/video-huong-dan-ngan.md')).toBeNull();
    expect(pathProblem('assets/bia.png')).toBeNull();
  });
});
