import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  getFbComment,
  getFbCommentPage,
  insertFbReplyTemplate,
  listFbReplyTemplates,
  updateFbPageFields,
  upsertFbCommentWatch,
} from '../store.js';

vi.mock('../../../_lib/composio.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../_lib/composio.js')>()),
  execute: vi.fn(),
  graphAsPage: vi.fn(),
  hasComposioKey: vi.fn(() => true),
}));
vi.mock('../settings.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../settings.js')>()), isEnabled: vi.fn(() => true), requireEnabled: vi.fn() }));
vi.mock('../compat.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../compat.js')>()), listAgentIds: () => ['main', 'content-fb'] }));
vi.mock('../notify.js', () => ({ notifyOwner: vi.fn(async () => {}) }));
vi.mock('./agent-turn.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agent-turn.js')>()),
  runCommentAgentTurn: vi.fn(),
}));

import { isEnabled } from '../settings.js';
import { ComposioConnectionExpiredError, ComposioRateLimitError, graphAsPage } from '../../../_lib/composio.js';
import { notifyOwner } from '../notify.js';
import { bindFakeRuntime, unbindFakeRuntime } from '../test-runtime.js';
import { runCommentAgentTurn } from './agent-turn.js';
import { savePageRules, savePostOverrides } from './config.js';
import { processComment, processNewComments } from './processor.js';
import { clearAutoReplySince, ensureAutoReplySince } from './state.js';
import { NOW, PAGE_ID, seedComment, seedPage } from './test-utils.js';

const graph = vi.mocked(graphAsPage);
const notify = vi.mocked(notifyOwner);
const agent = vi.mocked(runCommentAgentTurn);
const llmOn = vi.mocked(isEnabled);

function turn(decision: Record<string, unknown> | null, error?: string) {
  agent.mockResolvedValueOnce({
    decision: decision ? { text: '', privateText: '', topic: '', reason: '', ...decision } as never : null,
    rawText: '', costUsd: 0, latencyMs: 1, ...(error ? { error } : {}),
  });
}

function addTemplate(patch: Partial<Parameters<typeof insertFbReplyTemplate>[0]> = {}): number {
  return insertFbReplyTemplate({
    page_id: PAGE_ID, post_id: null, name: 'Giá', keywords_json: JSON.stringify(['giá']), match_mode: 'contains',
    variants_json: JSON.stringify(['Chào {ten}, nhắn tin Page nhé']), private_text: '', enabled: 1, sort: 0, ...patch,
  });
}

const page = () => getFbCommentPage(PAGE_ID)!;
const noBudget = () => ({ left: 3 });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW * 1000);
  vi.clearAllMocks();
  agent.mockReset();
  graph.mockReset();
  llmOn.mockReturnValue(true);
  _initTestDatabase(':memory:');
  seedPage();
  ensureAutoReplySince(PAGE_ID, NOW - 3600);
  // Deterministic delay: exactly 2 minutes.
  savePageRules(PAGE_ID, { delayMinMinutes: 2, delayMaxMinutes: 2 });
});

afterEach(() => vi.useRealTimers());

describe('backlog and staleness', () => {
  it('stores a comment created before auto-reply was enabled as skipped, never answered', async () => {
    const c = seedComment({ created_time: NOW - 7200 });
    expect(await processComment(page(), c, noBudget(), NOW)).toBe('decided');
    expect(getFbComment(c.id)).toMatchObject({ status: 'skipped', step: 'skip', reason: 'bình luận cũ' });
    expect(agent).not.toHaveBeenCalled();
  });

  it('skips comments older than 48 hours even when they postdate the cut-off', async () => {
    clearAutoReplySince(PAGE_ID);
    ensureAutoReplySince(PAGE_ID, NOW - 10 * 86400);
    const c = seedComment({ created_time: NOW - 49 * 3600 });
    await processComment(page(), c, noBudget(), NOW);
    expect(getFbComment(c.id)).toMatchObject({ status: 'skipped', reason: 'bình luận cũ' });
  });

  it('a post whose override turns auto-reply off is skipped', async () => {
    savePostOverrides(PAGE_ID, 'P1_100', { enabled: false });
    const c = seedComment({ message: 'giá bao nhiêu' });
    addTemplate();
    await processComment(page(), c, noBudget(), NOW);
    expect(getFbComment(c.id)).toMatchObject({ status: 'skipped', reason: 'Bài này tắt trả lời tự động' });
  });
});

