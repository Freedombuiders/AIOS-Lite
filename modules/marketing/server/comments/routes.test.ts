import fs from 'fs';
import path from 'path';

import { Hono } from 'hono';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  getFbComment,
  getFbCommentPage,
  insertFbReplyTemplate,
  upsertFbCommentWatch,
} from '../store.js';

vi.mock('../../../_lib/composio.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../_lib/composio.js')>()),
  execute: vi.fn(),
  graphAsPage: vi.fn(),
  hasComposioKey: vi.fn(() => true),
}));
vi.mock('../settings.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../settings.js')>()), isEnabled: vi.fn(() => true), requireEnabled: vi.fn() }));
vi.mock('../compat.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../compat.js')>()), listAgentIds: () => ['main', 'content-writer'] }));
vi.mock('../notify.js', () => ({ notifyOwner: vi.fn(async () => {}) }));

import {
  ComposioAuthError,
  ComposioConnectionExpiredError,
  execute,
  graphAsPage,
  hasComposioKey,
} from '../../../_lib/composio.js';
import { DEFAULT_REPLY_RULES } from '../types.js';
import type {
  CommentLogDto,
  CommentLogRowDto,
  ReplyRulesDto,
  ReplyTemplateDto,
  RuleTestResult,
} from '../types.js';
import { savePageRules } from './config.js';
import { registerCommentRoutes } from './routes.js';
import { getAutoReplySince } from './state.js';
import { NOW, PAGE_ID, seedComment, seedPage } from './test-utils.js';

const exec = vi.mocked(execute);
const graph = vi.mocked(graphAsPage);
const keyConfigured = vi.mocked(hasComposioKey);

function app(): Hono {
  const a = new Hono();
  registerCommentRoutes(a);
  return a;
}

const send = async (a: Hono, method: string, url: string, body?: unknown): Promise<Response> =>
  a.request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const json = async <T>(res: Response) => (await res.json()) as T;

beforeEach(() => {
  vi.useRealTimers();
  exec.mockReset();
  graph.mockReset();
  keyConfigured.mockReturnValue(true);
  _initTestDatabase(':memory:');
  seedPage();
});

describe('rules', () => {
  it('returns the defaults, agents, skills and recent posts for a Page with nothing stored', async () => {
    upsertFbCommentWatch({ post_id: 'P1_100', page_id: PAGE_ID, comment_count: 1, post_created_at: NOW, message: 'Bài về agent\nDòng hai', permalink: '', last_checked_at: null });
    const res = await send(app(), 'GET', `/comments/rules?page=${PAGE_ID}`);
    expect(res.status).toBe(200);
    const dto = await json<ReplyRulesDto>(res);
    expect(dto.effective).toEqual(DEFAULT_REPLY_RULES);
    expect(dto.overrides).toBeNull();
    expect(dto.postId).toBeNull();
    expect(dto.agents[0]).toBe('main');
    expect(dto.agents).toContain('content-writer');
    expect(dto.skills).toContain('fb-comment-reply');
    expect(dto.posts).toEqual([{ postId: 'P1_100', title: 'Bài về agent', publishedAt: NOW, hasOverride: false }]);
  });

  it('saves page rules, validates them, and shows post overrides separately', async () => {
    const a = app();
    let res = await send(a, 'PUT', '/comments/rules', { pageId: PAGE_ID, config: { minWords: 3, spamKeywords: ['x', 'x', ' '] } });
    expect(res.status).toBe(200);
    expect((await json<ReplyRulesDto>(res)).effective).toMatchObject({ minWords: 3, spamKeywords: ['x'] });

    res = await send(a, 'PUT', '/comments/rules', { pageId: PAGE_ID, config: { minWords: -1 } });
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toMatch(/không hợp lệ/);
    res = await send(a, 'PUT', '/comments/rules', { pageId: PAGE_ID, config: { bogus: 1 } });
    expect(res.status).toBe(400);
    res = await send(a, 'PUT', '/comments/rules', { pageId: 'nope', config: {} });
    expect(res.status).toBe(404);

    res = await send(a, 'PUT', '/comments/rules', { pageId: PAGE_ID, postId: 'P1_100', config: { minWords: 10 } });
    const post = await json<ReplyRulesDto>(res);
    expect(post.effective.minWords).toBe(10);
    expect(post.overrides).toEqual({ minWords: 10 });
    const page = await json<ReplyRulesDto>(await send(a, 'GET', `/comments/rules?page=${PAGE_ID}`));
    expect(page.effective.minWords).toBe(3);
  });

  it('drops a post override and refuses to drop the Page config', async () => {
    const a = app();
    await send(a, 'PUT', '/comments/rules', { pageId: PAGE_ID, postId: 'P1_100', config: { minWords: 10 } });
    let res = await send(a, 'DELETE', `/comments/rules?page=${PAGE_ID}&post=P1_100`);
    expect(res.status).toBe(200);
    const dto = await json<ReplyRulesDto>(res);
    expect(dto.overrides).toBeNull();
    expect(dto.effective.minWords).toBe(DEFAULT_REPLY_RULES.minWords);
    res = await send(a, 'DELETE', `/comments/rules?page=${PAGE_ID}`);
    expect(res.status).toBe(400);
  });

  it('requires a known Page', async () => {
    expect((await send(app(), 'GET', '/comments/rules')).status).toBe(400);
    expect((await send(app(), 'GET', '/comments/rules?page=missing')).status).toBe(404);
  });
});

