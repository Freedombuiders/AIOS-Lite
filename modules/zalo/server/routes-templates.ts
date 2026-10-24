/**
 * /api/m/zalo/templates + /api/m/zalo/media — message templates for the
 * Marketing pages. Mounted by dashboard-routes.ts behind the dashboard
 * token, CSRF and read-only middleware.
 *
 * Rendering for the preview happens here (not in the browser) so what the
 * operator sees is exactly what the workers will send.
 */

import fs from 'fs';

import type { Context, Hono } from 'hono';

import type { LeanRunInput, LeanRunResult } from '../../../src/modules/sdk.js';
import {
  createZaloTemplate,
  deleteZaloTemplate,
  getZaloMedia,
  getZaloTemplate,
  listZaloAccounts,
  listZaloTemplates,
  updateZaloTemplate,
  type ZaloTemplateInput,
  type ZaloTemplateRow,
} from './store.js';
import { logger } from './compat.js';
import {
  deleteOrphanedMedia,
  getZaloMediaPath,
  MAX_ZALO_MEDIA_BYTES,
  saveZaloMedia,
  sweepAbandonedMedia,
  ZaloMediaError,
} from './media.js';
import { markdownToRich, normalizeZaloStyles, trimRich } from './rich-text.js';
import { buildTemplateVars, renderTemplate, TEMPLATE_VARIABLES, validateTemplate, type TemplateVars } from './template.js';
import { generateTemplateVariants } from './variants.js';

export const MAX_TEMPLATE_NAME = 120;
export const MAX_TEMPLATE_TEXT = 4000;
export const MAX_TEMPLATE_IMAGES = 12;
export const MAX_TEMPLATE_FILES = 5;

