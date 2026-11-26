// HTTP API of the learning loop under /api/m/learn: lesson book, Chờ duyệt, weekly review, score-draft.
// Every route here acts as the owner (the HTTP API is the owner's path; agents act through the learn.propose
// action, which cannot change a state). Numbers come from code (playbook.ts, metrics.ts), never from an agent.
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { ModuleContext } from '../../../src/modules/sdk.js';
import type { Principal } from '../../../src/shared/notes.js';
import { AREAS, LESSON_DIR, LESSON_STATES, STATE_LABELS } from './lesson-rules.js';
import { weeklySeries, type DraftStatsFn } from './metrics.js';
import { MILESTONE_LABELS, NOTE_DIR } from './note-format.js';
import { LessonError, MIN_EVIDENCE, type Playbook } from './playbook.js';
import type { Scorer } from './score-draft.js';
import type { Weekly } from './weekly.js';

const OWNER: Principal = { kind: 'owner' };
const err = (code: string, message: string) => ({ error: { code, message } });
const STATUS: Record<string, 400 | 403 | 404 | 409> = { bad_request: 400, forbidden: 403, not_found: 404, conflict: 409 };

export interface LoopState {
  playbook: Playbook;
  weekly: Weekly;
  scorer: Scorer;
  drafts(): DraftStatsFn | undefined;
}

function fail(c: Context, e: unknown) {
  const code = (e as { code?: unknown })?.code;
  if (e instanceof LessonError || (typeof code === 'string' && STATUS[code])) {
    return c.json(err(String(code), (e as Error).message), STATUS[String(code)] ?? 400);
  }
  throw e;
}

async function body<T>(c: Context, schema: z.ZodType<T>): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, message: 'Nội dung gửi lên không phải JSON.' };
  }
  const r = schema.safeParse(raw);
  return r.success ? { ok: true, value: r.data } : { ok: false, message: r.error.issues.map((i) => `${i.path.join('.') || 'nội dung'}: ${i.message}`).slice(0, 3).join('; ') };
}

const lessonPath = z.string().min(1).max(400).refine((p) => p.startsWith(`${LESSON_DIR}/`) && p.endsWith('.md') && !p.split('/').includes('..'), `cần đường dẫn trong ${LESSON_DIR}/`);
const transitionBody = z.object({ path: lessonPath, to: z.enum(LESSON_STATES), reason: z.string().max(500).optional() });
const createBody = z.object({
  tieu_de: z.string().trim().min(3).max(160),
  mang: z.enum(AREAS),
  noi_dung: z.string().max(4000).default(''),
  bang_chung: z.array(z.string().max(300)).max(20).default([]),
  ap_dung: z.record(z.string(), z.unknown()).optional(),
});
const approveBody = z.object({ lines: z.array(z.number().int().min(0).max(50)).min(1).max(20) });
const scoreBody = z.object({
  text: z.string().max(20_000),
  format: z.string().max(40).optional(),
  scheduledAt: z.number().int().positive().nullable().optional(),
  hasVideo: z.boolean().optional(),
  videoLengthS: z.number().positive().max(36_000).nullable().optional(),
  timezone: z.string().max(60).optional(),
});