describe('templates', () => {
  it('creates, lists (page view vs post view), updates and deletes a template', async () => {
    const a = app();
    let res = await send(a, 'POST', '/comments/templates', {
      pageId: PAGE_ID, name: 'AI', keywords: ['AI', ' ai ', ''], matchMode: 'exact', variants: ['Chào {ten}!', ''], privateText: 'Mình gửi tài liệu',
    });
    expect(res.status).toBe(200);
    const created = await json<ReplyTemplateDto>(res);
    expect(created).toMatchObject({
      pageId: PAGE_ID, postId: null, name: 'AI', keywords: ['AI', 'ai'], matchMode: 'exact',
      variants: ['Chào {ten}!'], privateText: 'Mình gửi tài liệu', enabled: true, uses: 0,
    });

    const postTpl = await json<ReplyTemplateDto>(await send(a, 'POST', '/comments/templates', {
      pageId: PAGE_ID, postId: 'P1_100', name: 'Học thử', keywords: ['học thử'], variants: ['Có nhé'],
    }));
    expect(postTpl.sort).toBeGreaterThan(created.sort);

    const pageView = await json<ReplyRulesDto>(await send(a, 'GET', `/comments/rules?page=${PAGE_ID}`));
    expect(pageView.templates.map((t) => t.name)).toEqual(['AI']);
    const postView = await json<ReplyRulesDto>(await send(a, 'GET', `/comments/rules?page=${PAGE_ID}&post=P1_100`));
    expect(postView.templates.map((t) => t.name).sort()).toEqual(['AI', 'Học thử']);

    res = await send(a, 'PATCH', `/comments/templates/${created.id}`, { enabled: false, variants: ['A', 'B'] });
    expect(res.status).toBe(200);
    expect(await json<ReplyTemplateDto>(res)).toMatchObject({ enabled: false, variants: ['A', 'B'], name: 'AI', keywords: ['AI', 'ai'] });

    res = await send(a, 'DELETE', `/comments/templates/${created.id}`);
    expect(await json(res)).toEqual({ ok: true });
    expect((await send(a, 'DELETE', `/comments/templates/${created.id}`)).status).toBe(404);
    expect((await send(a, 'PATCH', `/comments/templates/${created.id}`, { name: 'x' })).status).toBe(404);
  });

  it('validates input', async () => {
    const a = app();
    for (const body of [
      {},
      { pageId: PAGE_ID },
      { pageId: PAGE_ID, name: '  ' },
      { pageId: PAGE_ID, name: 'x', matchMode: 'regex' },
      { pageId: PAGE_ID, name: 'x', extra: 1 },
      { pageId: PAGE_ID, name: 'x', variants: ['a'.repeat(1001)] },
    ]) {
      const res = await send(a, 'POST', '/comments/templates', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await send(a, 'POST', '/comments/templates', { pageId: 'nope', name: 'x' })).status).toBe(404);
  });
});