describe('spam and complaint', () => {
  it('hides a link comment through the Graph proxy and records it as hidden', async () => {
    graph.mockResolvedValue({ status: 200, data: { success: true } });
    const c = seedComment({ message: 'xem https://kiemtien.vn nhé' });
    await processComment(page(), c, noBudget(), NOW);
    expect(graph).toHaveBeenCalledWith(
      PAGE_ID,
      { method: 'POST', path: `/${c.id}`, body: { is_hidden: true } },
      { area: 'comments', connectionId: 'ca_1', entityId: 'ent_1' },
    );
    expect(getFbComment(c.id)).toMatchObject({ status: 'hidden', step: 'spam', rule_ref: 'spam' });
    expect(agent).not.toHaveBeenCalled();
  });

  it('a spam keyword hides too, and a failed hide is recorded as failed', async () => {
    graph.mockRejectedValue(new Error('graph POST → 400: boom'));
    const c = seedComment({ message: 'Kiếm tiền online cực dễ' });
    await processComment(page(), c, noBudget(), NOW);
    expect(getFbComment(c.id)).toMatchObject({ status: 'failed', step: 'spam' });
    expect(getFbComment(c.id)!.error).toContain('boom');
  });

  it('an expired connection marks the Page EXPIRED, notifies once and leaves the comment new', async () => {
    graph.mockRejectedValue(new ComposioConnectionExpiredError());
    const a = seedComment({ message: 'xem https://a.vn' });
    const b = seedComment({ message: 'xem https://b.vn' });
    await processNewComments([PAGE_ID], () => NOW);
    expect(getFbCommentPage(PAGE_ID)!.status).toBe('EXPIRED');
    expect(getFbComment(a.id)!.status).toBe('new');
    expect(getFbComment(b.id)!.status).toBe('new');
    expect(graph).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    // An EXPIRED Page is not processed again.
    await processNewComments([PAGE_ID], () => NOW);
    expect(graph).toHaveBeenCalledTimes(1);
  });

  it('a rate limit stops the whole pass and leaves the comment new', async () => {
    graph.mockRejectedValue(new ComposioRateLimitError());
    const a = seedComment({ message: 'xem https://a.vn' });
    seedComment({ message: 'xem https://b.vn' });
    await processNewComments([PAGE_ID], () => NOW);
    expect(graph).toHaveBeenCalledTimes(1);
    expect(getFbComment(a.id)!.status).toBe('new');
  });

  it('a complaint goes to a human and notifies the owner', async () => {
    const c = seedComment({ message: 'Học xong bị lỗi không vào được nữa', author_name: 'Bình' });
    await processComment(page(), c, noBudget(), NOW);
    expect(getFbComment(c.id)).toMatchObject({ status: 'human', step: 'complaint' });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain('Bình');
    expect(agent).not.toHaveBeenCalled();
  });

  it('notify = none keeps the complaint silent', async () => {
    savePageRules(PAGE_ID, { notify: 'none' });
    const c = seedComment({ message: 'đòi hoàn tiền lừa đảo' });
    await processComment(page(), c, noBudget(), NOW);
    expect(getFbComment(c.id)!.status).toBe('human');
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('templates', () => {
  it('queues the rendered reply after the configured delay and counts the use', async () => {
    const id = addTemplate({ private_text: 'Bảng giá cho {ten}' });
    const c = seedComment({ message: 'Giá khóa này sao ạ', author_name: 'Nguyễn Thu Hà' });
    await processComment(page(), c, noBudget(), NOW);
    expect(getFbComment(c.id)).toMatchObject({
      status: 'queued', step: 'template', rule_ref: `template:${id}`, action: 'reply',
      reply_text: 'Chào Hà, nhắn tin Page nhé', private_text: 'Bảng giá cho Hà', topic: 'Giá',
      send_after: NOW + 120, decided_at: NOW,
    });
    expect(listFbReplyTemplates(PAGE_ID)[0].uses).toBe(1);
    expect(agent).not.toHaveBeenCalled();
  });

  it('rotates variants across successive uses', async () => {
    addTemplate({ variants_json: JSON.stringify(['một', 'hai']) });
    const texts: string[] = [];
    for (let i = 0; i < 3; i++) {
      const c = seedComment({ message: 'giá' });
      await processComment(page(), c, noBudget(), NOW);
      texts.push(getFbComment(c.id)!.reply_text);
    }
    expect(texts).toEqual(['một', 'hai', 'một']);
  });

  it('post-scope templates beat page-scope ones for that post only', async () => {
    addTemplate({ name: 'Page', variants_json: JSON.stringify(['page']) });
    addTemplate({ name: 'Post', post_id: 'P1_100', variants_json: JSON.stringify(['post']) });
    const onPost = seedComment({ message: 'giá' });
    const elsewhere = seedComment({ message: 'giá', post_id: 'P1_200' });
    await processComment(page(), onPost, noBudget(), NOW);
    await processComment(page(), elsewhere, noBudget(), NOW);
    expect(getFbComment(onPost.id)!.reply_text).toBe('post');
    expect(getFbComment(elsewhere.id)!.reply_text).toBe('page');
  });

  it('draft mode stores a draft with no send time', async () => {
    savePageRules(PAGE_ID, { sendMode: 'draft' });
    addTemplate();
    const c = seedComment({ message: 'giá' });
    await processComment(page(), c, noBudget(), NOW);
    expect(getFbComment(c.id)).toMatchObject({ status: 'draft', send_after: null, reply_text: 'Chào Lan, nhắn tin Page nhé' });
  });

  it('delay mode adds delayBeforeSendMinutes', async () => {
    savePageRules(PAGE_ID, { sendMode: 'delay', delayBeforeSendMinutes: 10 });
    addTemplate();
    const c = seedComment({ message: 'giá' });
    await processComment(page(), c, noBudget(), NOW);
    expect(getFbComment(c.id)!.send_after).toBe(NOW + 12 * 60);
  });
});

describe('limits', () => {
  it('leaves the comment new while the Page hourly cap is spent, then answers it', async () => {
    savePageRules(PAGE_ID, { maxPerHour: 2 });
    addTemplate();
    const rows = [1, 2, 3].map(() => seedComment({ message: 'giá' }));
    await processNewComments([PAGE_ID], () => NOW);
    expect(rows.map((r) => getFbComment(r.id)!.status)).toEqual(['queued', 'queued', 'new']);
    // An hour later the earlier replies no longer count.
    await processNewComments([PAGE_ID], () => NOW + 3601);
    expect(getFbComment(rows[2].id)!.status).toBe('queued');
  });

  it('skips once the author has had maxPerUserPerPost replies on the post', async () => {
    savePageRules(PAGE_ID, { maxPerUserPerPost: 2 });
    addTemplate();
    const ids = [1, 2, 3].map(() => seedComment({ message: 'giá', author_id: 'same-user', created_time: NOW - 30 }));
    for (const c of ids) await processComment(page(), c, noBudget(), NOW);
    expect(ids.map((r) => getFbComment(r.id)!.status)).toEqual(['queued', 'queued', 'skipped']);
    expect(getFbComment(ids[2].id)!.reason).toContain('tối đa 2');
  });

  it('a different author or a different post is not affected by maxPerUserPerPost', async () => {
    savePageRules(PAGE_ID, { maxPerUserPerPost: 1 });
    addTemplate();
    const a = seedComment({ message: 'giá', author_id: 'u-a' });
    const b = seedComment({ message: 'giá', author_id: 'u-b' });
    const a2 = seedComment({ message: 'giá', author_id: 'u-a', post_id: 'P1_200' });
    for (const c of [a, b, a2]) await processComment(page(), c, noBudget(), NOW);
    expect([a, b, a2].map((c) => getFbComment(c.id)!.status)).toEqual(['queued', 'queued', 'queued']);
  });

  it('onlyIfNotRepliedHours skips the agent when the author was replied to recently, but not templates', async () => {
    savePageRules(PAGE_ID, { onlyIfNotRepliedHours: 24, maxPerUserPerPost: 5 });
    addTemplate();
    const first = seedComment({ message: 'giá', author_id: 'u-x', created_time: NOW - 600 });
    await processComment(page(), first, noBudget(), NOW);
    const q = seedComment({ message: 'Cho mình hỏi thêm về lịch học buổi tối được không ạ', author_id: 'u-x' });
    await processComment(page(), q, noBudget(), NOW);
    expect(getFbComment(q.id)).toMatchObject({ status: 'skipped' });
    expect(getFbComment(q.id)!.reason).toContain('24 giờ');
    expect(agent).not.toHaveBeenCalled();
    const again = seedComment({ message: 'giá', author_id: 'u-x' });
    await processComment(page(), again, noBudget(), NOW);
    expect(getFbComment(again.id)!.status).toBe('queued');
  });

  it('a human reply by the Page also counts for onlyIfNotRepliedHours', async () => {
    savePageRules(PAGE_ID, { onlyIfNotRepliedHours: 24 });
    const customer = seedComment({ message: 'Anh ơi', author_id: 'u-y', status: 'skipped', created_time: NOW - 900 });
    seedComment({
      id: 'P1_100_human', from_page: 1, author_id: PAGE_ID, parent_id: customer.id, status: 'skipped',
      message: 'Chào bạn', created_time: NOW - 600,
    });
    const q = seedComment({ message: 'Cho mình hỏi thêm về lịch học buổi tối được không ạ', author_id: 'u-y' });
    await processComment(page(), q, noBudget(), NOW);
    expect(getFbComment(q.id)!.status).toBe('skipped');
    expect(agent).not.toHaveBeenCalled();
  });
});

describe('agent step', () => {
  const question = 'Khóa này dùng cho ngành spa được không ạ?';

  it('queues the agent reply, topic and private text', async () => {
    turn({ action: 'reply', text: 'Dạ được ạ', privateText: 'Chi tiết', topic: 'ngành spa', reason: 'câu hỏi' });
    const c = seedComment({ message: question });
    await processComment(page(), c, noBudget(), NOW);
    expect(getFbComment(c.id)).toMatchObject({
      status: 'queued', step: 'agent', rule_ref: 'agent:content-fb', action: 'reply',
      reply_text: 'Dạ được ạ', private_text: 'Chi tiết', topic: 'ngành spa', send_after: NOW + 120,
    });
    const call = agent.mock.calls[0][0];
    expect(call.agentId).toBe('content-fb');
    expect(call.prompt).toContain(question);
    expect(call.skillText).toContain('Trả lời bình luận Fanpage');
  });

  it('passes the Page voice, the post text and the thread into the prompt', async () => {
    upsertFbCommentWatch({
      post_id: 'P1_100', page_id: PAGE_ID, comment_count: 3, post_created_at: NOW - 100,
      message: 'Bài giới thiệu khóa agent', permalink: '', last_checked_at: null,
    });
    updateFbPageFields(PAGE_ID, { brand_voice: 'Gần gũi, hài hước' });
    seedComment({ message: 'Có học thử không bạn', author_name: 'Mai', created_time: NOW - 300, status: 'skipped' });
    turn({ action: 'skip', reason: 'x' });
    const c = seedComment({ message: question });
    await processComment(page(), c, noBudget(), NOW);
    const prompt = agent.mock.calls[0][0].prompt;
    expect(prompt).toContain('Gần gũi, hài hước');
    expect(prompt).toContain('Bài giới thiệu khóa agent');
    expect(prompt).toContain('Mai: Có học thử không bạn');
  });

  it('react is queued as a like, not a reply', async () => {
    turn({ action: 'react', topic: 'khen' });
    const c = seedComment({ message: 'Hay quá chị ơi, em theo dõi page từ lâu rồi' });
    await processComment(page(), c, noBudget(), NOW);
    expect(getFbComment(c.id)).toMatchObject({ status: 'queued', action: 'react', reply_text: '', topic: 'khen' });
  });

  it('handoff goes to a human and notifies', async () => {
    turn({ action: 'handoff', reason: 'đòi gặp người thật' });
    const c = seedComment({ message: question });
    await processComment(page(), c, noBudget(), NOW);
    expect(getFbComment(c.id)).toMatchObject({ status: 'human', step: 'agent', reason: 'đòi gặp người thật' });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('skip is stored as skipped with the agent reason', async () => {
    turn({ action: 'skip', reason: 'tranh cãi' });
    const c = seedComment({ message: question });
    await processComment(page(), c, noBudget(), NOW);
    expect(getFbComment(c.id)).toMatchObject({ status: 'skipped', reason: 'tranh cãi', step: 'agent' });
  });

  it('an unparseable agent answer is recorded as failed', async () => {
    turn(null, 'Agent quá thời gian trả lời');
    const c = seedComment({ message: question });
    await processComment(page(), c, noBudget(), NOW);
    expect(getFbComment(c.id)).toMatchObject({ status: 'failed', error: 'Agent quá thời gian trả lời' });
  });

  it('a reply carrying a link that is not in the context is sent to a human, not posted', async () => {
    turn({ action: 'reply', text: 'Xem tại https://evil.example/x nhé' });
    const c = seedComment({ message: question });
    await processComment(page(), c, noBudget(), NOW);
    expect(getFbComment(c.id)).toMatchObject({ status: 'human' });
    expect(getFbComment(c.id)!.reply_text).toBe('');
  });

  it('a link that appears in the owner instructions is allowed', async () => {
    savePageRules(PAGE_ID, { instructions: 'Đăng ký tại https://rocket.example/dk' });
    turn({ action: 'reply', text: 'Bạn đăng ký tại https://rocket.example/dk nhé' });
    const c = seedComment({ message: question });
    await processComment(page(), c, noBudget(), NOW);
    expect(getFbComment(c.id)!.status).toBe('queued');
  });

  it('uses at most 3 agent turns per pass; the rest stay new', async () => {
    for (let i = 0; i < 4; i++) turn({ action: 'skip', reason: 'x' });
    const rows = [1, 2, 3, 4].map(() => seedComment({ message: question }));
    await processNewComments([PAGE_ID], () => NOW);
    expect(agent).toHaveBeenCalledTimes(3);
    expect(rows.map((r) => getFbComment(r.id)!.status)).toEqual(['skipped', 'skipped', 'skipped', 'new']);
  });

  it('hands the comment to a human when the agent lacks comments.reply', async () => {
    const rt = bindFakeRuntime({ can: (_agent, scope) => scope !== 'comments.reply' });
    try {
      const c = seedComment({ message: question });
      await processComment(page(), c, noBudget(), NOW);
      expect(getFbComment(c.id)).toMatchObject({ status: 'human', step: 'agent' });
      expect(getFbComment(c.id)!.reason).toContain('comments.reply');
      expect(agent).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalled();
      expect(rt.leanCalls).toHaveLength(0);
    } finally {
      unbindFakeRuntime();
    }
  });

  it('a throwing agent turn leaves the comment new for a later pass', async () => {
    agent.mockRejectedValueOnce(new Error('kill switch'));
    const c = seedComment({ message: question });
    await processComment(page(), c, noBudget(), NOW);
    expect(getFbComment(c.id)!.status).toBe('new');
  });

  it('an unknown agent id falls back to main', async () => {
    savePageRules(PAGE_ID, { agentId: 'ghost' });
    turn({ action: 'skip', reason: 'x' });
    await processComment(page(), seedComment({ message: question }), noBudget(), NOW);
    expect(agent.mock.calls[0][0].agentId).toBe('main');
  });

  it('the agent is not called for short comments without a question', async () => {
    const c = seedComment({ message: 'Hay quá' });
    await processComment(page(), c, noBudget(), NOW);
    expect(getFbComment(c.id)).toMatchObject({ status: 'skipped', step: 'skip' });
    expect(agent).not.toHaveBeenCalled();
  });
});
