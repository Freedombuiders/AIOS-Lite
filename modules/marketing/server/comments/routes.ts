/**
 * /comments/* — log, rules, templates, test box, poll-now and manual
 * actions. Contract: ../types.ts. Mounted behind the dashboard token, CSRF and
 * read-only middleware by registerFbStudioRoutes().
 */

import type { Context, Hono } from 'hono';
import { z } from 'zod';

import { listAgentIds } from '../compat.js';
import {
  deleteFbReplyTemplate,
  getFbCommentForLog,
  getFbCommentPage,
  getFbReplyTemplate,
  insertFbReplyTemplate,
  listFbPostOverridePostIds,
  listFbRecentPostsForRules,
  listFbReplyTemplates,
  updateFbReplyTemplate,
  type FbCommentPageRow,
} from '../store.js';
import {
  ComposioAuthError,
  ComposioConnectionExpiredError,
  ComposioRateLimitError,
  FbBudgetExceeded,
  hasComposioKey,
} from '../../../_lib/composio.js';
import type { ReplyRulesDto, ReplyTemplateDto, ReplyTemplateInput, RuleTestResult } from '../types.js';
import { ActionError, hideManually, retryComment, sendDraftNow, unhideManually } from './actions.js';
import { describeError, handleExpired } from './common.js';
import {
  dropPostOverrides,
  effectiveRules,
  listSkillNames,
  loadPostOverrides,
  parseRulePatch,
  savePageRules,
  savePostOverrides,
} from './config.js';
import { buildCommentLog, toRowDto, type LogKind } from './log.js';
import { pollPage } from './poller.js';
import { loadTemplates, templateFromRow } from './processor.js';
import { describeOutcome, runPipeline } from './rules.js';
import { ensureAutoReplySince, setLastPollAt } from './state.js';

const KINDS = new Set<LogKind>(['all', 'template', 'agent', 'other']);
const DEFAULT_LOG_LIMIT = 100;
const MAX_LOG_LIMIT = 300;

function nonEmpty(v: string | undefined): string | null {
  const t = (v ?? '').trim();
  return t ? t : null;
}

