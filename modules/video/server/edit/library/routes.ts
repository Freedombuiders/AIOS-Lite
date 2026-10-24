// Library endpoints under /api/video-edit/assets. Agent A's routes.ts calls registerVideoLibraryRoutes(app, { root }).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { filterLibrary, KIND_EXTENSIONS } from '../catalog/assets.js';
import { ASSET_KINDS, type AssetKind } from '../types.js';
import { matchesExtension } from './sniff.js';
import { cancelSeed, getSeedStatus, SEED_GROUPS, startSeed, type SeedDeps, type SeedGroup } from './seed.js';
import {
  addFile, assetFilePath, deleteAsset, findAsset, getLibrary, LibraryError, libraryTmpDir, rescanLibrary, updateAsset,
} from './store.js';

const P = '/edit';
const MB = 1024 * 1024;

const MAX_BY_KIND: Record<AssetKind, number> = {
  font: 25 * MB, lut: 10 * MB, image: 60 * MB, background: 60 * MB, icon: 20 * MB, overlay: 500 * MB,
  bgm: 300 * MB, sfx: 60 * MB, video: 4096 * MB, effect: 0, caption: 0,
};

const MIME: Record<string, string> = {
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', aac: 'audio/aac',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', cube: 'text/plain; charset=utf-8',
};

