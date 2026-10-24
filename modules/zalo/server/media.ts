/**
 * Uploaded media for message templates. Files live under
 * <dataDir>/media with a random on-disk name; the original file name is
 * kept in the zalo_media row for display and for the name Zalo shows.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { ZALO_MEDIA_DIR } from './paths.js';
import {
  deleteZaloMediaRow,
  getZaloMedia,
  insertZaloMedia,
  isZaloMediaReferenced,
  listUnreferencedZaloMedia,
  type ZaloMediaRow,
} from './store.js';
import { logger } from './compat.js';

export { ZALO_MEDIA_DIR };

export const MAX_ZALO_MEDIA_BYTES = 25 * 1024 * 1024;

/** A file to send with a message. `path` is absolute on disk. */
export interface ZaloAttachment {
  path: string;
  kind: 'image' | 'file' | 'video';
  name?: string;
}

export class ZaloMediaError extends Error {
  constructor(message: string, readonly status: 400 | 413 = 400) {
    super(message);
    this.name = 'ZaloMediaError';
  }
}

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const VIDEO_MIMES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);

/** Magic-byte check: the declared mime comes from the client and is not trusted. */
function sniffImageMime(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

export function classifyMedia(buffer: Buffer, declaredMime: string): { kind: ZaloMediaRow['kind']; mime: string } {
  const sniffed = sniffImageMime(buffer);
  if (sniffed) return { kind: 'image', mime: sniffed };
  const mime = declaredMime.toLowerCase().split(';')[0].trim();
  // A declared image that failed the magic-byte check is sent as a plain file.
  if (VIDEO_MIMES.has(mime)) return { kind: 'video', mime };
  return { kind: 'file', mime: IMAGE_MIMES.has(mime) || !mime ? 'application/octet-stream' : mime };
}

/** Keep letters (incl. Vietnamese), digits and a few separators; never a path. */
export function safeMediaName(fileName: string): string {
  const base = path.basename(fileName.replace(/\\/g, '/')).normalize('NFC');
  const cleaned = base.replace(/[^\p{L}\p{N}._ ()-]/gu, '_').replace(/^\.+/, '').trim();
  const ext = path.extname(cleaned).slice(0, 12);
  const stem = cleaned.slice(0, cleaned.length - ext.length).slice(0, 100);
  return `${stem || 'tep'}${ext}`;
}

export function saveZaloMedia(buffer: Buffer, fileName: string, mime: string): ZaloMediaRow {
  if (buffer.length === 0) throw new ZaloMediaError('Tệp rỗng.');
  if (buffer.length > MAX_ZALO_MEDIA_BYTES) throw new ZaloMediaError('Tệp quá lớn (tối đa 25 MB).', 413);
  const name = safeMediaName(fileName);
  const { kind, mime: finalMime } = classifyMedia(buffer, mime);
  fs.mkdirSync(ZALO_MEDIA_DIR, { recursive: true, mode: 0o700 });
  // Random on-disk name: uploads never collide and a name cannot escape the dir.
  const relPath = `${crypto.randomUUID()}${path.extname(name).toLowerCase().replace(/[^.a-z0-9]/g, '')}`;
  fs.writeFileSync(path.join(ZALO_MEDIA_DIR, relPath), buffer, { mode: 0o600 });
  try {
    return insertZaloMedia({ file_name: name, mime: finalMime, kind, size: buffer.length, rel_path: relPath });
  } catch (err) {
    fs.rmSync(path.join(ZALO_MEDIA_DIR, relPath), { force: true });
    throw err;
  }
}

/** Absolute path of an upload, or null when unknown or outside ZALO_MEDIA_DIR. */
export function getZaloMediaPath(media: Pick<ZaloMediaRow, 'rel_path'>): string | null {
  const root = path.resolve(ZALO_MEDIA_DIR);
  const full = path.resolve(root, media.rel_path);
  return full.startsWith(root + path.sep) ? full : null;
}

export function deleteZaloMedia(id: number): boolean {
  const media = getZaloMedia(id);
  if (!media) return false;
  const full = getZaloMediaPath(media);
  if (full) fs.rmSync(full, { force: true });
  return deleteZaloMediaRow(id);
}

/** Delete these uploads unless another template still uses them. */
export function deleteOrphanedMedia(ids: number[]): void {
  for (const id of ids) {
    try {
      if (!isZaloMediaReferenced(id)) deleteZaloMedia(id);
    } catch (err) {
      logger.warn({ err, mediaId: id }, 'zalo media cleanup failed');
    }
  }
}

const ABANDONED_UPLOAD_SEC = 3 * 24 * 3600;

/** Drop uploads from editor sessions that were never saved into a template. */
export function sweepAbandonedMedia(): number {
  const stale = listUnreferencedZaloMedia(ABANDONED_UPLOAD_SEC);
  for (const m of stale) deleteOrphanedMedia([m.id]);
  return stale.length;
}