async function readBody(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function findPage(c: Context, pageId: string | null): FbCommentPageRow | Response {
  if (!pageId) return c.json({ error: 'Thiếu mã Page' }, 400);
  const page = getFbCommentPage(pageId);
  if (!page) return c.json({ error: 'Không tìm thấy Page' }, 404);
  return page;
}

/** Maps thrown errors from Composio calls and manual actions to JSON responses. */
async function failure(c: Context, err: unknown, page?: FbCommentPageRow): Promise<Response> {
  if (err instanceof ActionError) return c.json({ error: err.message }, err.status);
  if (err instanceof ComposioAuthError) return c.json({ error: 'Chưa cấu hình khóa Composio hoặc khóa bị từ chối' }, 503);
  if (err instanceof ComposioConnectionExpiredError) {
    if (page) await handleExpired(page);
    return c.json({ error: 'Kết nối Facebook của Page đã hết hạn. Hãy kết nối lại trong Composio.' }, 502);
  }
  if (err instanceof ComposioRateLimitError || err instanceof FbBudgetExceeded) {
    return c.json({ error: 'Facebook đang giới hạn tần suất hoặc đã hết ngân sách gọi API trong giờ này. Thử lại sau.' }, 429);
  }
  return c.json({ error: describeError(err) }, 502);
}

// ── Rules DTO ────────────────────────────────────────────────────────

function postTitle(raw: string): string {
  return (raw.split('\n').find((l) => l.trim()) ?? '').trim().slice(0, 90);
}

export function buildRulesDto(pageId: string, postId: string | null): ReplyRulesDto {
  const overridden = new Set(listFbPostOverridePostIds(pageId));
  const templates = loadTemplates(pageId).filter((t) => (postId ? t.postId === postId || t.postId == null : t.postId == null));
  const others = listAgentIds().filter((id) => id !== 'main');
  return {
    pageId,
    postId,
    effective: effectiveRules(pageId, postId),
    overrides: postId ? loadPostOverrides(postId) : null,
    templates,
    posts: listFbRecentPostsForRules(pageId, 30).map((p) => ({
      postId: p.post_id,
      title: postTitle(p.title),
      publishedAt: p.published_at,
      hasOverride: overridden.has(p.post_id),
    })),
    agents: ['main', ...others],
    skills: listSkillNames(),
  };
}

// ── Template input ───────────────────────────────────────────────────

const cleanList = (maxItems: number, maxLen: number) =>
  z.array(z.string()).max(maxItems * 2).transform((l) => [...new Set(l.map((s) => s.trim()).filter(Boolean))])
    .refine((l) => l.length <= maxItems && l.every((s) => s.length <= maxLen), `Tối đa ${maxItems} mục, mỗi mục ${maxLen} ký tự`);

const TEMPLATE_SCHEMA = z.object({
  pageId: z.string().min(1),
  postId: z.string().min(1).nullable(),
  name: z.string().trim().min(1).max(80),
  keywords: cleanList(50, 100),
  matchMode: z.enum(['exact', 'contains']),
  variants: cleanList(20, 1000),
  privateText: z.string().max(1000),
  enabled: z.boolean(),
  sort: z.number().int().min(0).max(100000),
}).partial().strict();

function parseTemplateInput(body: unknown): { ok: true; value: ReplyTemplateInput } | { ok: false; error: string } {
  const parsed = TEMPLATE_SCHEMA.safeParse(body);
  if (parsed.success) return { ok: true, value: parsed.data as ReplyTemplateInput };
  const issue = parsed.error.issues[0];
  return { ok: false, error: `Mẫu không hợp lệ (${issue.path.join('.') || 'body'}): ${issue.message}` };
}

function templateRowValues(t: ReplyTemplateDto) {
  return {
    post_id: t.postId,
    name: t.name,
    keywords_json: JSON.stringify(t.keywords),
    match_mode: t.matchMode,
    variants_json: JSON.stringify(t.variants),
    private_text: t.privateText,
    enabled: t.enabled ? 1 : 0,
    sort: t.sort,
  };
}

function getTemplateDto(id: number): ReplyTemplateDto | null {
  const row = getFbReplyTemplate(id);
  return row ? templateFromRow(row) : null;
}

// ── Routes ───────────────────────────────────────────────────────────

export function registerCommentRoutes(app: Hono): void {
  app.get('/comments/log', (c) => {
    const page = findPage(c, nonEmpty(c.req.query('page')));
    if (page instanceof Response) return page;
    const kindRaw = (c.req.query('kind') ?? 'all') as LogKind;
    const kind: LogKind = KINDS.has(kindRaw) ? kindRaw : 'all';
    const limitRaw = parseInt(c.req.query('limit') ?? '', 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), MAX_LOG_LIMIT) : DEFAULT_LOG_LIMIT;
    return c.json(buildCommentLog(page, kind, limit));
  });

  app.get('/comments/rules', (c) => {
    const page = findPage(c, nonEmpty(c.req.query('page')));
    if (page instanceof Response) return page;
    return c.json(buildRulesDto(page.id, nonEmpty(c.req.query('post'))));
  });

  app.put('/comments/rules', async (c) => {
    const body = await readBody(c);
    if (!body) return c.json({ error: 'Dữ liệu gửi lên không hợp lệ' }, 400);
    const page = findPage(c, typeof body.pageId === 'string' ? body.pageId : null);
    if (page instanceof Response) return page;
    const patch = parseRulePatch(body.config);
    if (!patch.ok) return c.json({ error: patch.error }, 400);
    const postId = typeof body.postId === 'string' && body.postId.trim() ? body.postId.trim() : null;
    if (postId) savePostOverrides(page.id, postId, patch.value);
    else savePageRules(page.id, patch.value);
    return c.json(buildRulesDto(page.id, postId));
  });

  app.delete('/comments/rules', (c) => {
    const page = findPage(c, nonEmpty(c.req.query('page')));
    if (page instanceof Response) return page;
    const postId = nonEmpty(c.req.query('post'));
    if (!postId) return c.json({ error: 'Chỉ xoá được cấu hình riêng của một bài viết (thiếu mã bài)' }, 400);
    dropPostOverrides(postId);
    return c.json(buildRulesDto(page.id, postId));
  });

  app.post('/comments/templates', async (c) => {
    const body = await readBody(c);
    const parsed = body ? parseTemplateInput(body) : { ok: false as const, error: 'Dữ liệu gửi lên không hợp lệ' };
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const input = parsed.value;
    if (!input.pageId) return c.json({ error: 'Thiếu mã Page' }, 400);
    if (!input.name) return c.json({ error: 'Mẫu cần có tên' }, 400);
    const page = findPage(c, input.pageId);
    if (page instanceof Response) return page;
    const sort = input.sort ?? Math.max(0, ...listFbReplyTemplates(page.id).map((t) => t.sort)) + 10;
    const id = insertFbReplyTemplate({
      page_id: page.id,
      ...templateRowValues({
        id: 0, pageId: page.id, postId: input.postId ?? null, name: input.name, keywords: input.keywords ?? [],
        matchMode: input.matchMode ?? 'contains', variants: input.variants ?? [], privateText: input.privateText ?? '',
        enabled: input.enabled ?? true, sort, uses: 0,
      }),
    });
    return c.json(getTemplateDto(id));
  });

  app.patch('/comments/templates/:id', async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const existing = Number.isFinite(id) ? getTemplateDto(id) : null;
    if (!existing) return c.json({ error: 'Không tìm thấy mẫu' }, 404);
    const body = await readBody(c);
    const parsed = body ? parseTemplateInput(body) : { ok: false as const, error: 'Dữ liệu gửi lên không hợp lệ' };
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const { pageId: _ignored, ...patch } = parsed.value;
    void _ignored;
    updateFbReplyTemplate(id, templateRowValues({ ...existing, ...patch }));
    return c.json(getTemplateDto(id));
  });

  app.delete('/comments/templates/:id', (c) => {
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id) || !deleteFbReplyTemplate(id)) return c.json({ error: 'Không tìm thấy mẫu' }, 404);
    return c.json({ ok: true });
  });

  app.post('/comments/test', async (c) => {
    const body = await readBody(c);
    if (!body) return c.json({ error: 'Dữ liệu gửi lên không hợp lệ' }, 400);
    const page = findPage(c, typeof body.pageId === 'string' ? body.pageId : null);
    if (page instanceof Response) return page;
    const text = typeof body.text === 'string' ? body.text.slice(0, 2000) : '';
    const postId = typeof body.postId === 'string' && body.postId.trim() ? body.postId.trim() : null;
    if (!text.trim()) {
      const empty: RuleTestResult = { step: 'skip', words: 0, head: 'Chưa có câu.', body: 'Gõ một bình luận để xem nó đi tới bước nào.' };
      return c.json(empty);
    }
    const rules = effectiveRules(page.id, postId);
    const outcome = runPipeline({ text, authorName: '', rules, templates: loadTemplates(page.id), postId });
    return c.json(describeOutcome(outcome, { text, rules }));
  });

  app.post('/comments/poll-now', async (c) => {
    const body = await readBody(c);
    const page = findPage(c, body && typeof body.pageId === 'string' ? body.pageId : null);
    if (page instanceof Response) return page;
    if (!hasComposioKey()) return c.json({ error: 'Chưa cấu hình khóa Composio (Cài đặt › Facebook)' }, 503);
    if (page.status === 'EXPIRED') return c.json({ error: 'Kết nối Facebook của Page đã hết hạn. Hãy kết nối lại trong Composio.' }, 409);
    if (!page.connection_id) return c.json({ error: 'Page chưa có kết nối Composio. Hãy đồng bộ Page trước.' }, 409);
    const rules = effectiveRules(page.id);
    try {
      if (page.enabled && rules.enabled) ensureAutoReplySince(page.id);
      const result = await pollPage(page, rules);
      setLastPollAt(page.id);
      return c.json({ ok: true, fetched: result.fetched });
    } catch (err) {
      return failure(c, err, page);
    }
  });

  const manual = (run: (id: string) => Promise<unknown>) => async (c: Context) => {
    const id = c.req.param('id') ?? '';
    const before = getFbCommentForLog(id);
    const page = before ? getFbCommentPage(before.page_id) : undefined;
    try {
      const row = await run(id);
      const templateNames = new Map((page ? loadTemplates(page.id) : []).map((t) => [t.id, t.name]));
      return c.json(toRowDto(row as NonNullable<typeof before>, templateNames));
    } catch (err) {
      return failure(c, err, page);
    }
  };
  app.post('/comments/:id/retry', manual(retryComment));
  app.post('/comments/:id/hide', manual(hideManually));
  app.post('/comments/:id/unhide', manual(unhideManually));
  app.post('/comments/:id/send', manual(sendDraftNow));
}
