import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  getFbComment,
  getFbCommentPage,
  getFbCommentWatch,
  listFbCommentsForLog,
  updateFbComment,
} from '../store.js';

vi.mock('../../../_lib/composio.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../_lib/composio.js')>()),
  execute: vi.fn(),
  graphAsPage: vi.fn(),
}));

import { execute, graphAsPage } from '../../../_lib/composio.js';
import { DEFAULT_REPLY_RULES } from '../types.js';
import { pollPage } from './poller.js';
import { ensureAutoReplySince } from './state.js';
import { NOW, PAGE_ID, seedComment, seedPage } from './test-utils.js';

const exec = vi.mocked(execute);
const graph = vi.mocked(graphAsPage);

const iso = (sec: number) => new Date(sec * 1000).toISOString().replace('.000Z', '+0000');

interface FakePost { id: string; created: number; count: number; message?: string }
interface FakeComment { id: string; at: number; from?: { id: string; name: string } | null; message?: string; parent?: string }

let posts: FakePost[];
let comments: Record<string, FakeComment[]>;

function install() {
  exec.mockImplementation((async (slug: string) => {
    if (slug === 'FACEBOOK_GET_PAGE_POSTS') {
      return {
        data: posts.map((p) => ({
          id: p.id, message: p.message ?? `Bài ${p.id}`, created_time: iso(p.created), permalink_url: `https://fb.com/${p.id}`,
          comments: { data: [], summary: { total_count: p.count } },
        })),
      };
    }
    throw new Error(`unexpected ${slug}`);
  }) as never);
  graph.mockImplementation((async (_pageId: string, req: { path: string; query?: Record<string, unknown> }) => {
    const postId = req.path.replace(/^\//, '').replace(/\/comments$/, '');
    const all = comments[postId] ?? [];
    const size = Number(req.query?.limit ?? 50);
    const offset = req.query?.after ? Number(req.query.after) : 0;
    const slice = all.slice(offset, offset + size);
    const hasNext = offset + size < all.length;
    return {
      status: 200,
      data: {
        data: slice.map((c) => ({
          id: c.id, message: c.message ?? 'Giá bao nhiêu vậy ạ', created_time: iso(c.at),
          ...(c.from === null ? {} : { from: c.from ?? { id: 'u1', name: 'Lan' } }),
          ...(c.parent ? { parent: { id: c.parent } } : {}),
        })),
        paging: hasNext ? { cursors: { after: String(offset + size) }, next: 'https://graph.facebook.com/next' } : { cursors: { after: String(offset + size) } },
      },
    };
  }) as never);
}

const page = () => getFbCommentPage(PAGE_ID)!;
const rules = { ...DEFAULT_REPLY_RULES };
const calls = (slug: string): unknown[][] => (slug === 'FACEBOOK_GET_COMMENTS' ? graph.mock.calls : exec.mock.calls.filter((c) => c[0] === slug));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW * 1000);
  exec.mockReset();
  graph.mockReset();
  _initTestDatabase(':memory:');
  seedPage();
  posts = [{ id: 'P1_100', created: NOW - 3600, count: 2 }];
  comments = {
    P1_100: [
      { id: 'P1_100_2', at: NOW - 100 },
      { id: 'P1_100_1', at: NOW - 600 },
    ],
  };
  install();
});

afterEach(() => vi.useRealTimers());

describe('backlog', () => {
  it('stores comments created before auto-reply was enabled as skipped "bình luận cũ"', async () => {
    ensureAutoReplySince(PAGE_ID, NOW - 300);
    const r = await pollPage(page(), rules, NOW);
    expect(r.fetched).toBe(2);
    expect(getFbComment('P1_100_1')).toMatchObject({ status: 'skipped', step: 'skip', reason: 'bình luận cũ', from_page: 0 });
    expect(getFbComment('P1_100_2')).toMatchObject({ status: 'new', reason: '' });
  });

  it('with no cut-off recorded nothing is ever answered', async () => {
    await pollPage(page(), rules, NOW);
    expect(getFbComment('P1_100_1')!.status).toBe('skipped');
    expect(getFbComment('P1_100_2')!.status).toBe('skipped');
  });

  it('a comment created exactly at the cut-off counts as new', async () => {
    ensureAutoReplySince(PAGE_ID, NOW - 100);
    await pollPage(page(), rules, NOW);
    expect(getFbComment('P1_100_2')!.status).toBe('new');
  });
});

