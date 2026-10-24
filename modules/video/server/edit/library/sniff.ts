// Cheap magic-byte checks so a download or upload that claims to be a font/audio/image really is one.
// Nothing here executes content; it only looks at the first bytes.
import fs from 'node:fs';
import type { AssetKind } from '../types.js';

export type Sniffed = 'ttf' | 'otf' | 'woff' | 'mp3' | 'wav' | 'ogg' | 'm4a' | 'aac' | 'flac' | 'png' | 'jpg' | 'gif' | 'webp'
  | 'svg' | 'cube' | 'mp4' | 'webm' | 'zip' | 'unknown';

function readHead(file: string, bytes = 512): Buffer {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

export function sniffBuffer(b: Buffer): Sniffed {
  if (b.length < 4) return 'unknown';
  const ascii = (from: number, to: number) => b.subarray(from, to).toString('latin1');
  if (b[0] === 0x00 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return 'ttf';
  if (ascii(0, 4) === 'true') return 'ttf';
  if (ascii(0, 4) === 'OTTO') return 'otf';
  if (ascii(0, 4) === 'wOFF' || ascii(0, 4) === 'wOF2') return 'woff';
  if (ascii(0, 3) === 'ID3') return 'mp3';
  if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return 'aac'; // ADTS
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'mp3'; // MPEG frame sync
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'wav';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (ascii(0, 4) === 'OggS') return 'ogg';
  if (ascii(0, 4) === 'fLaC') return 'flac';
  if (b.length >= 12 && ascii(4, 8) === 'ftyp') return /^(qt|M4A|M4B)/.test(ascii(8, 11)) || ascii(8, 12) === 'M4A ' ? 'm4a' : 'mp4';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm';
  if (b[0] === 0x89 && ascii(1, 4) === 'PNG') return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (ascii(0, 4) === 'GIF8') return 'gif';
  if (ascii(0, 2) === 'PK') return 'zip';
  const text = b.toString('utf8', 0, Math.min(b.length, 512));
  if (/<svg[\s>]/i.test(text)) return 'svg';
  if (/^\s*(#|TITLE|DOMAIN_M|LUT_)/m.test(text) && /LUT_(3D|1D)_SIZE/.test(text)) return 'cube';
  return 'unknown';
}

export function sniffFile(file: string): Sniffed {
  try { return sniffBuffer(readHead(file, 2048)); } catch { return 'unknown'; }
}

const OK_BY_EXT: Record<string, Sniffed[]> = {
  ttf: ['ttf', 'otf'], otf: ['otf', 'ttf'],
  mp3: ['mp3'], wav: ['wav'], ogg: ['ogg'], m4a: ['m4a', 'mp4'], aac: ['aac', 'm4a'],
  png: ['png'], jpg: ['jpg'], jpeg: ['jpg'], gif: ['gif'], webp: ['webp'], svg: ['svg'], cube: ['cube'],
  mp4: ['mp4', 'm4a'], mov: ['mp4', 'm4a'], webm: ['webm'],
};

/** True when the file's real type is plausible for its extension. */
export function matchesExtension(file: string, ext: string): boolean {
  const allowed = OK_BY_EXT[ext.toLowerCase()];
  if (!allowed) return false;
  return allowed.includes(sniffFile(file));
}

export function kindAllowsExtension(kinds: Record<AssetKind, string[]>, kind: AssetKind, ext: string): boolean {
  return kinds[kind]?.includes(ext.toLowerCase()) ?? false;
}
