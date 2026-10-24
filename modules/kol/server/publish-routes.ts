/**
 * HTTP API of KOL Studio's publish & growth side (contract: types.ts,
 * "PUBLISH & GROWTH"). JSON in and out; errors are { error } in Vietnamese
 * with the KolError status.
 */

import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z, ZodError } from 'zod';

import { KillSwitchDisabledError } from './compat.js';
import { logger } from './compat.js';
import { deleteAccount, linkAccount, listAccounts, listAllAccounts, listKolConnections, refreshAccount, updateAccount } from './accounts.js';
import { runAutopilotNow } from './autopilot.js';
import { writeCaptionVariants } from './captions.js';
import { KolError } from './core.js';
import { computeGrowth } from './metrics.js';
import { requirePersona } from './personas.js';
import {
  approvePost,
  cancelPost,
  createPost,
  listPosts,
  postInputSchema,
  publishNowPost,
  recomputePostStatus,
  requirePost,
  retryTarget,
  returnPost,
  setPostVariants,
  submitPost,
  updatePost,
} from './posts.js';
import { kickPublisher } from './publisher.js';
import { listRadarIdeas } from './radar-ideas.js';
import { PLATFORMS, canEdit } from './schedule-rules.js';
import { listInsights, runWeeklyReview } from './strategist.js';
import type { AccountInput, Platform } from './types.js';

const platformSchema = z.enum(PLATFORMS as [Platform, ...Platform[]], { message: 'Nền tảng phải là facebook, instagram, tiktok hoặc youtube.' });

const linkSchema = z.object({
  platform: platformSchema,
  connectionId: z.string().trim().max(200).default(''),
  externalId: z.string().trim().max(200).optional(),
});

const accountPatchSchema = z.object({
  connectionId: z.string().trim().min(1).max(200).optional(),
  externalId: z.string().trim().max(200).optional(),
  handle: z.string().max(120).optional(),
  displayName: z.string().max(200).optional(),
  pictureUrl: z.string().max(2000).optional(),
  enabled: z.boolean().optional(),
  autoPublish: z.boolean().optional(),
  maxPostsPerDay: z.number().int().optional(),
  minGapMinutes: z.number().int().optional(),
  windowStart: z.string().max(5).optional(),
  windowEnd: z.string().max(5).optional(),
  timezone: z.string().max(64).optional(),
  tiktokPrivacy: z.string().max(40).optional(),
  youtubePrivacy: z.enum(['public', 'unlisted', 'private'], { message: 'Chế độ hiển thị YouTube phải là public, unlisted hoặc private.' }).optional(),
  youtubeCategory: z.string().max(4).optional(),
});

const createPostSchema = postInputSchema.extend({ personaId: z.string().trim().min(1, 'Thiếu personaId.') });

const captionsSchema = z.object({
  platforms: z.array(platformSchema).max(4).optional(),
  instructions: z.string().max(2000, 'Chỉ dẫn tối đa 2.000 ký tự.').optional(),
});

const approveSchema = z.object({ scheduledAt: z.number().int().positive('Giờ đăng không hợp lệ.').nullable().optional() });
const returnSchema = z.object({ feedback: z.string().trim().min(1, 'Hãy ghi nhận xét để biết cần sửa gì.').max(2000) });
const retrySchema = z.object({ targetId: z.string().trim().min(1, 'Thiếu targetId.') });

function fail(c: Context, err: unknown) {
  if (err instanceof KolError) return c.json({ error: err.message }, err.status as ContentfulStatusCode);
  if (err instanceof ZodError) return c.json({ error: err.issues[0]?.message ?? 'Dữ liệu không hợp lệ.' }, 400);
  if (err instanceof KillSwitchDisabledError) return c.json({ error: 'Agent đang bị tắt (công tắc LLM_SPAWN_ENABLED).' }, 409);
  logger.error({ err: String((err as Error)?.stack ?? err).slice(0, 500), path: c.req.path }, 'kol publish route failed');
  return c.json({ error: 'Lỗi máy chủ, thử lại sau.' }, 500);
}

async function body(c: Context): Promise<unknown> {
  return c.req.json().catch(() => ({}));
}

