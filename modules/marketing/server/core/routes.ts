/**
 * /api/m/marketing/* routes for the core workstream (status, settings, Pages, content,
 * calendar). See ../types.ts for the contract. Mounted behind the
 * dashboard token, CSRF and read-only middleware by registerFbStudioRoutes.
 */

import type { Context, Hono } from 'hono';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { getMimeType } from 'hono/utils/mime';
import { assertMediaReadable } from './media.js';

import { getFbPage } from '../store.js';
import { logger } from '../compat.js';
import {
  approveContent,
  calendarItems,
  createContent,
  deleteContentLocal,
  getContentDetail,
  listContent,
  returnContent,
  unscheduleContent,
  updateContent,
} from './content.js';
import { FbError } from './errors.js';
import { listPages, syncPages, updatePage } from './pages.js';
import { deleteRemote, publishNow } from './publisher.js';
import { getSettings, getStatus, updateSettings } from './status.js';
import { monthRange } from './time.js';

const DEFAULT_TZ = 'Asia/Ho_Chi_Minh';
const user = { kind: 'user' } as const;

const mediaSchema = z.object({
  path: z.string().min(1).max(2000),
  kind: z.enum(['video', 'image']),
  durationS: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
});

const formatSchema = z.enum(['reel', 'video', 'photo', 'album', 'text', 'link']);
const statusSchema = z.enum(['idea', 'draft', 'review', 'approved', 'scheduled', 'publishing', 'published', 'failed', 'missed', 'deleted']);

const contentSchema = z
  .object({
    pageId: z.string().min(1).max(64).nullable(),
    title: z.string(),
    caption: z.string(),
    format: formatSchema,
    pillar: z.string(),
    hookType: z.string(),
    cta: z.string(),
    campaign: z.string(),
    hooks: z.array(z.string()),
    linkUrl: z.string(),
    media: z.array(mediaSchema),
    status: statusSchema,
    scheduledAt: z.number().int().nullable(),
  })
  .partial();

const pageUpdateSchema = z
  .object({
    enabled: z.boolean(),
    role: z.string(),
    mainKpi: z.string(),
    timezone: z.string(),
    approvalRequired: z.boolean(),
    maxPostsPerDay: z.number(),
    minGapMinutes: z.number(),
    windowStart: z.string(),
    windowEnd: z.string(),
    graceMinutes: z.number(),
    brandVoice: z.string(),
    pillars: z.array(z.object({ name: z.string(), targetPct: z.number() })),
    writerAgent: z.string(),
    videoAgent: z.string(),
  })
  .partial();

const settingsSchema = z
  .object({
    composioApiKey: z.string(),
    apiBudgetPerHour: z.number(),
    enabled: z.boolean(),
  })
  .partial();

/** Reads and validates a JSON body; a malformed body is a 400, never a 500. */
async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new FbError(400, 'Nội dung gửi lên không phải JSON hợp lệ.');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? ` (${issue.path.join('.')})` : '';
    throw new FbError(400, `Dữ liệu không hợp lệ${where}: ${issue?.message ?? 'sai định dạng'}.`);
  }
  return parsed.data;
}

function contentId(c: Context): number {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) throw new FbError(400, 'Mã bài không hợp lệ.');
  return id;
}

function intQuery(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Wraps a handler so FbError becomes `{ error }` with its status and anything else a logged 500. */
function handle(fn: (c: Context) => Promise<Response> | Response): (c: Context) => Promise<Response> {
  return async (c) => {
    try {
      return await fn(c);
    } catch (err) {
      if (err instanceof FbError) return c.json({ error: err.message }, err.status);
      logger.error({ err: String(err), path: c.req.path }, 'fbstudio route failed');
      return c.json({ error: 'Lỗi không mong muốn, xem log máy chủ.' }, 500);
    }
  };
}

export function registerCoreRoutes(app: Hono): void {
  // ── Status and settings ────────────────────────────────────────────
  app.get('/status', handle(async (c) => c.json(await getStatus())));

  app.get('/settings', handle((c) => c.json(getSettings())));

  app.put('/settings', handle(async (c) => c.json(await updateSettings(await body(c, settingsSchema)))));

  // ── Pages ──────────────────────────────────────────────────────────
  app.get('/pages', handle((c) => c.json({ pages: listPages() })));

  app.post('/pages/sync', handle(async (c) => c.json({ pages: await syncPages() })));

  app.patch('/pages/:id', handle(async (c) => c.json(updatePage(c.req.param('id') ?? '', await body(c, pageUpdateSchema)))));

  // ── Content ────────────────────────────────────────────────────────
  app.get('/content', handle((c) => {
    const q = c.req.query();
    return c.json(listContent({
      status: q.status,
      page: q.page,
      format: q.format,
      pillar: q.pillar,
      q: q.q,
      limit: intQuery(q.limit, 50),
      offset: intQuery(q.offset, 0),
    }));
  }));

  app.post('/content', handle(async (c) => c.json(createContent(await body(c, contentSchema), user))));

  app.get('/content/:id', handle((c) => c.json(getContentDetail(contentId(c)))));

  // Serve only media attached to this content, behind the dashboard auth.
  app.get('/content/:id/media/:index', handle(async (c) => {
    const content = getContentDetail(contentId(c));
    const raw = c.req.param('index') ?? '';
    const index = /^\d+$/.test(raw) ? Number(raw) : -1;
    const media = content.media[index];
    if (!media) throw new FbError(404, 'Không tìm thấy media.');
    // A file deleted after publishing is "not found", not a bad request.
    if (!fs.existsSync(media.path)) throw new FbError(404, `Không tìm thấy tệp ${path.basename(media.path)}.`);
    assertMediaReadable([media]);
    const file = fs.realpathSync(media.path);
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
    c.header('Content-Type', getMimeType(file) ?? 'application/octet-stream');
    c.header('Content-Length', String(end - start + 1));
    const stream = Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream<Uint8Array>;
    return c.body(stream, range ? 206 : 200);
  }));

  app.patch('/content/:id', handle(async (c) => c.json(updateContent(contentId(c), await body(c, contentSchema), user))));

  app.delete('/content/:id', handle((c) => {
    deleteContentLocal(contentId(c));
    return c.json({ ok: true });
  }));

  app.post('/content/:id/approve', handle(async (c) => {
    const { scheduledAt } = await body(c, z.object({ scheduledAt: z.number().int().nullable().optional() }));
    return c.json(approveContent(contentId(c), scheduledAt));
  }));

  app.post('/content/:id/return', handle(async (c) => {
    const { feedback } = await body(c, z.object({ feedback: z.string() }));
    return c.json(returnContent(contentId(c), feedback));
  }));

  app.post('/content/:id/unschedule', handle((c) => c.json(unscheduleContent(contentId(c)))));

  app.post('/content/:id/publish-now', handle(async (c) => c.json(await publishNow(contentId(c)))));

  app.post('/content/:id/delete-remote', handle(async (c) => c.json(await deleteRemote(contentId(c)))));

  // ── Calendar ───────────────────────────────────────────────────────
  app.get('/calendar', handle((c) => {
    const month = c.req.query('month') ?? '';
    const pageId = c.req.query('page') || undefined;
    const tz = (pageId ? getFbPage(pageId)?.timezone : undefined) ?? DEFAULT_TZ;
    const range = monthRange(month, tz);
    if (!range) throw new FbError(400, 'Tháng phải có dạng YYYY-MM.');
    return c.json({ items: calendarItems(range.from, range.to, pageId) });
  }));
}
