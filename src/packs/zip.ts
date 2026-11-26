// A small, strict ZIP reader for packs. Reads the central directory first and rejects the whole archive when
// any entry is unsafe (path, symlink or other special file, encryption, unknown compression, duplicate name,
// too many files, declared sizes over the caps) before inflating a single byte. Then inflates one entry at a
// time with zlib's maxOutputLength set to what is left under the caps, so a zip bomb whose headers lie stops
// at the cap instead of being unpacked first. Nothing is written to disk.
import zlib from 'node:zlib';
import { MAX_ASSET_BYTES, MAX_NOTE_BYTES, MAX_PACK_BYTES, MAX_PACK_FILES, MAX_UNPACKED_BYTES, pathProblem } from './format.js';

export class PackError extends Error {
  readonly code = 'bad_request';
  constructor(
    readonly file: string,
    readonly reason: string,
  ) {
    super(`${file}: ${reason}`);
    this.name = 'PackError';
  }
}

export interface UnzipLimits {
  maxZipBytes: number;
  maxFiles: number;
  maxNoteBytes: number;
  maxAssetBytes: number;
  maxTotalBytes: number;
}

export const PACK_LIMITS: UnzipLimits = {
  maxZipBytes: MAX_PACK_BYTES,
  maxFiles: MAX_PACK_FILES,
  maxNoteBytes: MAX_NOTE_BYTES,
  maxAssetBytes: MAX_ASSET_BYTES,
  maxTotalBytes: MAX_UNPACKED_BYTES,
};

interface Entry {
  name: string;
  method: number;
  compSize: number;
  size: number;
  localOffset: number;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const utf8 = new TextDecoder('utf-8', { fatal: true });

function findEocd(buf: Buffer): number {
  const stop = Math.max(0, buf.length - (22 + 0xffff));
  for (let i = buf.length - 22; i >= stop; i--) if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  return -1;
}

const capOf = (name: string, l: UnzipLimits) => (name.startsWith('assets/') ? l.maxAssetBytes : l.maxNoteBytes);

function readCentralDirectory(buf: Buffer, limits: UnzipLimits): Entry[] {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new PackError('pack.zip', 'không đọc được file zip');
  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (disk !== 0 || cdDisk !== 0) throw new PackError('pack.zip', 'zip nhiều phần không được hỗ trợ');
  if (count === 0xffff || cdOffset === 0xffffffff) throw new PackError('pack.zip', 'zip64 không được hỗ trợ');
  if (count > limits.maxFiles + 1 + 64) throw new PackError('pack.zip', `gói có quá ${limits.maxFiles} file`);
  if (cdOffset + cdSize > eocd) throw new PackError('pack.zip', 'mục lục zip hỏng');

  const entries: Entry[] = [];
  const seen = new Set<string>();
  let files = 0;
  let declaredTotal = 0;
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== CEN_SIG) throw new PackError('pack.zip', 'mục lục zip hỏng');
    const madeBy = buf.readUInt16LE(p + 4);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const external = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    const end = p + 46 + nameLen + extraLen + commentLen;
    if (end > eocd) throw new PackError('pack.zip', 'mục lục zip hỏng');
    let name: string;
    try {
      name = utf8.decode(buf.subarray(p + 46, p + 46 + nameLen));
    } catch {
      throw new PackError('pack.zip', 'tên file trong zip không phải UTF-8');
    }
    p = end;

    if (seen.has(name)) throw new PackError(name, 'trùng tên trong zip');
    seen.add(name);
    if (flags & 0x1) throw new PackError(name, 'file được mã hoá');
    if (compSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new PackError(name, 'zip64 không được hỗ trợ');
    // Unix mode lives in the high 16 bits when the archive was made on a Unix host (3) or macOS (19).
    const host = madeBy >> 8;
    const mode = (external >>> 16) & 0xffff;
    const type = mode & S_IFMT;
    if ((host === 3 || host === 19) && type !== 0 && type !== S_IFREG && type !== S_IFDIR) {
      throw new PackError(name, type === 0o120000 ? 'liên kết tượng trưng (symlink) không được phép' : 'file đặc biệt không được phép');
    }

    const isDir = name.endsWith('/') || type === S_IFDIR || (external & 0x10) !== 0;
    if (isDir) {
      const dir = name.replace(/\/+$/, '');
      const problem = dir === 'notes' || dir === 'assets' ? null : pathProblem(`${dir}/x`);
      if (problem) throw new PackError(name, problem);
      if (size !== 0) throw new PackError(name, 'thư mục có nội dung');
      continue;
    }
    if (name !== 'pack.json') {
      const problem = pathProblem(name);
      if (problem) throw new PackError(name, problem);
      files += 1;
      if (files > limits.maxFiles) throw new PackError(name, `gói có quá ${limits.maxFiles} file`);
    }
    if (method !== 0 && method !== 8) throw new PackError(name, `kiểu nén ${method} không được hỗ trợ`);
    const cap = capOf(name, limits);
    if (size > cap) throw new PackError(name, `quá ${cap / 1024} KB`);
    declaredTotal += size;
    if (declaredTotal > limits.maxTotalBytes) throw new PackError(name, 'tổng dung lượng giải nén quá lớn');
    entries.push({ name, method, compSize, size, localOffset });
  }
  return entries;
}

export interface UnzipOptions {
  limits?: UnzipLimits;
  /** called before each entry is inflated (tests use it to prove inflation stops at the cap) */
  onInflate?(name: string): void;
}

/**
 * Every file in the zip (directories dropped), or a PackError naming the first problem. Either the whole
 * archive is accepted or nothing is returned.
 */
export function unzipPack(zip: Uint8Array, opts: UnzipOptions = {}): Map<string, Buffer> {
  const limits = opts.limits ?? PACK_LIMITS;
  if (zip.length > limits.maxZipBytes) throw new PackError('pack.zip', `quá ${limits.maxZipBytes / 1024 / 1024} MB`);
  const buf = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  const entries = readCentralDirectory(buf, limits);

  const out = new Map<string, Buffer>();
  let total = 0;
  for (const e of entries) {
    const lo = e.localOffset;
    if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== LOC_SIG) throw new PackError(e.name, 'zip hỏng');
    const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
    if (start + e.compSize > buf.length) throw new PackError(e.name, 'zip hỏng');
    const raw = buf.subarray(start, start + e.compSize);
    // never more than this entry's cap, nor more than what is left of the total
    const room = Math.min(capOf(e.name, limits), limits.maxTotalBytes - total);
    opts.onInflate?.(e.name);
    let data: Buffer;
    if (e.method === 0) {
      if (e.compSize !== e.size) throw new PackError(e.name, 'kích thước khai báo sai');
      if (e.size > room) throw new PackError(e.name, 'vượt trần dung lượng giải nén');
      data = Buffer.from(raw);
    } else {
      try {
        data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, room + 1) });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError) {
          throw new PackError(e.name, 'vượt trần dung lượng giải nén (zip bom?)');
        }
        throw new PackError(e.name, 'không giải nén được');
      }
      if (data.length > room) throw new PackError(e.name, 'vượt trần dung lượng giải nén (zip bom?)');
    }
    if (data.length !== e.size) throw new PackError(e.name, 'kích thước khai báo sai');
    total += data.length;
    out.set(e.name, data);
  }
  return out;
}