describe('test box', () => {
  const test = (text: string, extra: Record<string, unknown> = {}) =>
    send(app(), 'POST', '/comments/test', { pageId: PAGE_ID, text, ...extra }).then((r) => json<RuleTestResult>(r));

  it('answers with the same step the worker would pick', async () => {
    insertFbReplyTemplate({
      page_id: PAGE_ID, post_id: null, name: 'AI', keywords_json: '["AI"]', match_mode: 'exact',
      variants_json: '["Chào {ten}"]', private_text: '', enabled: 1, sort: 0,
    });
    expect(await test('')).toMatchObject({ step: 'skip', head: 'Chưa có câu.' });
    expect(await test('xem https://x.vn')).toMatchObject({ step: 'spam', head: 'Bước 1 · Ẩn bình luận.' });
    expect(await test('bị lỗi rồi')).toMatchObject({ step: 'complaint' });
    expect(await test('ai.')).toMatchObject({ step: 'template', head: 'Bước 3 · Mẫu “AI”.', body: 'Trả lời: Chào bạn' });
    expect(await test('Khóa này dùng cho ngành spa được không ạ?')).toMatchObject({ step: 'agent', words: 9 });
    expect(await test('Hay quá')).toMatchObject({ step: 'skip', head: 'Bước 5 · Bỏ qua.' });
  });

  it('honours the rules of the post being tested', async () => {
    savePageRules(PAGE_ID, { minWords: 6 });
    await send(app(), 'PUT', '/comments/rules', { pageId: PAGE_ID, postId: 'P1_100', config: { minWords: 2 } });
    expect((await test('rất hay nhé')).step).toBe('skip');
    expect((await test('rất hay nhé', { postId: 'P1_100' })).step).toBe('agent');
  });

  it('does not call Facebook', async () => {
    await test('xem https://x.vn');
    expect(exec).not.toHaveBeenCalled();
    expect(graph).not.toHaveBeenCalled();
  });
});

describe('log', () => {
  it('returns KPIs, hourly buckets, topics, counts and rows for the Page', async () => {
    // Pin the clock mid-hour so the buckets do not depend on when the test runs.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime((NOW + 1800) * 1000);
    const now = NOW + 1800;
    const t = insertFbReplyTemplate({
      page_id: PAGE_ID, post_id: null, name: 'Giá', keywords_json: '["giá"]', match_mode: 'contains',
      variants_json: '["x"]', private_text: '', enabled: 1, sort: 0,
    });
    upsertFbCommentWatch({ post_id: 'P1_100', page_id: PAGE_ID, comment_count: 4, post_created_at: now, message: 'Checklist 5 prompt', permalink: 'https://fb.com/p', last_checked_at: null });
    seedComment({ status: 'sent', step: 'template', rule_ref: `template:${t}`, topic: 'Giá', created_time: now - 600, sent_at: now - 480, reply_text: 'x' });
    seedComment({ status: 'sent', step: 'agent', rule_ref: 'agent:main', topic: 'lịch học', created_time: now - 3000, sent_at: now - 2760, reply_text: 'y' });
    seedComment({ status: 'hidden', step: 'spam', rule_ref: 'spam', created_time: now - 100 });
    seedComment({ status: 'human', step: 'complaint', rule_ref: 'complaint', created_time: now - 200 });
    seedComment({ status: 'skipped', step: 'skip', created_time: now - 90000 }); // older than 24 h
    seedComment({ id: 'P1_100_page', from_page: 1, author_id: PAGE_ID, status: 'skipped', created_time: now - 60 });

    const dto = await json<CommentLogDto>(await send(app(), 'GET', `/comments/log?page=${PAGE_ID}`));
    expect(dto.pageId).toBe(PAGE_ID);
    expect(dto.autoReplyEnabled).toBe(true);
    expect(dto.pollMinutes).toBe(5);
    expect(dto.kpis).toMatchObject({ new24h: 4, autoReplied24h: 2, byTemplate24h: 1, byAgent24h: 1, hidden24h: 1, human24h: 1, medianResponseS: 180 });
    expect(dto.counts).toEqual({ all: 4, template: 1, agent: 1, other: 2 });
    expect(dto.hourly).toHaveLength(24);
    expect(dto.hourly.every((h) => h.hour >= 0 && h.hour <= 23)).toBe(true);
    const bucketTotals = dto.hourly.reduce((n, h) => n + h.template + h.agent + h.other, 0);
    expect(bucketTotals).toBe(4);
    expect(dto.hourly[23]).toMatchObject({ template: 1, agent: 0, other: 2 });
    expect(dto.hourly[22]).toMatchObject({ agent: 1 });
    expect(dto.topics).toEqual([{ topic: 'Giá', count: 1 }, { topic: 'lịch học', count: 1 }]);
    expect(dto.rows).toHaveLength(5); // the Page's own comment is not in the log
    const row = dto.rows.find((r) => r.step === 'template')!;
    expect(row).toMatchObject({
      pageId: PAGE_ID, postId: 'P1_100', postTitle: 'Checklist 5 prompt', ruleLabel: 'Mẫu "Giá"', status: 'sent', replyText: 'x',
      words: 12,
    });
    expect(row.permalink).toBe(`https://fb.com/p?comment_id=${row.id.split('_').pop()}`);
  });

  it('filters rows by kind and limit, and flags a disabled Page', async () => {
    seedComment({ status: 'sent', step: 'template', rule_ref: 'template:1' });
    seedComment({ status: 'sent', step: 'agent', rule_ref: 'agent:main' });
    seedComment({ status: 'skipped', step: 'skip' });
    const a = app();
    const kind = async (k: string) => (await json<CommentLogDto>(await send(a, 'GET', `/comments/log?page=${PAGE_ID}&kind=${k}`))).rows.length;
    expect(await kind('template')).toBe(1);
    expect(await kind('agent')).toBe(1);
    expect(await kind('other')).toBe(1);
    expect(await kind('all')).toBe(3);
    expect(await kind('bogus')).toBe(3);
    const limited = await json<CommentLogDto>(await send(a, 'GET', `/comments/log?page=${PAGE_ID}&limit=2`));
    expect(limited.rows).toHaveLength(2);
    expect(limited.counts.all).toBe(3);

    const { updateFbPageFields } = await import('../store.js');
    updateFbPageFields(PAGE_ID, { enabled: 0 });
    expect((await json<CommentLogDto>(await send(a, 'GET', `/comments/log?page=${PAGE_ID}`))).autoReplyEnabled).toBe(false);
    expect((await send(a, 'GET', '/comments/log?page=missing')).status).toBe(404);
  });
});

