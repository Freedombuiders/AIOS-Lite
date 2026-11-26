// Trust checks on a downloaded pack, in this order, each one before the next step can run:
//   1. size and SHA-256 of the bytes we received,
//   2. Ed25519 signature over signingMessage(id we asked for, version we asked for, hash we computed),
//      with a public key configured on this machine,
//   3. the zip (unzipPack: paths, symlinks, caps),
//   4. pack.json: schema, same id/version we asked for, every file declared with a matching SHA-256 and
//      nothing undeclared, each note's `loai` allowed for the module (checked here again, never trusting the cloud).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { FORBIDDEN_LOAI, MODULE_LOAI, frontMatterLoai, manifestSchema, signingMessage, type PackManifest } from './format.js';
import { PackError, unzipPack, type UnzipOptions } from './zip.js';

export const sha256Hex = (data: Uint8Array | string): string => crypto.createHash('sha256').update(data).digest('hex');

/** Publisher public keys: keyId → raw Ed25519 key, base64 (32 bytes). */
export type PackKeys = Record<string, string>;

/**
 * Keys from `AIOS_PACK_KEYS` (JSON object, for `wrangler dev` and tests) merged over `config/pack-keys.yaml`
 * (`keys: { <keyId>: <base64> }`). Invalid entries are dropped.
 */
export function loadPackKeys(configDir: string, env: NodeJS.ProcessEnv = process.env): PackKeys {
  const out: PackKeys = {};
  const add = (obj: unknown) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof v === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(k) && Buffer.from(v, 'base64').length === 32) out[k] = v;
    }
  };
  try {
    const doc = parseYaml(fs.readFileSync(path.join(configDir, 'pack-keys.yaml'), 'utf8')) as { keys?: unknown } | null;
    add(doc?.keys);
  } catch {
    /* no file: no keys */
  }
  if (env.AIOS_PACK_KEYS) {
    try {
      add(JSON.parse(env.AIOS_PACK_KEYS));
    } catch {
      /* ignore a malformed override */
    }
  }
  return out;
}

export function verifyPackSignature(opts: { keys: PackKeys; keyId: string; signature: string; packId: string; version: string; sha256: string }): boolean {
  const pub = Object.hasOwn(opts.keys, opts.keyId) ? opts.keys[opts.keyId] : undefined;
  if (!pub) return false;
  try {
    const raw = Buffer.from(pub, 'base64');
    const sig = Buffer.from(opts.signature, 'base64');
    if (raw.length !== 32 || sig.length !== 64) return false;
    const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });
    return crypto.verify(null, signingMessage(opts.packId, opts.version, opts.sha256), key, sig);
  } catch {
    return false;
  }
}

export class PackTrustError extends Error {
  readonly code = 'bad_request';
  constructor(message: string) {
    super(message);
    this.name = 'PackTrustError';
  }
}

/** What the cloud said about the release (POST /packs/:id/releases/:version/download). Only hints: we recompute. */
export interface ReleaseInfo {
  sha256?: string | null;
  signature: string | null;
  keyId: string | null;
  size?: number | null;
}

export interface PackNote {
  /** path inside the zip: notes/… */
  zipPath: string;
  /** path in the brain folder (zipPath without `notes/`) */
  relPath: string;
  loai: string;
  /** the note as published, before the import rules */
  text: string;
}

