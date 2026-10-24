import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  getFbComment,
  getFbSetting,
  listFbCommentsForLog,
  updateFbPageFields,
} from '../store.js';

vi.mock('../../../_lib/composio.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../_lib/composio.js')>()),
  execute: vi.fn(),
  graphAsPage: vi.fn(),
}));
vi.mock('../compat.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../compat.js')>()), listAgentIds: () => ['main', 'content-fb'] }));
vi.mock('../notify.js', () => ({ notifyOwner: vi.fn(async () => {}) }));
vi.mock('../settings.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../settings.js')>()), isEnabled: vi.fn(() => true), requireEnabled: vi.fn(), isFbStudioEnabled: vi.fn(() => true) }));
vi.mock('./agent-turn.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agent-turn.js')>()),
  runCommentAgentTurn: vi.fn(),
}));

import { isEnabled } from '../settings.js';
import { execute, graphAsPage } from '../../../_lib/composio.js';
import { isFbStudioEnabled } from '../settings.js';
import { runCommentAgentTurn } from './agent-turn.js';
import { savePageRules } from './config.js';
import { getAutoReplySince } from './state.js';
import { NOW, PAGE_ID, seedPage } from './test-utils.js';
import { commentsWorkerStatus, runCommentsTick } from './worker.js';

const exec = vi.mocked(execute);
const graph = vi.mocked(graphAsPage);
const studioOn = vi.mocked(isFbStudioEnabled);
const killSwitch = vi.mocked(isEnabled);
const agent = vi.mocked(runCommentAgentTurn);

const iso = (sec: number) => new Date(sec * 1000).toISOString().replace('.000Z', '+0000');
const at = (sec: number) => vi.setSystemTime(sec * 1000);

let postCount: number;
let commentList: { id: string; at: number; message: string }[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at(NOW);
  exec.mockReset();
  agent.mockReset();
  studioOn.mockReturnValue(true);
  killSwitch.mockReturnValue(true);
  _initTestDatabase(':memory:');
  seedPage();
  savePageRules(PAGE_ID, { delayMinMinutes: 1, delayMaxMinutes: 1, pollMinutes: 5 });
  postCount = 1;
  commentList = [{ id: 'P1_100_1', at: NOW - 600, message: 'Bình luận cũ trước khi bật' }];
  graph.mockReset();
  exec.mockImplementation((async (slug: string) => {
    if (slug === 'FACEBOOK_GET_PAGE_POSTS') {
      return { data: [{ id: 'P1_100', message: 'Bài', created_time: iso(NOW - 3600), comments: { summary: { total_count: postCount } } }] };
    }
    throw new Error(`unexpected ${slug}`);
  }) as never);
  graph.mockImplementation((async (_p: string, req: { method: string; path: string }) => {
    if (req.method === 'GET' && req.path.endsWith('/comments')) {
      return { status: 200, data: { data: commentList.map((c) => ({ id: c.id, message: c.message, created_time: iso(c.at), from: { id: `u-${c.id}`, name: 'Lan' } })) } };
    }
    if (req.method === 'POST' && req.path.endsWith('/comments')) return { status: 200, data: { id: 'reply-1' } };
    throw new Error(`unexpected ${req.method} ${req.path}`);
  }) as never);
});

afterEach(() => vi.useRealTimers());

describe('worker gating', () => {
  it('does nothing while the studio is off', async () => {
    studioOn.mockReturnValue(false);
    await runCommentsTick();
    expect(exec).not.toHaveBeenCalled();
    expect(getAutoReplySince(PAGE_ID)).toBeNull();
  });

  it('does nothing while FB_AUTOREPLY_ENABLED is off', async () => {
    killSwitch.mockImplementation((name) => name !== 'FB_AUTOREPLY_ENABLED');
    await runCommentsTick();
    expect(exec).not.toHaveBeenCalled();
  });

  it('ignores Pages that are not enabled or whose rules are off, and forgets their cut-off', async () => {
    updateFbPageFields(PAGE_ID, { enabled: 0 });
    await runCommentsTick();
    expect(exec).not.toHaveBeenCalled();

    updateFbPageFields(PAGE_ID, { enabled: 1 });
    await runCommentsTick();
    expect(getAutoReplySince(PAGE_ID)).toBe(NOW);

    savePageRules(PAGE_ID, { enabled: false });
    exec.mockClear();
    await runCommentsTick();
    expect(exec).not.toHaveBeenCalled();
    expect(getAutoReplySince(PAGE_ID)).toBeNull();
  });
});

