// Pins the machine's copy of the pack format (format.ts) to the cloud's (cloud/src/packs/format.ts): same
// tables, caps, path rules, front matter reader, signed message and version order, on the same vectors.
import { describe, expect, it } from 'vitest';
import * as cloud from '../../cloud/src/packs/format';
import * as local from './format.js';

const PATHS = [
  'notes/bai-hoc/a.md', 'assets/bia.svg', 'pack.json', 'notes/../../.env', 'notes/../x.md', '/etc/passwd', 'C:/x.md',
  'notes\\a.md', 'notes/a.txt', 'notes', 'notes//a.md', 'notes/./a.md', 'other/a.md', 'assets/x', 'notes/a\u0000.md',
  'notes/.obsidian/a.md', 'notes/Bài học/Mở đầu.md', '../notes/a.md', 'assets/../notes/a.md',
];
const NOTES = [
  '---\nloai: bai-hoc\n---\n# x', '---\r\nloai: "cong-thuc"\r\n---\r\n', '\uFEFF---\nloai: kenh-dream # kênh\n---\n',
  '---\nten: x\n---\n', '# không có khối đầu', "---\nloai: 'mau-khach-hang'\nkhac: 1\n---", '---\nloai:\n---\n', '---\n  loai: x\n---\n',
];
const VERSIONS = ['1.0.0', '1.0.1', '1.1.0', '2.0.0', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.10', '1.0.0-alpha', '0.9.9', '10.0.0', '1.0.0-1', '1.0.0-rc.1'];

describe('pack format: machine copy == cloud', () => {
  it('same allowed loai per module, same modules, same caps', () => {
    expect(local.PACK_MODULES).toEqual(cloud.PACK_MODULES);
    expect(local.MODULE_LOAI).toEqual(cloud.MODULE_LOAI);
    expect([local.MAX_PACK_BYTES, local.MAX_PACK_FILES, local.MAX_ASSET_BYTES, local.MAX_NOTE_BYTES, local.MAX_UNPACKED_BYTES]).toEqual([
      cloud.MAX_PACK_BYTES, cloud.MAX_PACK_FILES, cloud.MAX_ASSET_BYTES, cloud.MAX_NOTE_BYTES, cloud.MAX_UNPACKED_BYTES,
    ]);
    // what the task pins, independently of either file
    expect(local.MODULE_LOAI).toEqual({
      brain: ['ho-so', 'giong-noi', 'san-pham', 'chinh-sach'], learn: ['bai-hoc', 'cong-thuc'], dream: ['cong-thuc', 'kenh-dream'], crm: ['mau-khach-hang'],
    });
    expect(local.MAX_NOTE_BYTES).toBe(1024 * 1024);
    expect(local.MAX_UNPACKED_BYTES).toBe(64 * 1024 * 1024);
    for (const loai of local.FORBIDDEN_LOAI) for (const list of Object.values(local.MODULE_LOAI)) expect(list).not.toContain(loai);
  });

  it('same verdict on every path vector', () => {
    for (const p of PATHS) expect([p, local.pathProblem(p)]).toEqual([p, cloud.pathProblem(p)]);
    expect(local.pathProblem('notes/../../.env')).not.toBeNull();
    expect(local.pathProblem('/etc/passwd')).not.toBeNull();
  });

  it('same loai read from front matter', () => {
    for (const n of NOTES) expect([n, local.frontMatterLoai(n)]).toEqual([n, cloud.frontMatterLoai(n)]);
  });

  it('same signed bytes, and they bind id and version', () => {
    const sha = 'ab'.repeat(32);
    const m = local.signingMessage('tra-va-qua-tang-co-ban', '1.0.0', sha);
    expect(Buffer.from(m)).toEqual(Buffer.from(cloud.signingMessage('tra-va-qua-tang-co-ban', '1.0.0', sha)));
    expect(Buffer.from(m).toString('utf8')).toBe(`agenticos-pack-v1\ntra-va-qua-tang-co-ban\n1.0.0\n${sha}`);
  });

  it('same semver order and same manifest schema', () => {
    for (const a of VERSIONS) for (const b of VERSIONS) expect([a, b, Math.sign(local.compareSemver(a, b))]).toEqual([a, b, Math.sign(cloud.compareSemver(a, b))]);
    const ok = { id: 'goi-mau', version: '1.0.0', name: 'Gói', module: 'learn', license: 'CC-BY-4.0', files: [{ path: 'notes/a.md', sha256: 'a'.repeat(64), loai: 'bai-hoc' }] };
    const bad = [{ ...ok, extra: 1 }, { ...ok, id: 'Goi' }, { ...ok, module: 'care' }, { ...ok, version: '1.0' }, { ...ok, license: ' ' }];
    expect(local.manifestSchema.safeParse(ok).success).toBe(cloud.manifestSchema.safeParse(ok).success);
    for (const b of bad) expect(local.manifestSchema.safeParse(b).success).toBe(cloud.manifestSchema.safeParse(b).success);
  });
});