describe('poll-now', () => {
  const postsResponse = { data: [{ id: 'P1_100', message: 'Bài', created_time: new Date().toISOString(), comments: { summary: { total_count: 1 } } }] };

  it('polls the Page, stamps the auto-reply cut-off and reports how many comments it stored', async () => {
    exec.mockResolvedValue(postsResponse);
    graph.mockResolvedValue({
      status: 200,
      data: { data: [{ id: 'P1_100_1', message: 'Giá?', created_time: new Date(Date.now() - 5000).toISOString(), from: { id: 'u1', name: 'Lan' } }] },
    });
    const res = await send(app(), 'POST', '/comments/poll-now', { pageId: PAGE_ID });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true, fetched: 1 });
    expect(getAutoReplySince(PAGE_ID)).not.toBeNull();
    // Created before the cut-off was stamped: stored as backlog, not answered.
    expect(getFbComment('P1_100_1')).toMatchObject({ status: 'skipped', reason: 'bình luận cũ' });
  });

  it('answers 503 without a Composio key, 409 for an expired or unconnected Page, 404 for an unknown Page', async () => {
    keyConfigured.mockReturnValue(false);
    expect((await send(app(), 'POST', '/comments/poll-now', { pageId: PAGE_ID })).status).toBe(503);
    keyConfigured.mockReturnValue(true);
    expect((await send(app(), 'POST', '/comments/poll-now', { pageId: 'missing' })).status).toBe(404);
    expect((await send(app(), 'POST', '/comments/poll-now', {})).status).toBe(400);
    const { setFbCommentPageStatus } = await import('../store.js');
    setFbCommentPageStatus(PAGE_ID, 'EXPIRED');
    expect((await send(app(), 'POST', '/comments/poll-now', { pageId: PAGE_ID })).status).toBe(409);
    expect(exec).not.toHaveBeenCalled();
  });

  it('maps Composio failures to 502 and marks the Page expired', async () => {
    exec.mockRejectedValue(new ComposioConnectionExpiredError());
    const res = await send(app(), 'POST', '/comments/poll-now', { pageId: PAGE_ID });
    expect(res.status).toBe(502);
    expect(getFbCommentPage(PAGE_ID)!.status).toBe('EXPIRED');

    const { setFbCommentPageStatus } = await import('../store.js');
    setFbCommentPageStatus(PAGE_ID, 'ACTIVE');
    exec.mockRejectedValue(new ComposioAuthError());
    expect((await send(app(), 'POST', '/comments/poll-now', { pageId: PAGE_ID })).status).toBe(503);
  });
});

