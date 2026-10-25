// Small helpers shared by the two composition builders: the legacy one (../composition.ts) and the template
// one (./build.ts). Pure string and file helpers, nothing here depends on a plan.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { ResolvedAsset } from '../library-resolve.js';

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export const cssFont = (s: string) => s.replace(/['"\;{}<>]/g, '');
export const dbToGain = (db: number) => Math.min(3.98, Math.max(0, 10 ** (db / 20)));
export const safeColor = (c: string | undefined, fallback: string) => (c && /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : fallback);
/** A CSS value from the owner or a template (colour, shadow): nothing that can close a declaration or a tag. */
export const cssValue = (s: string | undefined, fallback = '') => (s ?? fallback).replace(/[;{}<>"'\\]/g, '').trim() || fallback;

/** Prevent an opaque photo from appearing as a rectangle in a cutout slot. */
export function pngHasAlpha(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const header = Buffer.alloc(26);
    if (fs.readSync(fd, header, 0, header.length, 0) !== header.length) return false;
    return header.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' && (header[25] === 4 || header[25] === 6);
  } catch { return false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function mediaName(a: ResolvedAsset): string {
  const slug = a.id.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'asset';
  const hash = createHash('sha1').update(a.file).digest('hex').slice(0, 6);
  return `${slug}-${hash}.${a.ext}`;
}
