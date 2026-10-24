/**
 * Media for Content Studio lives under FB_MEDIA_DIR (the only directory the
 * Composio SDK may upload from). Paths coming from the dashboard or an agent
 * are untrusted: they must resolve inside that directory.
 */

import fs from 'fs';
import path from 'path';

import { FB_MEDIA_DIR } from '../../../_lib/composio.js';
import type { FbMedia } from '../types.js';
import { FbError } from './errors.js';

const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic']);

export function inferMediaKind(file: string): 'video' | 'image' | null {
  const ext = path.extname(file).toLowerCase();
  if (VIDEO_EXT.has(ext)) return 'video';
  if (IMAGE_EXT.has(ext)) return 'image';
  return null;
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** True when `p` resolves inside FB_MEDIA_DIR (following symlinks when the file exists). */
export function isInsideMediaDir(p: string): boolean {
  if (!p || typeof p !== 'string' || p.includes('\0')) return false;
  const root = path.resolve(FB_MEDIA_DIR);
  const resolved = path.resolve(p);
  if (!isInside(root, resolved)) return false;
  try {
    const realRoot = fs.realpathSync(root);
    return isInside(realRoot, fs.realpathSync(resolved));
  } catch {
    // The file (or the media dir) does not exist yet: the lexical check is all there is.
    return true;
  }
}

/** Validates and normalises media coming from the API; throws FbError(400) on a bad path or kind. */
export function normalizeMedia(items: FbMedia[]): FbMedia[] {
  if (!Array.isArray(items)) throw new FbError(400, 'Danh sách tệp không hợp lệ.');
  if (items.length > 50) throw new FbError(400, 'Tối đa 50 tệp cho mỗi bài.');
  return items.map((m) => {
    if (!m || typeof m.path !== 'string') throw new FbError(400, 'Tệp không hợp lệ.');
    const abs = path.resolve(m.path);
    if (!isInsideMediaDir(abs)) {
      throw new FbError(400, `Tệp phải nằm trong thư mục media của Content Studio (${FB_MEDIA_DIR}).`);
    }
    const kind = m.kind === 'video' || m.kind === 'image' ? m.kind : inferMediaKind(abs);
    if (!kind) throw new FbError(400, `Không nhận diện được loại tệp: ${path.basename(abs)}.`);
    const out: FbMedia = { path: abs, kind };
    if (typeof m.durationS === 'number') out.durationS = m.durationS;
    if (typeof m.width === 'number') out.width = m.width;
    if (typeof m.height === 'number') out.height = m.height;
    return out;
  });
}

/** Throws unless every file exists (and is inside the media dir); used right before publishing. */
export function assertMediaReadable(items: FbMedia[]): void {
  for (const m of items) {
    if (!isInsideMediaDir(m.path)) throw new FbError(400, 'Tệp nằm ngoài thư mục media của Content Studio.');
    let st: fs.Stats;
    try {
      st = fs.statSync(m.path);
    } catch {
      throw new FbError(400, `Không tìm thấy tệp ${path.basename(m.path)}.`);
    }
    if (!st.isFile() || st.size === 0) throw new FbError(400, `Tệp ${path.basename(m.path)} rỗng hoặc không hợp lệ.`);
  }
}

/** The per-post media folder, `FB_MEDIA_DIR/<contentId>/`. */
export function contentMediaDir(contentId: number): string {
  return path.join(FB_MEDIA_DIR, String(contentId));
}

/**
 * Copies agent-supplied files into the post's media folder and returns them
 * as FbMedia. Sources may live anywhere readable; destinations never leave
 * FB_MEDIA_DIR.
 */
export function importMediaFiles(contentId: number, sources: string[], prefix = ''): FbMedia[] {
  const dir = contentMediaDir(contentId);
  fs.mkdirSync(dir, { recursive: true });
  const out: FbMedia[] = [];
  const used = new Set<string>();
  sources.forEach((src, i) => {
    const abs = path.resolve(src);
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      throw new FbError(400, `Không tìm thấy tệp: ${src}`);
    }
    if (!st.isFile()) throw new FbError(400, `Không phải tệp: ${src}`);
    const kind = inferMediaKind(abs);
    if (!kind) throw new FbError(400, `Không nhận diện được loại tệp: ${path.basename(abs)}`);
    if (isInside(dir, abs)) {
      out.push({ path: abs, kind });
      return;
    }
    let name = `${prefix}${String(i + 1).padStart(2, '0')}-${path.basename(abs).replace(/[^\w.\-]+/g, '_')}`;
    while (used.has(name)) name = `x-${name}`;
    used.add(name);
    const dest = path.join(dir, name);
    fs.copyFileSync(abs, dest);
    out.push({ path: dest, kind });
  });
  return out;
}

/** Removes a post's media folder (best effort). */
export function removeContentMedia(contentId: number): void {
  const dir = contentMediaDir(contentId);
  if (!isInsideMediaDir(dir)) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Leaving files behind is harmless.
  }
}
