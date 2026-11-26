import { describe, expect, it } from 'vitest';
import { makeZip } from './test-packs.js';
import { PackError, unzipPack } from './zip.js';

const NOTE = '---\nloai: bai-hoc\n---\n';
const MB = 1024 * 1024;

function rejects(zip: Buffer, match: RegExp, inflated?: string[]) {
  let err: unknown;
  try {
    unzipPack(zip, { onInflate: (n) => inflated?.push(n) });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(PackError);
  expect((err as Error).message).toMatch(match);
}

describe('unzipPack', () => {
  it('reads stored and deflated entries, drops directories', () => {
    const files = unzipPack(makeZip([
      { name: 'pack.json', data: '{}' },
      { name: 'notes/', data: '' },
      { name: 'notes/bai-hoc/a.md', data: NOTE },
      { name: 'assets/x.svg', data: '<svg/>', method: 0 },
    ]));
    expect([...files.keys()]).toEqual(['pack.json', 'notes/bai-hoc/a.md', 'assets/x.svg']);
    expect(files.get('notes/bai-hoc/a.md')!.toString()).toBe(NOTE);
  });

  it('rejects the whole zip for "..", absolute paths, backslashes, paths outside notes/ and assets/, before inflating anything', () => {
    for (const [name, why] of [
      ['notes/../../.env', /\.\./],
      ['/etc/cron.d/x.md', /tuyệt đối/],
      ['C:/Windows/x.md', /tuyệt đối/],
      ['notes\\..\\x.md', /\\/],
      ['scripts/run.sh', /notes\/ hoặc assets\//],
      ['notes/a.exe', /\.md/],
      ['../notes/a.md', /\.\./],
    ] as const) {
      const inflated: string[] = [];
      // the bad entry comes last: nothing before it may be unpacked either
      rejects(makeZip([{ name: 'pack.json', data: '{}' }, { name: 'notes/ok.md', data: NOTE }, { name, data: NOTE }]), why, inflated);
      expect(inflated).toEqual([]);
    }
  });

  it('rejects symlinks and other special files, encrypted and duplicate entries', () => {
    rejects(makeZip([{ name: 'notes/link.md', data: '/etc/passwd', unixMode: 0o120777 }]), /symlink/);
    rejects(makeZip([{ name: 'assets/fifo', data: '', unixMode: 0o010644 }]), /đặc biệt/);
    rejects(makeZip([{ name: 'notes/a.md', data: NOTE }, { name: 'notes/a.md', data: NOTE }]), /trùng tên/);
    const enc = makeZip([{ name: 'notes/a.md', data: NOTE }]);
    // set the "encrypted" flag in the central directory entry
    const cen = enc.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    enc.writeUInt16LE(enc.readUInt16LE(cen + 8) | 1, cen + 8);
    rejects(enc, /mã hoá/);
    // a regular unix file is fine
    expect(unzipPack(makeZip([{ name: 'notes/a.md', data: NOTE, unixMode: 0o100644 }])).size).toBe(1);
  });

  it('honest sizes over the caps are refused from the headers alone', () => {
    const inflated: string[] = [];
    rejects(makeZip([{ name: 'notes/big.md', data: Buffer.alloc(MB + 1, 0x61) }]), /quá 1024 KB/, inflated);
    // 130 assets of 512 KB = 65 MB > 64 MB unpacked
    const many = Array.from({ length: 130 }, (_, i) => ({ name: `assets/a${i}.bin`, data: Buffer.alloc(512 * 1024) }));
    rejects(makeZip(many), /tổng dung lượng/, inflated);
    expect(inflated).toEqual([]);
  });

  it('zip bomb with lying headers: inflation stops at the cap, at that entry', () => {
    const inflated: string[] = [];
    const t0 = Date.now();
    // declares 100 bytes, inflates to 80 MB
    rejects(
      makeZip([
        { name: 'notes/a.md', data: NOTE },
        { name: 'notes/bom.md', data: Buffer.alloc(80 * MB), declaredSize: 100 },
        { name: 'notes/after.md', data: NOTE },
      ]),
      /vượt trần/,
      inflated,
    );
    expect(inflated).toEqual(['notes/a.md', 'notes/bom.md']);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('a lie about the size the other way is caught too', () => {
    rejects(makeZip([{ name: 'notes/a.md', data: NOTE, declaredSize: NOTE.length + 10 }]), /khai báo sai/);
  });

  it('too many files, garbage, oversize zip', () => {
    const many = Array.from({ length: 501 }, (_, i) => ({ name: `notes/n${i}.md`, data: 'x', method: 0 as const }));
    rejects(makeZip(many), /quá 500 file/);
    rejects(Buffer.from('not a zip at all'), /không đọc được/);
    expect(() => unzipPack(new Uint8Array(21 * MB))).toThrow(/quá 20 MB/);
  });
});
