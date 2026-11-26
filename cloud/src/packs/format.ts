/**
 * The pack format, shared by the Worker (finalize, publish), the publisher CLI
 * (scripts/pack.ts) and, later, the importer on the owner's machine (T22).
 *
 *   pack.json
 *   notes/<path in the brain>.md   notes with front matter; `loai` is required
 *   assets/<name>                  illustrations, 512 KB each at most
 *
 * Platform-neutral: Web Crypto, fflate and zod only.
 */
import { z } from 'zod';
import { encodeUtf8 } from '../lib/encoding';

export const PACK_MODULES = ['brain', 'learn', 'dream', 'crm'] as const;
export type PackModule = (typeof PACK_MODULES)[number];

/**
 * Note kinds (`loai`, see section 4.2 of the plan) a pack of each module may
 * carry. Customer records (`khach-hang`) and per-shop measurements (`bai-dang`,
 * `video-dream`) are never allowed: a pack is shared knowledge, not anyone's data.
 */
export const MODULE_LOAI: Record<PackModule, readonly string[]> = {
  brain: ['ho-so', 'giong-noi', 'san-pham', 'chinh-sach'],
  learn: ['bai-hoc', 'cong-thuc'],
  dream: ['cong-thuc', 'kenh-dream'],
  crm: ['mau-khach-hang'],
};

export const MAX_PACK_BYTES = 20 * 1024 * 1024;
export const MAX_PACK_FILES = 500;
export const MAX_ASSET_BYTES = 512 * 1024;
export const MAX_NOTE_BYTES = 1024 * 1024;
/** Guard against zip bombs: total uncompressed size. */
export const MAX_UNPACKED_BYTES = 64 * 1024 * 1024;

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
export const PACK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const semverSchema = z.string().max(64).regex(SEMVER);
export const packIdSchema = z.string().min(3).max(80).regex(PACK_ID);

export const manifestFileSchema = z.object({
  path: z.string().min(1).max(300),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  loai: z.string().min(1).max(60).optional(),
}).strict();

export const manifestSchema = z.object({
  id: packIdSchema,
  version: semverSchema,
  name: z.string().trim().min(1).max(120),
  module: z.enum(PACK_MODULES),
  summary: z.string().max(500).optional(),
  industry: z.string().max(60).optional(),
  minAppVersion: semverSchema.optional(),
  license: z.string().trim().min(1).max(60),
  author: z.string().max(120).optional(),
  files: z.array(manifestFileSchema).max(MAX_PACK_FILES),
}).strict();

export type PackManifest = z.infer<typeof manifestSchema>;

/** Compares two semver strings: negative, zero or positive. Pre-releases sort before the release. */
export function compareSemver(a: string, b: string): number {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (!pa || !pb) return a < b ? -1 : a > b ? 1 : 0;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return d;
  }
  if (pa[4] === pb[4]) return 0;
  if (!pa[4]) return 1;
  if (!pb[4]) return -1;
  const xa = pa[4].split('.');
  const xb = pb[4].split('.');
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1;
    if (xb[i] === undefined) return 1;
    const na = /^\d+$/.test(xa[i]);
    const nb = /^\d+$/.test(xb[i]);
    if (na && nb && Number(xa[i]) !== Number(xb[i])) return Number(xa[i]) - Number(xb[i]);
    if (na !== nb) return na ? -1 : 1;
    if (xa[i] !== xb[i]) return xa[i] < xb[i] ? -1 : 1;
  }
  return 0;
}

/** Why a path is unsafe or out of place, or null when it is fine. */
export function pathProblem(path: string): string | null {
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return 'đường dẫn tuyệt đối';
  if (path.includes('\\')) return 'có dấu \\';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return 'có ký tự điều khiển';
  const parts = path.split('/');
  if (parts.some((p) => p === '..')) return 'có ".."';
  if (parts.some((p) => p === '' || p === '.')) return 'có đoạn rỗng hoặc "."';
  if (parts[0] !== 'notes' && parts[0] !== 'assets') return 'không nằm dưới notes/ hoặc assets/';
  if (parts.length < 2) return 'thiếu tên file';
  if (parts[0] === 'notes' && !path.endsWith('.md')) return 'ghi chú phải là file .md';
  return null;
}

/** `loai` from a note's YAML front matter, or null when there is none. */
export function frontMatterLoai(text: string): string | null {
  const body = text.replace(/^﻿/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body);
  if (!m) return null;
  const line = /^loai:[ \t]*(.*?)[ \t]*(?:#.*)?$/m.exec(m[1]);
  if (!line) return null;
  return line[1].replace(/^(['"])(.*)\1$/, '$2').trim() || null;
}

/**
 * What the publisher signs with Ed25519: the zip's SHA-256 bound to the pack
 * id and version, so a signature cannot be replayed onto another pack or
 * version. The importer on the machine rebuilds the same bytes to verify.
 */
export function signingMessage(packId: string, version: string, sha256Hex: string): Uint8Array {
  return encodeUtf8(`agenticos-pack-v1\n${packId}\n${version}\n${sha256Hex}`);
}