describe('what is fetched', () => {
  beforeEach(() => ensureAutoReplySince(PAGE_ID, NOW - 3600));

  it('asks for the recent posts of the Page with comment summaries', async () => {
    await pollPage(page(), rules, NOW);
    const [, args, target] = exec.mock.calls.filter((c) => c[0] === 'FACEBOOK_GET_PAGE_POSTS')[0];
    expect(args).toMatchObject({ page_id: PAGE_ID, since: String(NOW - 7 * 86400) });
    expect(String(args.fields)).toContain('comments.summary(true)');
    expect(target).toEqual({ area: 'comments', connectionId: 'ca_1', entityId: 'ent_1' });
  });

  it('reads comments newest first, flat with replies, only for posts that changed', async () => {
    await pollPage(page(), rules, NOW);
    expect(calls('FACEBOOK_GET_COMMENTS')).toHaveLength(1);
    const [pageId, req, target] = graph.mock.calls[0];
    expect(pageId).toBe(PAGE_ID);
    expect(req).toMatchObject({
      method: 'GET', path: '/P1_100/comments',
      query: { order: 'reverse_chronological', filter: 'stream', limit: 50, fields: 'id,from{id,name},message,created_time,parent{id}' },
    });
    expect(target).toEqual({ area: 'comments', connectionId: 'ca_1', entityId: 'ent_1' });
    expect(getFbCommentWatch('P1_100')).toMatchObject({ comment_count: 2, message: 'Bài P1_100', permalink: 'https://fb.com/P1_100' });

    // Same count 10 minutes later: posts are listed again, comments are not.
    exec.mockClear();
    graph.mockClear();
    await pollPage(page(), rules, NOW + 600);
    expect(calls('FACEBOOK_GET_PAGE_POSTS')).toHaveLength(1);
    expect(calls('FACEBOOK_GET_COMMENTS')).toHaveLength(0);
  });

  it('re-reads a young post once an hour even if the count is unchanged (replies are not counted)', async () => {
    await pollPage(page(), rules, NOW);
    exec.mockClear();
    graph.mockClear();
    await pollPage(page(), rules, NOW + 3601);
    expect(calls('FACEBOOK_GET_COMMENTS')).toHaveLength(1);
  });

  it('does not recheck an old post just because an hour passed', async () => {
    posts = [{ id: 'P1_100', created: NOW - 3 * 86400, count: 2 }];
    await pollPage(page(), rules, NOW);
    exec.mockClear();
    graph.mockClear();
    await pollPage(page(), rules, NOW + 7200);
    expect(calls('FACEBOOK_GET_COMMENTS')).toHaveLength(0);
  });

  it('fetches again when the count changes and stops at the first known comment', async () => {
    await pollPage(page(), rules, NOW);
    posts[0].count = 3;
    comments.P1_100 = [{ id: 'P1_100_3', at: NOW + 50 }, ...comments.P1_100];
    vi.setSystemTime((NOW + 600) * 1000);
    const r = await pollPage(page(), rules, NOW + 600);
    expect(r.fetched).toBe(1);
    expect(getFbComment('P1_100_3')).toMatchObject({ status: 'new', author_name: 'Lan' });
    expect(getFbCommentWatch('P1_100')!.comment_count).toBe(3);
  });

  it('pages through comments with the after cursor until it reaches a known one', async () => {
    ensureAutoReplySince(PAGE_ID, NOW - 100000);
    posts = [{ id: 'P1_100', created: NOW - 3600, count: 120 }];
    comments.P1_100 = Array.from({ length: 120 }, (_, i) => ({ id: `P1_100_c${i}`, at: NOW - 10 - i }));
    const first = await pollPage(page(), rules, NOW);
    expect(first.fetched).toBe(120);
    expect(graph.mock.calls.map((c) => (c[1].query as Record<string, unknown>).after)).toEqual([undefined, '50', '100']);

    // Five new comments arrive on top: one page is enough, the second page is never requested.
    graph.mockClear();
    posts[0].count = 125;
    comments.P1_100 = [...Array.from({ length: 5 }, (_, i) => ({ id: `P1_100_n${i}`, at: NOW + 5 - i })), ...comments.P1_100];
    vi.setSystemTime((NOW + 600) * 1000);
    const second = await pollPage(page(), rules, NOW + 600);
    expect(second.fetched).toBe(5);
    expect(graph).toHaveBeenCalledTimes(1);
  });

  it('reads at most 4 pages of comments per post per poll', async () => {
    ensureAutoReplySince(PAGE_ID, NOW - 100000);
    posts = [{ id: 'P1_100', created: NOW - 3600, count: 300 }];
    comments.P1_100 = Array.from({ length: 300 }, (_, i) => ({ id: `P1_100_c${i}`, at: NOW - 10 - i }));
    const r = await pollPage(page(), rules, NOW);
    expect(r.fetched).toBe(200);
    expect(graph).toHaveBeenCalledTimes(4);
  });

  it('skips posts with no comments and posts older than maxPostAgeDays', async () => {
    posts = [
      { id: 'P1_empty', created: NOW - 100, count: 0 },
      { id: 'P1_old', created: NOW - 10 * 86400, count: 5 },
    ];
    await pollPage(page(), rules, NOW);
    expect(calls('FACEBOOK_GET_COMMENTS')).toHaveLength(0);
    expect(getFbCommentWatch('P1_empty')).toMatchObject({ comment_count: 0 });
    expect(getFbCommentWatch('P1_old')).toBeUndefined();
  });

  it('reads at most 10 posts per poll and carries the rest over to the next poll', async () => {
    posts = Array.from({ length: 12 }, (_, i) => ({ id: `P1_p${i}`, created: NOW - 100 - i, count: 1 }));
    comments = Object.fromEntries(posts.map((p) => [p.id, [{ id: `${p.id}_c`, at: NOW - 10 }]]));
    await pollPage(page(), rules, NOW);
    expect(calls('FACEBOOK_GET_COMMENTS')).toHaveLength(10);
    exec.mockClear();
    graph.mockClear();
    await pollPage(page(), rules, NOW + 300);
    expect(calls('FACEBOOK_GET_COMMENTS')).toHaveLength(2);
    expect(listFbCommentsForLog(PAGE_ID, 100)).toHaveLength(12);
  });

  it('leaves the stored count alone for a post it did not get to', async () => {
    posts = Array.from({ length: 11 }, (_, i) => ({ id: `P1_p${i}`, created: NOW - 100 - i, count: 1 }));
    comments = Object.fromEntries(posts.map((p) => [p.id, [{ id: `${p.id}_c`, at: NOW - 10 }]]));
    await pollPage(page(), rules, NOW);
    expect(getFbCommentWatch('P1_p10')).toMatchObject({ comment_count: 0, last_checked_at: null });
  });

  it('keeps what it stored and does not mark the post read when the comment call fails', async () => {
    graph.mockRejectedValue(new Error('HTTP 500'));
    await expect(pollPage(page(), rules, NOW)).rejects.toThrow('HTTP 500');
    expect(getFbCommentWatch('P1_100')).toBeUndefined();
  });
});