export function registerLoopRoutes(app: Hono, ctx: ModuleContext, state: () => LoopState | null): void {
  const folder = () => String(ctx.settings.get<string>('folder', '') ?? '').trim();
  const moc = () => String(ctx.settings.get<string>('moc', '24h') ?? '24h');
  const need = (c: Context): LoopState | Response => state() ?? c.json(err('unavailable', 'Module Học chưa chạy.'), 503);
  const nowSec = () => Math.floor(Date.now() / 1000);

  app.get('/loop', (c) => {
    const s = need(c);
    if (s instanceof Response) return s;
    const f = folder();
    let posts: Array<{ relPath: string; data: Record<string, unknown> }> = [];
    if (f) {
      try {
        posts = ctx.brain.notes.list(f, NOTE_DIR, { loai: 'bai-dang' }).map((n) => ({ relPath: n.relPath, data: n.data }));
      } catch {
        posts = [];
      }
    }
    const lessons = s.playbook.list();
    const weeks = weeklySeries(posts, { nowSec: nowSec(), count: 8, moc: moc(), drafts: s.drafts() });
    const since = nowSec() - 7 * 86400;
    return c.json({
      folder: f,
      moc: moc(),
      mocLabel: MILESTONE_LABELS[moc()] ?? moc(),
      careEnabled: !!s.drafts(),
      weeks,
      counts: s.playbook.counts(),
      lessons: lessons.length,
      inUse: lessons.filter((l) => l.ownerVerified && l.usedBy.length > 0).length,
      measuredPosts: posts.filter((p) => Array.isArray(p.data.so_do) && p.data.so_do.length > 0).length,
      posts: posts.length,
      changes: s.playbook.changes(since, nowSec() + 1).slice(0, 10),
      testing: lessons.filter((l) => l.state === 'dang-thu').map((l) => ({ path: l.path, title: l.title, measured: l.trial?.measured ?? 0, threshold: l.trial?.threshold ?? 0, label: l.trial?.label ?? '' })),
      pending: s.playbook.proposals().length,
    });
  });

  app.get('/playbook', (c) => {
    const s = need(c);
    if (s instanceof Response) return s;
    return c.json({
      folder: folder(),
      dir: `${LESSON_DIR}/`,
      moc: moc(),
      minEvidence: MIN_EVIDENCE,
      states: LESSON_STATES.map((k) => ({ key: k, label: STATE_LABELS[k] })),
      lessons: s.playbook.list(),
      agents: ctx.agents.list().map((a) => ({ id: a.id, name: a.name, canRead: ctx.access.can(a.id, 'playbook.read') })),
    });
  });

  app.post('/playbook', async (c) => {
    const s = need(c);
    if (s instanceof Response) return s;
    const b = await body(c, createBody);
    if (!b.ok) return c.json(err('bad_request', b.message), 400);
    try {
      const lesson = s.playbook.create({ title: b.value.tieu_de, area: b.value.mang, text: b.value.noi_dung, evidence: b.value.bang_chung, rules: b.value.ap_dung }, OWNER);
      return c.json({ lesson }, 201);
    } catch (e) {
      return fail(c, e);
    }
  });

  app.post('/playbook/transition', async (c) => {
    const s = need(c);
    if (s instanceof Response) return s;
    const b = await body(c, transitionBody);
    if (!b.ok) return c.json(err('bad_request', b.message), 400);
    const f = folder();
    if (!f) return c.json(err('bad_request', 'Chưa chọn thư mục Second Brain cho module Học.'), 400);
    try {
      const r = s.playbook.transition({ folderId: f, relPath: b.value.path }, b.value.to, OWNER, { reason: b.value.reason ?? 'Chủ đổi trong app' });
      return c.json({ ...r, lesson: s.playbook.get(b.value.path) });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.post('/playbook/evaluate', (c) => {
    const s = need(c);
    if (s instanceof Response) return s;
    return c.json(s.playbook.evaluate());
  });

  app.get('/pending', (c) => {
    const s = need(c);
    if (s instanceof Response) return s;
    return c.json({ items: s.playbook.proposals() });
  });

  app.post('/pending/:id/:verb', (c) => {
    const s = need(c);
    if (s instanceof Response) return s;
    const id = Number(c.req.param('id'));
    const verb = c.req.param('verb');
    if (!Number.isInteger(id) || id <= 0) return c.json(err('bad_request', 'Mã đề xuất không hợp lệ.'), 400);
    try {
      if (verb === 'accept') return c.json({ item: s.playbook.accept(id, OWNER) });
      if (verb === 'dismiss') return c.json({ item: s.playbook.dismiss(id, OWNER) });
      return c.json(err('not_found', 'Không có thao tác này.'), 404);
    } catch (e) {
      return fail(c, e);
    }
  });

  app.get('/weekly', (c) => {
    const s = need(c);
    if (s instanceof Response) return s;
    return c.json({ folder: folder(), dir: 'tong-ket/', items: s.weekly.list() });
  });

  app.post('/weekly/run', async (c) => {
    const s = need(c);
    if (s instanceof Response) return s;
    if (!folder()) return c.json(err('bad_request', 'Chưa chọn thư mục Second Brain cho module Học.'), 400);
    try {
      return c.json({ result: await s.weekly.catchUp() });
    } catch (e) {
      return fail(c, e);
    }
  });

  const weekParams = (c: Context) => {
    const year = Number(c.req.param('year'));
    const week = Number(c.req.param('week'));
    return Number.isInteger(year) && year >= 2000 && year <= 2100 && Number.isInteger(week) && week >= 1 && week <= 53 ? { year, week } : null;
  };

  app.get('/weekly/:year/:week', (c) => {
    const s = need(c);
    if (s instanceof Response) return s;
    const w = weekParams(c);
    if (!w) return c.json(err('bad_request', 'Tuần không hợp lệ.'), 400);
    const note = s.weekly.get(w.year, w.week);
    if (!note) return c.json(err('not_found', 'Chưa có tổng kết của tuần này.'), 404);
    return c.json(note);
  });

  // owner only: the HTTP API is the owner's path, and this is not offered to agents as an action
  app.post('/weekly/:year/:week/approve', async (c) => {
    const s = need(c);
    if (s instanceof Response) return s;
    const w = weekParams(c);
    if (!w) return c.json(err('bad_request', 'Tuần không hợp lệ.'), 400);
    const b = await body(c, approveBody);
    if (!b.ok) return c.json(err('bad_request', b.message), 400);
    try {
      return c.json(s.weekly.approve(w.year, w.week, b.value.lines, OWNER));
    } catch (e) {
      return fail(c, e);
    }
  });

  app.post('/score-draft', async (c) => {
    const s = need(c);
    if (s instanceof Response) return s;
    const b = await body(c, scoreBody);
    if (!b.ok) return c.json(err('bad_request', b.message), 400);
    if (!folder()) return c.json({ matched: 0, checkable: 0, lessons: [], unchecked: [], hook: { moDau: null, label: null, source: 'none', note: null }, facts: {}, state: 'no-folder' });
    return c.json({ ...(await s.scorer.score(b.value)), state: 'ok' });
  });
}