function serialize(t: ZaloTemplateRow) {
  return {
    id: t.id,
    name: t.name,
    text: t.text,
    styles: t.styles,
    attachments: t.attachments.map((a) => ({ mediaId: a.mediaId, name: a.name ?? '', kind: a.kind })),
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

type Parsed = { ok: true; input: ZaloTemplateInput } | { ok: false; error: string };

function parseTemplateBody(raw: unknown): Parsed {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return { ok: false, error: 'Cần đặt tên cho mẫu tin.' };
  if (name.length > MAX_TEMPLATE_NAME) return { ok: false, error: `Tên mẫu tối đa ${MAX_TEMPLATE_NAME} ký tự.` };

  const rawText = typeof body.text === 'string' ? body.text : '';
  if (rawText.length > MAX_TEMPLATE_TEXT + 200) return { ok: false, error: `Nội dung tối đa ${MAX_TEMPLATE_TEXT} ký tự.` };
  // Trim through trimRich so the ranges stay on the words they were drawn on.
  const { text, styles } = trimRich(rawText, normalizeZaloStyles(body.styles, rawText.length));
  if (text.length > MAX_TEMPLATE_TEXT) return { ok: false, error: `Nội dung tối đa ${MAX_TEMPLATE_TEXT} ký tự.` };

  // Accept [id, ...] or [{ mediaId }, ...] (what GET returns).
  const rawAtt = Array.isArray(body.attachmentIds) ? body.attachmentIds : Array.isArray(body.attachments) ? body.attachments : [];
  const ids: number[] = [];
  for (const a of rawAtt) {
    const id = typeof a === 'number' ? a : a && typeof a === 'object' ? Number((a as { mediaId?: unknown }).mediaId) : NaN;
    if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'Tệp đính kèm không hợp lệ.' };
    if (!ids.includes(id)) ids.push(id);
  }
  let images = 0;
  let files = 0;
  for (const id of ids) {
    const media = getZaloMedia(id);
    if (!media) return { ok: false, error: 'Một tệp đính kèm không còn tồn tại, hãy tải lên lại.' };
    if (media.kind === 'image') images++;
    else files++;
  }
  if (images > MAX_TEMPLATE_IMAGES) return { ok: false, error: `Tối đa ${MAX_TEMPLATE_IMAGES} ảnh cho mỗi mẫu tin.` };
  if (files > MAX_TEMPLATE_FILES) return { ok: false, error: `Tối đa ${MAX_TEMPLATE_FILES} tệp (không phải ảnh) cho mỗi mẫu tin.` };

  if (!text && ids.length === 0) return { ok: false, error: 'Mẫu tin cần có nội dung hoặc tệp đính kèm.' };
  return { ok: true, input: { name, text, styles, attachmentIds: ids } };
}

function idParam(c: Context): number | null {
  const n = Number(c.req.param('id'));
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Small seeded PRNG so a preview can be re-rolled (or pinned) with a number. */
function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleVars(): TemplateVars {
  const nick = listZaloAccounts().find((a) => a.status === 'connected');
  return buildTemplateVars({
    threadName: 'Nguyễn Thị Lan',
    threadType: 'user',
    accountName: nick?.display_name || nick?.label || 'Shop',
  });
}

/** What the template routes need from the module context (kept tiny so tests can pass fakes). */
export interface TemplateRouteEnv {
  agentIds(): string[];
  runLean(input: LeanRunInput): Promise<LeanRunResult>;
}

export function registerZaloTemplateRoutes(app: Hono, env: TemplateRouteEnv): void {
  // ── Media ───────────────────────────────────────────────────────────
  app.post('/media', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.parseBody();
    } catch {
      return c.json({ error: 'Không đọc được dữ liệu tải lên.' }, 400);
    }
    const file = body.file;
    if (!file || typeof file === 'string' || typeof (file as File).arrayBuffer !== 'function') {
      return c.json({ error: 'Chưa chọn tệp.' }, 400);
    }
    const upload = file as File;
    if (upload.size > MAX_ZALO_MEDIA_BYTES) return c.json({ error: 'Tệp quá lớn (tối đa 25 MB).' }, 413);
    try {
      const media = saveZaloMedia(Buffer.from(await upload.arrayBuffer()), upload.name || 'tep', upload.type || '');
      // Opportunistic cleanup of uploads from editor sessions that never saved.
      try { sweepAbandonedMedia(); } catch (err) { logger.warn({ err }, 'zalo media sweep failed'); }
      return c.json({ media: { id: media.id, name: media.file_name, kind: media.kind, mime: media.mime, size: media.size } });
    } catch (err) {
      if (err instanceof ZaloMediaError) return c.json({ error: err.message }, err.status);
      logger.error({ err }, 'zalo media upload failed');
      return c.json({ error: 'Không lưu được tệp.' }, 500);
    }
  });

  app.get('/media/:id/raw', (c) => {
    const id = idParam(c);
    const media = id ? getZaloMedia(id) : undefined;
    const full = media ? getZaloMediaPath(media) : null;
    if (!media || !full || !fs.existsSync(full)) return c.json({ error: 'Không tìm thấy tệp.' }, 404);
    const data = fs.readFileSync(full);
    // Only verified images render inline; anything else downloads, so an
    // uploaded HTML/SVG can never run on the dashboard origin.
    const inline = media.kind === 'image';
    return new Response(new Uint8Array(data), {
      headers: {
        'content-type': inline ? media.mime : 'application/octet-stream',
        'content-length': String(data.length),
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'cache-control': 'private, max-age=3600',
        ...(inline ? {} : { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(media.file_name)}` }),
      },
    });
  });

  // ── Templates ───────────────────────────────────────────────────────
  app.get('/templates', (c) => c.json({ templates: listZaloTemplates().map(serialize) }));

  // Registered before /:id so "variables" is not read as an id.
  app.get('/templates/variables', (c) => c.json({ variables: TEMPLATE_VARIABLES }));

  app.get('/templates/:id', (c) => {
    const id = idParam(c);
    const t = id ? getZaloTemplate(id) : undefined;
    return t ? c.json({ template: serialize(t) }) : c.json({ error: 'Không tìm thấy mẫu tin.' }, 404);
  });

  app.post('/templates', async (c) => {
    const parsed = parseTemplateBody(await c.req.json().catch(() => null));
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const t = createZaloTemplate(parsed.input);
    return c.json({ template: serialize(t), warnings: validateTemplate(t.text) });
  });

  app.put('/templates/:id', async (c) => {
    const id = idParam(c);
    if (!id || !getZaloTemplate(id)) return c.json({ error: 'Không tìm thấy mẫu tin.' }, 404);
    const parsed = parseTemplateBody(await c.req.json().catch(() => null));
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const result = updateZaloTemplate(id, parsed.input);
    if (!result) return c.json({ error: 'Không tìm thấy mẫu tin.' }, 404);
    deleteOrphanedMedia(result.removedMediaIds);
    return c.json({ template: serialize(result.row), warnings: validateTemplate(result.row.text) });
  });

  app.delete('/templates/:id', (c) => {
    const id = idParam(c);
    const media = id ? deleteZaloTemplate(id) : null;
    if (media === null) return c.json({ error: 'Không tìm thấy mẫu tin.' }, 404);
    deleteOrphanedMedia(media);
    return c.json({ ok: true });
  });

  app.post('/templates/render', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const raw = typeof body?.text === 'string' ? body.text : '';
    if (raw.length > MAX_TEMPLATE_TEXT + 200) return c.json({ error: `Nội dung tối đa ${MAX_TEMPLATE_TEXT} ký tự.` }, 400);
    const vars = sampleVars();
    if (body?.vars && typeof body.vars === 'object') {
      for (const [k, v] of Object.entries(body.vars as Record<string, unknown>)) {
        if (typeof v === 'string') vars[k] = v.slice(0, 200);
      }
    }
    const seed = typeof body?.seed === 'number' && Number.isFinite(body.seed) ? body.seed : undefined;
    const rendered = renderTemplate(
      { text: raw, styles: normalizeZaloStyles(body?.styles, raw.length) },
      vars,
      seed === undefined ? {} : { rng: seededRng(seed) },
    );
    return c.json({ text: rendered.text, styles: rendered.styles, warnings: validateTemplate(raw) });
  });

  app.post('/templates/variants', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text) return c.json({ error: 'Hãy nhập nội dung mẫu tin trước.' }, 400);
    if (text.length > MAX_TEMPLATE_TEXT) return c.json({ error: `Nội dung tối đa ${MAX_TEMPLATE_TEXT} ký tự.` }, 400);
    const countRaw = Number(body?.count ?? 3);
    const count = Number.isFinite(countRaw) ? Math.min(Math.max(Math.round(countRaw), 2), 5) : 3;
    const agentId = typeof body?.agentId === 'string' && body.agentId ? body.agentId : 'main';
    if (!env.agentIds().includes(agentId)) return c.json({ error: 'Agent không tồn tại.' }, 400);
    const instructions = typeof body?.instructions === 'string' ? body.instructions.slice(0, 1000) : undefined;
    try {
      const result = await generateTemplateVariants({ agentId, text, count, instructions }, (i) => env.runLean(i));
      if (result.variants.length === 0) {
        return c.json({ error: result.error ? `Agent không viết được biến thể: ${result.error}` : 'Agent không trả về biến thể hợp lệ (có thể làm mất biến {…}). Thử lại nhé.' }, 502);
      }
      return c.json({
        variants: result.variants,
        // Same variants with the agent's **markdown** turned into Zalo styles.
        rich: result.variants.map((v) => markdownToRich(v)),
      });
    } catch (err) {
      logger.error({ err }, 'zalo template variants failed');
      return c.json({ error: 'Không chạy được agent.' }, 500);
    }
  });
}
