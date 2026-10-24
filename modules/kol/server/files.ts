/**
 * File plumbing for KOL Studio: raw-body uploads, magic-byte sniffing, image
 * normalisation, thumbnails and video probing (ffmpeg / ffprobe, found like
 * Video Studio does: VIDEO_EDIT_FFMPEG / VIDEO_EDIT_FFPROBE, default on PATH).
 * Every path handed out here is inside KOL_DIR.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { Context } from 'hono';
import { imageSize } from 'image-size';

import { logger } from './compat.js';
import { sniffBuffer } from './sniff.js';
import { ensureKolDir, KolError, kolPaths } from './core.js';

export const MAX_IMAGE_UPLOAD = 25 * 1024 * 1024;
export const MAX_VIDEO_UPLOAD = 300 * 1024 * 1024;
/** Longest side of a stored reference/template image. Bigger uploads are re-encoded as JPEG. */
export const MAX_IMAGE_SIDE = 2048;

export type ImageExt = 'jpg' | 'png' | 'webp';
export type MediaExt = ImageExt | 'mp4' | 'webm' | 'mp3' | 'wav' | 'm4a' | 'ogg';

export const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', aac: 'audio/aac',
};

export const mimeForExt = (ext: string): string => MIME_BY_EXT[ext.toLowerCase()] ?? 'application/octet-stream';

// ── Sniffing ─────────────────────────────────────────────────────────

/** The real image type of a buffer, or null when it is not a JPEG/PNG/WebP. */
export function sniffImage(head: Buffer): ImageExt | null {
  const t = sniffBuffer(head);
  return t === 'jpg' || t === 'png' || t === 'webp' ? t : null;
}

/** Real media type of downloaded provider output. */
export function sniffMedia(head: Buffer): { kind: 'image' | 'video' | 'audio'; ext: MediaExt; mime: string } | null {
  const t = sniffBuffer(head);
  switch (t) {
    case 'jpg': case 'png': case 'webp': return { kind: 'image', ext: t, mime: mimeForExt(t) };
    case 'mp4': return { kind: 'video', ext: 'mp4', mime: 'video/mp4' };
    case 'webm': return { kind: 'video', ext: 'webm', mime: 'video/webm' };
    case 'mp3': return { kind: 'audio', ext: 'mp3', mime: 'audio/mpeg' };
    case 'wav': return { kind: 'audio', ext: 'wav', mime: 'audio/wav' };
    case 'm4a': return { kind: 'audio', ext: 'm4a', mime: 'audio/mp4' };
    case 'ogg': return { kind: 'audio', ext: 'ogg', mime: 'audio/ogg' };
    default: return null;
  }
}