function numParam(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function registerPublishRoutes(app: Hono): void {
  for (const p of ['/api/kol/connections', '/api/kol/accounts/*', '/api/kol/posts', '/api/kol/posts/*', '/api/kol/radar-ideas']) {
    app.use(p, bodyLimit({ maxSize: 512 * 1024 }));
  }

  // ── Connections & accounts ─────────────────────────────────────────

  app.get('/api/kol/connections', async (c) => {
    try {
      return c.json(await listKolConnections());
    } catch (err) {
      return fail(c, err);
    }
  });

  app.get('/api/kol/accounts', (c) => {
    try {
      return c.json({ accounts: listAllAccounts() });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.get('/api/kol/personas/:id/accounts', (c) => {
    try {
      return c.json({ accounts: listAccounts(c.req.param('id')) });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post('/api/kol/personas/:id/accounts', async (c) => {
    try {
      const input = linkSchema.parse(await body(c));
      if (input.platform !== 'facebook' && !input.connectionId) throw new KolError(400, 'Hãy chọn một kết nối Composio.');
      if (input.platform === 'facebook' && !input.externalId) throw new KolError(400, 'Hãy chọn Fanpage (đã bật trong Marketing › Pages).');
      return c.json({ account: await linkAccount(c.req.param('id'), input) });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.patch('/api/kol/accounts/:id', async (c) => {
    try {
      const input = accountPatchSchema.parse(await body(c)) as AccountInput;
      return c.json({ account: await updateAccount(c.req.param('id'), input) });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.delete('/api/kol/accounts/:id', (c) => {
    try {
      for (const postId of deleteAccount(c.req.param('id'))) recomputePostStatus(postId);
      return c.json({ ok: true });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post('/api/kol/accounts/:id/refresh', async (c) => {
    try {
      return c.json({ account: await refreshAccount(c.req.param('id')) });
    } catch (err) {
      return fail(c, err);
    }
  });

  // ── Posts ──────────────────────────────────────────────────────────

  app.get('/api/kol/posts', (c) => {
    try {
      const personaId = c.req.query('personaId') || undefined;
      if (personaId) requirePersona(personaId);
      return c.json({
        posts: listPosts({
          personaId,
          status: c.req.query('status') || undefined,
          from: numParam(c.req.query('from')),
          to: numParam(c.req.query('to')),
        }),
      });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post('/api/kol/posts', async (c) => {
    try {
      const { personaId, ...input } = createPostSchema.parse(await body(c));
      return c.json({ post: createPost(personaId, input) });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.get('/api/kol/posts/:id', (c) => {
    try {
      return c.json({ post: requirePost(c.req.param('id')) });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.patch('/api/kol/posts/:id', async (c) => {
    try {
      return c.json({ post: updatePost(c.req.param('id'), postInputSchema.parse(await body(c))) });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.delete('/api/kol/posts/:id', (c) => {
    try {
      cancelPost(c.req.param('id'));
      return c.json({ ok: true });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post('/api/kol/posts/:id/captions', async (c) => {
    try {
      const req = captionsSchema.parse(await body(c));
      const post = requirePost(c.req.param('id'));
      const persona = requirePersona(post.personaId);
      const variants = await writeCaptionVariants(post, persona, req);
      const saved = setPostVariants(post.id, variants);
      // An empty master caption takes the best variant, so the post reads well before any account is linked.
      const lead = variants.instagram ?? variants.facebook ?? variants.tiktok ?? variants.youtube;
      if (!saved.caption.trim() && lead && canEdit(saved.status)) {
        return c.json({ post: updatePost(post.id, { caption: lead.caption, hashtags: saved.hashtags.length ? saved.hashtags : lead.hashtags ?? [] }) });
      }
      return c.json({ post: saved });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post('/api/kol/posts/:id/submit', (c) => {
    try {
      return c.json({ post: submitPost(c.req.param('id')) });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post('/api/kol/posts/:id/approve', async (c) => {
    try {
      const { scheduledAt } = approveSchema.parse(await body(c));
      return c.json({ post: approvePost(c.req.param('id'), scheduledAt ?? null) });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post('/api/kol/posts/:id/return', async (c) => {
    try {
      const { feedback } = returnSchema.parse(await body(c));
      return c.json({ post: returnPost(c.req.param('id'), feedback) });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post('/api/kol/posts/:id/publish-now', (c) => {
    try {
      const post = publishNowPost(c.req.param('id'));
      kickPublisher();
      return c.json({ post });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post('/api/kol/posts/:id/retry', async (c) => {
    try {
      const { targetId } = retrySchema.parse(await body(c));
      const post = retryTarget(c.req.param('id'), targetId);
      kickPublisher();
      return c.json({ post });
    } catch (err) {
      return fail(c, err);
    }
  });

  // ── Growth, strategist, autopilot ──────────────────────────────────

  app.get('/api/kol/personas/:id/growth', (c) => {
    try {
      return c.json(computeGrowth(c.req.param('id'), numParam(c.req.query('days')) ?? 30));
    } catch (err) {
      return fail(c, err);
    }
  });

  app.get('/api/kol/personas/:id/insights', (c) => {
    try {
      return c.json({ insights: listInsights(c.req.param('id')) });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post('/api/kol/personas/:id/strategist', async (c) => {
    try {
      return c.json({ insight: await runWeeklyReview(c.req.param('id'), { radarIdeas: listRadarIdeas(15) }) });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post('/api/kol/personas/:id/autopilot/run', async (c) => {
    try {
      return c.json({ insight: await runAutopilotNow(c.req.param('id')) });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.get('/api/kol/radar-ideas', (c) => {
    try {
      return c.json({ ideas: listRadarIdeas(numParam(c.req.query('limit')) ?? 30) });
    } catch (err) {
      return fail(c, err);
    }
  });
}
