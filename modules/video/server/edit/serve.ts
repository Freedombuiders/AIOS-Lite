// Serve a local file over HTTP with Range support (video seeking) — shared by media and composition routes.
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { Context } from 'hono';

const MIME: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', aac: 'audio/aac',
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
  html: 'text/html; charset=utf-8', json: 'application/json', txt: 'text/plain; charset=utf-8',
};

export function serveFile(c: Context, file: string): Response {
  const size = fs.statSync(file).size;
  let start = 0;
  let end = size - 1;
  const range = c.req.header('range');
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match && (match[1] || match[2])) {
      start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    } else { start = NaN; }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) {
      c.header('Content-Range', `bytes */${size}`);
      return c.body(null, 416);
    }
    c.header('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  c.header('Cache-Control', 'private, no-cache');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Accept-Ranges', 'bytes');
  c.header('Content-Type', MIME[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream');
  c.header('Content-Length', String(end - start + 1));
  const stream = Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream<Uint8Array>;
  return c.body(stream, range ? 206 : 200);
}