describe('manual actions', () => {
  it('hide hides on Facebook and marks the row; unhide reverses it', async () => {
    graph.mockResolvedValue({ status: 200, data: {} });
    const c = seedComment({ status: 'skipped', step: 'skip', reason: 'x' });
    const a = app();
    let res = await send(a, 'POST', `/comments/${c.id}/hide`);
    expect(res.status).toBe(200);
    expect(await json<CommentLogRowDto>(res)).toMatchObject({ id: c.id, status: 'hidden' });
    expect(graph).toHaveBeenLastCalledWith(PAGE_ID, { method: 'POST', path: `/${c.id}`, body: { is_hidden: true } }, expect.anything());

    res = await send(a, 'POST', `/comments/${c.id}/unhide`);
    expect(await json<CommentLogRowDto>(res)).toMatchObject({ status: 'skipped', reason: 'Đã bỏ ẩn thủ công' });
    expect(graph).toHaveBeenLastCalledWith(PAGE_ID, { method: 'POST', path: `/${c.id}`, body: { is_hidden: false } }, expect.anything());

    res = await send(a, 'POST', `/comments/${c.id}/unhide`);
    expect(res.status).toBe(409);
  });

  it('retry on a failed reply sends it now', async () => {
    graph.mockResolvedValue({ status: 200, data: { id: 'r1' } });
    const c = seedComment({ status: 'failed', step: 'agent', action: 'reply', reply_text: 'Dạ ạ', attempts: 3, error: 'HTTP 500' });
    const res = await send(app(), 'POST', `/comments/${c.id}/retry`);
    expect(res.status).toBe(200);
    expect(await json<CommentLogRowDto>(res)).toMatchObject({ status: 'sent', error: '' });
    expect(graph).toHaveBeenCalledWith(PAGE_ID, { method: 'POST', path: `/${c.id}/comments`, body: { message: 'Dạ ạ' } }, expect.anything());
  });

  it('retry on a failed hide hides again; on a failed agent run it re-queues the decision', async () => {
    graph.mockResolvedValue({ status: 200, data: {} });
    const spam = seedComment({ status: 'failed', step: 'spam', error: 'x' });
    expect(await json<CommentLogRowDto>(await send(app(), 'POST', `/comments/${spam.id}/retry`))).toMatchObject({ status: 'hidden' });

    const agentFail = seedComment({ status: 'failed', step: 'agent', error: 'Agent quá thời gian trả lời' });
    expect(await json<CommentLogRowDto>(await send(app(), 'POST', `/comments/${agentFail.id}/retry`))).toMatchObject({ status: 'new', step: '', error: '' });
  });

  it('retry refuses rows that are fine', async () => {
    const sent = seedComment({ status: 'sent' });
    expect((await send(app(), 'POST', `/comments/${sent.id}/retry`)).status).toBe(409);
    expect((await send(app(), 'POST', '/comments/nope/retry')).status).toBe(404);
  });

  it('send posts a draft now, and refuses anything that is not a draft', async () => {
    graph.mockResolvedValue({ status: 200, data: { id: 'r1' } });
    const draft = seedComment({ status: 'draft', step: 'template', action: 'reply', reply_text: 'Nháp', send_after: null });
    const res = await send(app(), 'POST', `/comments/${draft.id}/send`);
    expect(await json<CommentLogRowDto>(res)).toMatchObject({ status: 'sent', replyText: 'Nháp' });
    expect(graph).toHaveBeenCalledTimes(1);
    expect((await send(app(), 'POST', `/comments/${draft.id}/send`)).status).toBe(409);
  });

  it('does not act on the Page\'s own comments', async () => {
    const own = seedComment({ from_page: 1, status: 'skipped' });
    expect((await send(app(), 'POST', `/comments/${own.id}/hide`)).status).toBe(404);
    expect(graph).not.toHaveBeenCalled();
  });
});