const nullableText = (max: number) => z.string().trim().max(max).nullable();
const patchSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: nullableText(1000),
  tags: z.array(z.string().trim().min(1).max(40)).max(30),
  mood: nullableText(40),
  bpm: z.number().min(20).max(300).nullable(),
  license: nullableText(200),
  attribution: nullableText(500),
  sourceUrl: z.union([z.literal(''), z.string().trim().url().max(500).refine((u) => /^https?:\/\//i.test(u), 'http(s)')]).nullable(),
  enabled: z.boolean(),
}).partial().strict();

const seedSchema = z.object({
  groups: z.array(z.enum(SEED_GROUPS as unknown as [SeedGroup, ...SeedGroup[]])).min(1).optional(),
}).strict();

function formatSize(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / MB))} MB`;
}

export interface VideoLibraryRouteOptions {
  root: string;
  /** Injectable for tests (fetch, ffmpeg, limits). */
  seed?: SeedDeps;
}

export function registerVideoLibraryRoutes(app: Hono, options: VideoLibraryRouteOptions): void {
  const { root } = options;

  const fail = (c: Context, status: 400 | 404 | 409 | 413 | 415 | 416 | 422 | 500, error: string, code?: string) =>
    c.json({ error, ...(code ? { code } : {}) }, status);

  const small = bodyLimit({
    maxSize: 256 * 1024,
    onError: (c) => fail(c, 413, 'Nội dung gửi lên quá lớn.', 'too_large'),
  });

  const guard = (fn: (c: Context) => Response | Promise<Response>) => async (c: Context): Promise<Response> => {
    try {
      return await fn(c);
    } catch (err) {
      if (err instanceof LibraryError) return fail(c, err.status, err.message, err.code);
      if (err instanceof z.ZodError) return fail(c, 400, 'Dữ liệu chưa hợp lệ. Kiểm tra lại các trường đã nhập.', 'invalid');
      return fail(c, 500, 'Có lỗi ở máy chủ. Thử lại sau ít giây.');
    }
  };

  const idOf = (c: Context) => c.req.param('id') ?? '';

  app.get(`${P}/assets`, guard((c) => {
    const kind = c.req.query('kind');
    if (kind && !ASSET_KINDS.some((k) => k.kind === kind)) return fail(c, 400, 'Loại mục không tồn tại.', 'bad_kind');
    const enabled = c.req.query('enabled');
    const result = filterLibrary(getLibrary(root), {
      kind: kind || undefined,
      q: c.req.query('q') || undefined,
      source: c.req.query('source') || undefined,
      enabled: enabled === '1' || enabled === 'true',
    });
    return c.json(result);
  }));

  // ── Starter pack (registered before the :id routes) ──
  app.get(`${P}/assets/seed`, (c) => c.json(getSeedStatus(root)));

  app.post(`${P}/assets/seed`, small, guard(async (c) => {
    const raw = await c.req.text();
    const body = raw.trim() ? seedSchema.parse(JSON.parse(raw)) : {};
    const status = getSeedStatus(root);
    if (status.state === 'running') return c.json({ ...status, code: 'busy', error: 'Bộ khởi đầu đang cài.' }, 409);
    return c.json(startSeed(root, { groups: body.groups, deps: options.seed }), 202);
  }));

  app.post(`${P}/assets/seed/cancel`, (c) => c.json(cancelSeed(root)));

  app.post(`${P}/assets/rescan`, guard(async (c) => c.json(await rescanLibrary(root))));

  // ── Upload: raw streamed body like the project upload ──
  app.post(`${P}/assets/upload`, guard(async (c) => {
    const kind = (c.req.query('kind') ?? '') as AssetKind;
    if (!ASSET_KINDS.some((k) => k.kind === kind)) return fail(c, 400, 'Chọn loại mục trước khi tải lên.', 'bad_kind');
    const exts = KIND_EXTENSIONS[kind];
    if (exts.length === 0) return fail(c, 400, 'Loại này không có file để tải lên.', 'bad_kind');

    let originalName = '';
    try { originalName = decodeURIComponent(c.req.header('x-file-name') ?? ''); } catch { /* keep empty */ }
    originalName = path.basename(originalName.replace(/\\/g, '/'));
    const ext = path.extname(originalName).slice(1).toLowerCase();
    if (!exts.includes(ext)) return fail(c, 415, `Loại này chỉ nhận file ${exts.join(', ')}.`, 'bad_extension');

    const max = Number(process.env.VIDEO_LIBRARY_MAX_UPLOAD_BYTES) || MAX_BY_KIND[kind];
    const declared = Number(c.req.header('content-length'));
    if (Number.isFinite(declared) && declared > max) return fail(c, 413, `File quá lớn (tối đa ${formatSize(max)}).`, 'too_large');
    const body = c.req.raw.body;
    if (!body) return fail(c, 400, 'Chưa có dữ liệu file.');

    const tmpDir = libraryTmpDir(root);
    fs.mkdirSync(tmpDir, { recursive: true });
    const temp = path.join(tmpDir, `upload-${randomUUID()}.tmp`);
    let bytes = 0;
    try {
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          bytes += chunk.length;
          if (bytes > max) cb(new Error('too_large')); else cb(null, chunk);
        },
      });
      try {
        await pipeline(Readable.fromWeb(body as never), counter, fs.createWriteStream(temp, { mode: 0o600 }));
      } catch (err) {
        if ((err as Error).message === 'too_large') return fail(c, 413, `File quá lớn (tối đa ${formatSize(max)}).`, 'too_large');
        return fail(c, 400, 'Tải file lên bị gián đoạn. Thử lại.');
      }
      if (bytes === 0) return fail(c, 400, 'File trống.');
      if (!matchesExtension(temp, ext)) return fail(c, 415, `Nội dung file không đúng định dạng .${ext}.`, 'bad_content');
      const asset = await addFile(root, { kind, tempPath: temp, fileName: originalName });
      return c.json({ asset }, 201);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }));

  app.get(`${P}/assets/:id`, guard((c) => {
    const asset = findAsset(root, idOf(c));
    return asset ? c.json({ asset }) : fail(c, 404, 'Không tìm thấy mục này.', 'not_found');
  }));

  app.patch(`${P}/assets/:id`, small, guard(async (c) => {
    const body = patchSchema.parse(await c.req.json().catch(() => null));
    return c.json({ asset: updateAsset(root, idOf(c), body) });
  }));

  app.delete(`${P}/assets/:id`, guard((c) => {
    const { deleted, asset } = deleteAsset(root, idOf(c));
    return c.json({ ok: true, deleted, asset });
  }));

  // ── File with Range ──
  app.get(`${P}/assets/:id/file`, guard((c) => {
    const asset = findAsset(root, idOf(c));
    if (!asset) return fail(c, 404, 'Không tìm thấy mục này.', 'not_found');
    const file = assetFilePath(root, asset);
    if (!file) return fail(c, 404, 'Mục này chưa có file.', 'no_file');

    const stat = fs.statSync(file);
    const size = stat.size;
    const etag = `"${size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}"`;
    if (c.req.header('if-none-match') === etag) return c.body(null, 304);

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
    const ext = path.extname(file).slice(1).toLowerCase();
    c.header('Cache-Control', 'private, no-cache');
    c.header('ETag', etag);
    c.header('X-Content-Type-Options', 'nosniff');
    // An uploaded SVG must not run script if someone opens the URL directly.
    c.header('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    c.header('Accept-Ranges', 'bytes');
    c.header('Content-Type', MIME[ext] ?? 'application/octet-stream');
    c.header('Content-Length', String(end - start + 1));
    if (c.req.query('download')) c.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`);
    const stream = Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream<Uint8Array>;
    return c.body(stream, range ? 206 : 200);
  }));
}
