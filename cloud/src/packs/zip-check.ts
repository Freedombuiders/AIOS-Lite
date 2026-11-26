/**
 * Checks a pack zip before it can be published: size and file limits, safe
 * paths under notes/ or assets/, pack.json against the schema, every file
 * declared with a matching SHA-256 and nothing undeclared, and each note's
 * `loai` allowed for the pack's module. Throws PackError naming the file.
 */
import { unzipSync, type UnzipFileInfo } from 'fflate';
import { sha256Hex } from '../lib/encoding';
import {
  MAX_ASSET_BYTES, MAX_NOTE_BYTES, MAX_PACK_BYTES, MAX_PACK_FILES, MAX_UNPACKED_BYTES, MODULE_LOAI,
  frontMatterLoai, manifestSchema, pathProblem, type PackManifest,
} from './format';

export class PackError extends Error {
  constructor(readonly file: string, readonly reason: string) {
    super(`${file}: ${reason}`);
    this.name = 'PackError';
  }
}

export interface PackExpectation { id?: string; version?: string; module?: string }

export interface CheckedPack {
  manifest: PackManifest;
  notesCount: number;
  files: Map<string, Uint8Array>;
}

export async function checkPackZip(zip: Uint8Array, expect: PackExpectation = {}): Promise<CheckedPack> {
  if (zip.length > MAX_PACK_BYTES) throw new PackError('pack.zip', `quá ${MAX_PACK_BYTES / 1024 / 1024} MB`);

  // Look at every entry's declared size before inflating anything.
  const seen = new Set<string>();
  let declaredTotal = 0;
  let fileCount = 0;
  let firstProblem: PackError | undefined;
  const filter = (info: UnzipFileInfo): boolean => {
    if (firstProblem) return false;
    const name = info.name;
    if (seen.has(name)) { firstProblem = new PackError(name, 'trùng tên trong zip'); return false; }
    seen.add(name);
    if (name.endsWith('/')) {
      const dir = name.slice(0, -1);
      const problem = dir === 'notes' || dir === 'assets' ? null : pathProblem(`${dir}/x`);
      if (problem) firstProblem = new PackError(name, problem);
      return false;
    }
    if (name !== 'pack.json') {
      const problem = pathProblem(name);
      if (problem) { firstProblem = new PackError(name, problem); return false; }
      fileCount += 1;
      if (fileCount > MAX_PACK_FILES) { firstProblem = new PackError(name, `gói có quá ${MAX_PACK_FILES} file`); return false; }
      const cap = name.startsWith('assets/') ? MAX_ASSET_BYTES : MAX_NOTE_BYTES;
      if (info.originalSize > cap) { firstProblem = new PackError(name, `quá ${cap / 1024} KB`); return false; }
    }
    declaredTotal += info.originalSize;
    if (declaredTotal > MAX_UNPACKED_BYTES) { firstProblem = new PackError(name, 'tổng dung lượng giải nén quá lớn'); return false; }
    return true;
  };

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zip, { filter });
  } catch {
    throw firstProblem ?? new PackError('pack.zip', 'không đọc được file zip');
  }
  if (firstProblem) throw firstProblem;

  // The declared sizes could lie; check the real ones.
  let total = 0;
  for (const [name, data] of Object.entries(entries)) {
    total += data.length;
    const cap = name === 'pack.json' ? MAX_NOTE_BYTES : name.startsWith('assets/') ? MAX_ASSET_BYTES : MAX_NOTE_BYTES;
    if (data.length > cap) throw new PackError(name, `quá ${cap / 1024} KB`);
  }
  if (total > MAX_UNPACKED_BYTES) throw new PackError('pack.zip', 'tổng dung lượng giải nén quá lớn');

  const rawManifest = entries['pack.json'];
  if (!rawManifest) throw new PackError('pack.json', 'thiếu pack.json ở gốc zip');
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(rawManifest));
  } catch {
    throw new PackError('pack.json', 'không phải JSON UTF-8 hợp lệ');
  }
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new PackError('pack.json', `trường "${issue?.path.join('.') || '?'}" không hợp lệ`);
  }
  const manifest = parsed.data;
  if (expect.id && manifest.id !== expect.id) throw new PackError('pack.json', `id "${manifest.id}" khác gói "${expect.id}"`);
  if (expect.version && manifest.version !== expect.version) throw new PackError('pack.json', `version "${manifest.version}" khác bản phát hành "${expect.version}"`);
  if (expect.module && manifest.module !== expect.module) throw new PackError('pack.json', `module "${manifest.module}" khác gói "${expect.module}"`);

  const declared = new Map<string, PackManifest['files'][number]>();
  for (const f of manifest.files) {
    const problem = pathProblem(f.path);
    if (problem) throw new PackError(f.path, problem);
    if (declared.has(f.path)) throw new PackError(f.path, 'khai hai lần trong pack.json');
    declared.set(f.path, f);
  }

  const files = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(entries)) {
    if (name === 'pack.json') continue;
    if (!declared.has(name)) throw new PackError(name, 'có trong zip nhưng không khai trong pack.json');
    files.set(name, data);
  }

  const allowed = MODULE_LOAI[manifest.module];
  let notesCount = 0;
  for (const [path, f] of declared) {
    const data = files.get(path);
    if (!data) throw new PackError(path, 'khai trong pack.json nhưng không có trong zip');
    if ((await sha256Hex(data)) !== f.sha256) throw new PackError(path, 'SHA-256 không khớp với pack.json');
    if (path.startsWith('notes/')) {
      notesCount += 1;
      if (!f.loai) throw new PackError(path, 'ghi chú thiếu "loai" trong pack.json');
      if (!allowed.includes(f.loai)) throw new PackError(path, `loai "${f.loai}" không được phép trong gói ${manifest.module} (cho phép: ${allowed.join(', ')})`);
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(data);
      } catch {
        throw new PackError(path, 'ghi chú không phải UTF-8');
      }
      const noteLoai = frontMatterLoai(text);
      if (noteLoai !== f.loai) throw new PackError(path, `loai trong ghi chú ("${noteLoai ?? 'không có'}") khác pack.json ("${f.loai}")`);
    } else if (f.loai) {
      throw new PackError(path, 'file trong assets/ không có "loai"');
    }
  }
  return { manifest, notesCount, files };
}