export function readHead(file: string, bytes = 4096): Buffer {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

/** Width/height of an image file, or nulls when unreadable. */
export function imageDims(file: string): { width: number | null; height: number | null } {
  try {
    const info = imageSize(fs.readFileSync(file));
    let { width, height } = info;
    // EXIF orientations 5–8 swap the displayed sides.
    if (info.orientation && info.orientation >= 5) [width, height] = [height, width];
    return { width: width || null, height: height || null };
  } catch {
    return { width: null, height: null };
  }
}

// ── External tools ───────────────────────────────────────────────────

export const ffmpegBin = (): string => process.env.VIDEO_EDIT_FFMPEG?.trim() || 'ffmpeg';
export const ffprobeBin = (): string => process.env.VIDEO_EDIT_FFPROBE?.trim() || 'ffprobe';

export function runBin(bin: string, args: string[], timeoutMs = 60_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

/** Thumbnail: 512 px wide JPEG. Video: the frame at 0.5 s. Returns false when ffmpeg is missing or fails. */
export async function makeThumbnail(src: string, dest: string, kind: 'image' | 'video'): Promise<boolean> {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
  if (kind === 'video') args.push('-ss', '0.5');
  args.push('-i', src, '-frames:v', '1', '-vf', "scale='min(512,iw)':-2", '-q:v', '4', dest);
  const res = await runBin(ffmpegBin(), args, 60_000);
  if (res.code !== 0 || !fs.existsSync(dest) || fs.statSync(dest).size === 0) {
    fs.rmSync(dest, { force: true });
    // A very short video has no frame at 0.5 s: retry from the start.
    if (kind === 'video') {
      const retry = await runBin(ffmpegBin(), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', src, '-frames:v', '1', '-vf', "scale='min(512,iw)':-2", '-q:v', '4', dest], 60_000);
      if (retry.code === 0 && fs.existsSync(dest) && fs.statSync(dest).size > 0) return true;
      fs.rmSync(dest, { force: true });
    }
    return false;
  }
  return true;
}

/** Duration and size of a video/audio file, or null when ffprobe fails. */
export async function probeMedia(file: string): Promise<{ durationSec: number | null; width: number | null; height: number | null } | null> {
  const res = await runBin(ffprobeBin(), ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], 30_000);
  if (res.code !== 0) return null;
  try {
    const json = JSON.parse(res.stdout) as { streams?: { codec_type?: string; width?: number; height?: number; duration?: string }[]; format?: { duration?: string } };
    const video = json.streams?.find((s) => s.codec_type === 'video');
    const d = Number(json.format?.duration ?? video?.duration);
    return {
      durationSec: Number.isFinite(d) && d > 0 ? Math.round(d * 100) / 100 : null,
      width: video?.width ?? null,
      height: video?.height ?? null,
    };
  } catch {
    return null;
  }
}

// ── Ingest ───────────────────────────────────────────────────────────

export interface StoredImage {
  /** Absolute path of the stored file. */
  abs: string;
  ext: ImageExt;
  mime: string;
  width: number | null;
  height: number | null;
  bytes: number;
}

/**
 * Checks that `src` is a real JPEG/PNG/WebP and stores it as `<destDir>/<stem>.<ext>`.
 * Images larger than MAX_IMAGE_SIDE are re-encoded to a JPEG that fits (ffmpeg);
 * when ffmpeg is unavailable the original is kept. `src` is moved, not copied,
 * unless `keepSource` is set.
 */
export async function storeImage(src: string, destDir: string, stem: string, opts: { keepSource?: boolean } = {}): Promise<StoredImage> {
  const ext = sniffImage(readHead(src));
  if (!ext) throw new KolError(415, 'Chỉ nhận ảnh JPEG, PNG hoặc WebP.', 'bad_type');
  fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
  const dims = imageDims(src);
  if (!dims.width || !dims.height) throw new KolError(422, 'Không đọc được kích thước ảnh. Tệp có thể bị hỏng.', 'bad_image');

  if (Math.max(dims.width, dims.height) > MAX_IMAGE_SIDE) {
    const out = path.join(destDir, `${stem}.jpg`);
    const scale = dims.width >= dims.height ? `${MAX_IMAGE_SIDE}:-2` : `-2:${MAX_IMAGE_SIDE}`;
    const res = await runBin(ffmpegBin(), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', src, '-vf', `scale=${scale}`, '-q:v', '2', out], 120_000);
    if (res.code === 0 && fs.existsSync(out) && sniffImage(readHead(out)) === 'jpg') {
      if (!opts.keepSource) fs.rmSync(src, { force: true });
      const d = imageDims(out);
      return { abs: out, ext: 'jpg', mime: 'image/jpeg', width: d.width, height: d.height, bytes: fs.statSync(out).size };
    }
    fs.rmSync(out, { force: true });
    logger.warn({ code: res.code }, 'KOL: could not downscale an image with ffmpeg; keeping the original');
  }

  const out = path.join(destDir, `${stem}.${ext}`);
  if (opts.keepSource) fs.copyFileSync(src, out);
  else moveFile(src, out);
  return { abs: out, ext, mime: mimeForExt(ext), width: dims.width, height: dims.height, bytes: fs.statSync(out).size };
}

export function moveFile(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch {
    fs.copyFileSync(from, to);
    fs.rmSync(from, { force: true });
  }
}

export function removeQuiet(abs: string | null | undefined): void {
  if (!abs) return;
  try { fs.rmSync(abs, { force: true }); } catch { /* ignore */ }
}

/** A fresh temp path inside KOL_DIR/tmp. */
export function tempPath(suffix = '.tmp'): string {
  const dir = ensureKolDir(kolPaths.tmp());
  return path.join(dir, `${randomUUID()}${suffix}`);
}

export function formatMb(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

/**
 * Streams the raw request body into a temp file with a hard size cap.
 * Header `x-file-name` (URI-encoded) gives the original name (informational only).
 */
export async function readUploadToTemp(c: Context, maxBytes: number): Promise<{ temp: string; bytes: number; fileName: string }> {
  let fileName = '';
  try { fileName = decodeURIComponent(c.req.header('x-file-name') ?? ''); } catch { /* keep empty */ }
  fileName = path.basename(fileName.replace(/\\/g, '/')).slice(0, 200);
  const declared = Number(c.req.header('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new KolError(413, `Tệp quá lớn (tối đa ${formatMb(maxBytes)}).`, 'too_large');
  const body = c.req.raw.body;
  if (!body) throw new KolError(400, 'Chưa có dữ liệu tệp.');
  const temp = tempPath('.upload');
  let bytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > maxBytes) cb(new Error('too_large'));
      else cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(body as never), counter, fs.createWriteStream(temp, { mode: 0o600 }));
  } catch (err) {
    fs.rmSync(temp, { force: true });
    if ((err as Error).message === 'too_large') throw new KolError(413, `Tệp quá lớn (tối đa ${formatMb(maxBytes)}).`, 'too_large');
    throw new KolError(400, 'Tải tệp lên bị gián đoạn. Thử lại.');
  }
  if (bytes === 0) {
    fs.rmSync(temp, { force: true });
    throw new KolError(400, 'Tệp trống.');
  }
  return { temp, bytes, fileName };
}