describe('end to end', () => {
  it('never answers the backlog, then polls, decides and sends a new comment on schedule', async () => {
    // Tick 1: auto-reply is first enabled now; the existing comment is backlog.
    await runCommentsTick();
    expect(getAutoReplySince(PAGE_ID)).toBe(NOW);
    expect(getFbComment('P1_100_1')).toMatchObject({ status: 'skipped', reason: 'bình luận cũ' });
    expect(commentsWorkerStatus().lastPollAt).toBe(NOW);
    expect(graph.mock.calls.some((c) => c[1].method === 'POST')).toBe(false);

    // A customer comments; the poll interval (5 min) has not elapsed yet.
    postCount = 2;
    commentList = [{ id: 'P1_100_2', at: NOW + 60, message: 'Khóa này dùng cho ngành spa được không ạ?' }, ...commentList];
    agent.mockResolvedValue({
      decision: { action: 'reply', text: 'Dạ được ạ', privateText: '', topic: 'ngành spa', reason: 'câu hỏi' },
      rawText: '', costUsd: 0, latencyMs: 1,
    });
    at(NOW + 120);
    await runCommentsTick();
    expect(getFbComment('P1_100_2')).toBeUndefined();

    // After the interval the comment is fetched, decided and queued 1 minute out.
    at(NOW + 301);
    await runCommentsTick();
    expect(getFbComment('P1_100_2')).toMatchObject({ status: 'queued', step: 'agent', reply_text: 'Dạ được ạ', send_after: NOW + 301 + 60 });
    expect(graph.mock.calls.some((c) => c[1].method === 'POST')).toBe(false);

    // Not yet due.
    at(NOW + 340);
    await runCommentsTick();
    expect(getFbComment('P1_100_2')!.status).toBe('queued');

    // Due: sent.
    at(NOW + 365);
    await runCommentsTick();
    expect(getFbComment('P1_100_2')).toMatchObject({ status: 'sent', reply_comment_id: 'reply-1' });
    const create = graph.mock.calls.filter((c) => c[1].method === 'POST');
    expect(create).toHaveLength(1);
    expect(create[0][1]).toEqual({ method: 'POST', path: '/P1_100_2/comments', body: { message: 'Dạ được ạ' } });
    expect(listFbCommentsForLog(PAGE_ID, 10)).toHaveLength(2);
    expect(getFbSetting('comments_last_poll_at')).toBe(String(NOW + 301));
  });

  it('a failing poll is retried at the Page pace, not on every tick', async () => {
    exec.mockRejectedValue(new Error('HTTP 500'));
    await runCommentsTick();
    const calls = exec.mock.calls.length;
    at(NOW + 60);
    await runCommentsTick();
    expect(exec.mock.calls.length).toBe(calls);
    at(NOW + 301);
    await runCommentsTick();
    expect(exec.mock.calls.length).toBeGreaterThan(calls);
  });

  it('overlapping ticks do not run the poll twice', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    exec.mockImplementation((async (slug: string) => {
      if (slug === 'FACEBOOK_GET_PAGE_POSTS') { await gate; return { data: [] }; }
      return { data: [] };
    }) as never);
    const first = runCommentsTick();
    const second = runCommentsTick();
    await Promise.resolve();
    release();
    await Promise.all([first, second]);
    expect(exec.mock.calls.filter((c) => c[0] === 'FACEBOOK_GET_PAGE_POSTS')).toHaveLength(1);
  });
});