export interface VerifiedPack {
  manifest: PackManifest;
  sha256: string;
  notes: PackNote[];
  /** assets/… paths: verified, but not installed (see service.ts) */
  assets: string[];
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/** Signature first: a pack whose signature does not verify is never unzipped. */
export function verifyPack(zip: Uint8Array, want: { id: string; version: string }, info: ReleaseInfo, keys: PackKeys, unzipOpts?: UnzipOptions): VerifiedPack {
  const sha = sha256Hex(zip);
  if (info.size != null && info.size !== zip.length) throw new PackTrustError('Kích thước gói tải về không khớp với cloud. Đã huỷ, chưa mở gói.');
  if (info.sha256 && info.sha256 !== sha) throw new PackTrustError('SHA-256 của gói tải về không khớp với cloud. Đã huỷ, chưa mở gói.');
  if (!info.signature || !info.keyId) throw new PackTrustError('Gói chưa có chữ ký. Đã huỷ, chưa mở gói.');
  if (!Object.hasOwn(keys, info.keyId)) throw new PackTrustError(`Máy chưa tin khoá "${info.keyId}" của người phát hành (config/pack-keys.yaml). Đã huỷ, chưa mở gói.`);
  if (!verifyPackSignature({ keys, keyId: info.keyId, signature: info.signature, packId: want.id, version: want.version, sha256: sha })) {
    throw new PackTrustError(`Chữ ký của gói ${want.id}@${want.version} không hợp lệ. Đã huỷ, chưa mở gói.`);
  }

  const entries = unzipPack(zip, unzipOpts);
  const rawManifest = entries.get('pack.json');
  if (!rawManifest) throw new PackError('pack.json', 'thiếu pack.json ở gốc zip');
  let json: unknown;
  try {
    json = JSON.parse(strictUtf8.decode(rawManifest));
  } catch {
    throw new PackError('pack.json', 'không phải JSON UTF-8 hợp lệ');
  }
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) throw new PackError('pack.json', `trường "${parsed.error.issues[0]?.path.join('.') || '?'}" không hợp lệ`);
  const manifest = parsed.data;
  if (manifest.id !== want.id) throw new PackError('pack.json', `id "${manifest.id}" khác gói đã chọn "${want.id}"`);
  if (manifest.version !== want.version) throw new PackError('pack.json', `version "${manifest.version}" khác bản đã chọn "${want.version}"`);

  const declared = new Map<string, PackManifest['files'][number]>();
  for (const f of manifest.files) {
    if (declared.has(f.path)) throw new PackError(f.path, 'khai hai lần trong pack.json');
    declared.set(f.path, f);
  }
  for (const name of entries.keys()) {
    if (name !== 'pack.json' && !declared.has(name)) throw new PackError(name, 'có trong zip nhưng không khai trong pack.json');
  }

  const allowed = MODULE_LOAI[manifest.module];
  const notes: PackNote[] = [];
  const assets: string[] = [];
  const relSeen = new Set<string>();
  for (const [p, f] of declared) {
    const data = entries.get(p);
    if (!data) throw new PackError(p, 'khai trong pack.json nhưng không có trong zip');
    if (sha256Hex(data) !== f.sha256) throw new PackError(p, 'SHA-256 không khớp với pack.json');
    if (p.startsWith('assets/')) {
      if (f.loai) throw new PackError(p, 'file trong assets/ không có "loai"');
      assets.push(p);
      continue;
    }
    const loai = f.loai;
    if (!loai) throw new PackError(p, 'ghi chú thiếu "loai" trong pack.json');
    if (FORBIDDEN_LOAI.includes(loai)) throw new PackError(p, `gói không được mang dữ liệu loại "${loai}"`);
    if (!allowed.includes(loai)) throw new PackError(p, `loai "${loai}" không được phép trong gói ${manifest.module} (cho phép: ${allowed.join(', ')})`);
    let text: string;
    try {
      text = strictUtf8.decode(data);
    } catch {
      throw new PackError(p, 'ghi chú không phải UTF-8');
    }
    if (frontMatterLoai(text) !== loai) throw new PackError(p, `loai trong ghi chú khác pack.json ("${loai}")`);
    const relPath = p.slice('notes/'.length);
    // case-insensitive file systems (macOS, Windows) would make two of these the same file
    const key = relPath.toLowerCase();
    if (relSeen.has(key)) throw new PackError(p, 'trùng tên (không phân biệt hoa thường) với một ghi chú khác');
    relSeen.add(key);
    notes.push({ zipPath: p, relPath, loai, text });
  }
  notes.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return { manifest, sha256: sha, notes, assets: assets.sort() };
}