describe('who wrote it', () => {
  beforeEach(() => ensureAutoReplySince(PAGE_ID, NOW - 3600));

  it("stores the Page's own comments as from_page and does not count them", async () => {
    comments.P1_100 = [
      { id: 'P1_100_9', at: NOW - 10, from: { id: PAGE_ID, name: 'Ninh Bình Home' }, message: 'Cảm ơn bạn' },
      { id: 'P1_100_8', at: NOW - 20, from: { id: 'u7', name: 'An' } },
    ];
    const r = await pollPage(page(), rules, NOW);
    expect(r.fetched).toBe(1);
    expect(getFbComment('P1_100_9')).toMatchObject({ from_page: 1, status: 'skipped' });
    expect(listFbCommentsForLog(PAGE_ID, 10).map((c) => c.id)).toEqual(['P1_100_8']);
  });

  it('never treats the studio\'s own reply as a customer comment, even when Facebook omits the author', async () => {
    const mine = seedComment({ id: 'P1_100_5', status: 'sent', reply_comment_id: 'P1_100_77' });
    updateFbComment(mine.id, { reply_comment_id: 'P1_100_77' });
    comments.P1_100 = [{ id: 'P1_100_77', at: NOW - 5, from: null, message: 'Cảm ơn bạn' }];
    posts[0].count = 3;
    const r = await pollPage(page(), rules, NOW);
    expect(r.fetched).toBe(0);
    expect(getFbComment('P1_100_77')).toMatchObject({ from_page: 1, status: 'skipped' });
  });

  it('records replies with their parent comment', async () => {
    comments.P1_100 = [
      { id: 'P1_100_4', at: NOW - 10, parent: 'P1_100_3', message: 'Mình cũng muốn hỏi' },
      { id: 'P1_100_3', at: NOW - 20 },
    ];
    await pollPage(page(), rules, NOW);
    expect(getFbComment('P1_100_4')).toMatchObject({ parent_id: 'P1_100_3', status: 'new' });
    expect(getFbComment('P1_100_3')!.parent_id).toBeNull();
  });
});
