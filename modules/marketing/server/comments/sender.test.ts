import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, getFbComment, getFbCommentPage } from '../store.js';

vi.mock('../../../_lib/composio.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../_lib/composio.js')>()),
  graphAsPage: vi.fn(),
}));
vi.mock('../notify.js', () => ({ notifyOwner: vi.fn(async () => {}) }));

import { ComposioConnectionExpiredError, ComposioRateLimitError, graphAsPage } from '../../../_lib/composio.js';
import { notifyOwner } from '../notify.js';
import { sendComment, sendDueComments } from './sender.js';
import { NOW, PAGE_ID, seedComment, seedPage } from './test-utils.js';

const graph = vi.mocked(graphAsPage);
const notify = vi.mocked(notifyOwner);

// graphAsPage is dispatched by edge: public reply, private reply, like.
const hook = {
  comments: vi.fn(async (_req: unknown): Promise<unknown> => ({ id: 'P1_100_reply1' })),
  messages: vi.fn(async (_req: unknown): Promise<unknown> => ({})),
  likes: vi.fn(async (_req: unknown): Promise<unknown> => ({ success: true })),
};

const TARGET = { area: 'comments', connectionId: 'ca_1', entityId: 'ent_1' };

function queued(patch: Record<string, unknown> = {}) {
  return seedComment({
    status: 'queued', step: 'template', action: 'reply', reply_text: 'Cảm ơn bạn', send_after: NOW - 1,
    decided_at: NOW - 100, ...patch,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW * 1000);
  graph.mockReset();
  notify.mockClear();
  _initTestDatabase(':memory:');
  seedPage();
  hook.comments.mockReset().mockResolvedValue({ id: 'P1_100_reply1' });
  hook.messages.mockReset().mockResolvedValue({});
  hook.likes.mockReset().mockResolvedValue({ success: true });
  graph.mockImplementation((async (_p: string, req: { path: string }) => {
    const edge = req.path.endsWith('/comments') ? hook.comments : req.path.endsWith('/messages') ? hook.messages : hook.likes;
    return { status: 200, data: await edge(req) };
  }) as never);
});

afterEach(() => vi.useRealTimers());

describe('queue timing', () => {
  it('does not send before send_after and sends once it has passed', async () => {
    const c = queued({ send_after: NOW + 120 });
    expect(await sendDueComments()).toBe(0);
    expect(hook.comments).not.toHaveBeenCalled();
    expect(getFbComment(c.id)!.status).toBe('queued');

    vi.setSystemTime((NOW + 121) * 1000);
    expect(await sendDueComments()).toBe(1);
    expect(hook.comments).toHaveBeenCalledTimes(1);
    expect(getFbComment(c.id)!.status).toBe('sent');
  });

  it('sends the oldest due comments first and at most 10 per tick', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => queued({ send_after: NOW - 100 + i }));
    await sendDueComments();
    expect(hook.comments).toHaveBeenCalledTimes(10);
    expect(getFbComment(rows[0].id)!.status).toBe('sent');
    expect(getFbComment(rows[10].id)!.status).toBe('queued');
    expect(getFbComment(rows[11].id)!.status).toBe('queued');
  });

  it('never sends drafts or comments of other statuses', async () => {
    seedComment({ status: 'draft', reply_text: 'nháp', send_after: null });
    seedComment({ status: 'skipped', reply_text: 'x', send_after: NOW - 5 });
    await sendDueComments();
    expect(hook.comments).not.toHaveBeenCalled();
  });
});

describe('public and private replies', () => {
  it('posts the public reply on the comment and records the reply id', async () => {
    const c = queued({ reply_text: 'Chào Lan' });
    expect(await sendComment(c.id)).toBe('sent');
    expect(graph).toHaveBeenCalledWith('P1', { method: 'POST', path: `/${c.id}/comments`, body: { message: 'Chào Lan' } }, TARGET);
    expect(hook.messages).not.toHaveBeenCalled();
    expect(getFbComment(c.id)).toMatchObject({ status: 'sent', reply_comment_id: 'P1_100_reply1', error: '', private_sent: 0 });
    expect(getFbComment(c.id)!.sent_at).toBe(NOW);
  });

  it('then sends the private reply through POST /{page-id}/messages with the comment id as recipient', async () => {
    const c = queued({ private_text: 'Mình gửi bảng giá' });
    await sendComment(c.id);
    expect(graph).toHaveBeenCalledWith(
      'P1',
      { method: 'POST', path: '/P1/messages', body: { recipient: { comment_id: c.id }, message: { text: 'Mình gửi bảng giá' } } },
      TARGET,
    );
    expect(getFbComment(c.id)).toMatchObject({ status: 'sent', private_sent: 1, error: '' });
  });

  it('a private-only reply sends no public comment', async () => {
    const c = queued({ reply_text: '', private_text: 'Nhắn riêng' });
    expect(await sendComment(c.id)).toBe('sent');
    expect(hook.comments).not.toHaveBeenCalled();
    expect(getFbComment(c.id)).toMatchObject({ status: 'sent', private_sent: 1 });
  });

  it('keeps the public reply when the private reply is refused, records the error and notifies once per Page', async () => {
    hook.messages.mockRejectedValue(new Error('graph POST → 400: (#200) Requires pages_messaging permission'));
    const a = queued({ private_text: 'riêng 1' });
    const b = queued({ private_text: 'riêng 2' });
    await sendComment(a.id);
    await sendComment(b.id);
    for (const c of [a, b]) {
      const row = getFbComment(c.id)!;
      expect(row.status).toBe('sent');
      expect(row.reply_comment_id).toBe('P1_100_reply1');
      expect(row.private_sent).toBe(0);
      expect(row.error).toContain('Không gửi được tin nhắn riêng');
    }
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain('pages_messaging');
  });

  it('notifies again after a private reply has worked in between', async () => {
    hook.messages.mockRejectedValueOnce(new Error('boom'));
    await sendComment(queued({ private_text: 'a' }).id);
    hook.messages.mockResolvedValueOnce({});
    await sendComment(queued({ private_text: 'b' }).id);
    hook.messages.mockRejectedValueOnce(new Error('boom'));
    await sendComment(queued({ private_text: 'c' }).id);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('a private-only reply that fails is failed (nothing reached the customer)', async () => {
    hook.messages.mockRejectedValue(new Error('no permission'));
    const c = queued({ reply_text: '', private_text: 'Nhắn riêng' });
    expect(await sendComment(c.id)).toBe('failed');
    expect(getFbComment(c.id)).toMatchObject({ status: 'failed', sent_at: null });
    expect(getFbComment(c.id)!.error).toContain('Không gửi được tin nhắn riêng');
  });

  it('a rate limit on the private step retries without posting the public reply twice', async () => {
    hook.messages.mockRejectedValueOnce(new ComposioRateLimitError());
    const c = queued({ private_text: 'riêng' });
    expect(await sendComment(c.id)).toBe('stop');
    expect(hook.comments).toHaveBeenCalledTimes(1);
    expect(getFbComment(c.id)).toMatchObject({ status: 'queued', reply_comment_id: 'P1_100_reply1', attempts: 0 });

    vi.setSystemTime((NOW + 601) * 1000);
    expect(await sendComment(c.id)).toBe('sent');
    expect(hook.comments).toHaveBeenCalledTimes(1);
    expect(getFbComment(c.id)).toMatchObject({ status: 'sent', private_sent: 1 });
  });

  it('remembers a sent reply even when Facebook returned no id', async () => {
    hook.comments.mockResolvedValue({});
    hook.messages.mockRejectedValueOnce(new ComposioRateLimitError());
    const c = queued({ private_text: 'riêng' });
    await sendComment(c.id);
    expect(getFbComment(c.id)!.reply_comment_id).toBe('posted');
  });
});

describe('react', () => {
  it('likes the comment as the Page', async () => {
    const c = queued({ action: 'react', reply_text: '', step: 'agent' });
    expect(await sendComment(c.id)).toBe('sent');
    expect(graph).toHaveBeenCalledWith('P1', { method: 'POST', path: `/${c.id}/likes` }, TARGET);
    expect(hook.comments).not.toHaveBeenCalled();
    expect(getFbComment(c.id)).toMatchObject({ status: 'reacted' });
  });
});

describe('failures', () => {
  it('retries a transient failure after 2, then 5 minutes, then fails after 3 attempts', async () => {
    hook.comments.mockRejectedValue(new Error('HTTP 500'));
    const c = queued();

    expect(await sendComment(c.id)).toBe('retry');
    expect(getFbComment(c.id)).toMatchObject({ status: 'queued', attempts: 1, send_after: NOW + 120 });

    vi.setSystemTime((NOW + 121) * 1000);
    expect(await sendComment(c.id)).toBe('retry');
    expect(getFbComment(c.id)).toMatchObject({ attempts: 2, send_after: NOW + 121 + 300 });

    vi.setSystemTime((NOW + 500) * 1000);
    expect(await sendComment(c.id)).toBe('failed');
    expect(getFbComment(c.id)).toMatchObject({ status: 'failed', attempts: 3, send_after: null });
    expect(getFbComment(c.id)!.error).toContain('HTTP 500');
  });

  it('a rate limit backs off 10 minutes without using an attempt and stops the tick', async () => {
    hook.comments.mockRejectedValue(new ComposioRateLimitError());
    const a = queued({ send_after: NOW - 10 });
    const b = queued({ send_after: NOW - 5 });
    await sendDueComments();
    expect(hook.comments).toHaveBeenCalledTimes(1);
    expect(getFbComment(a.id)).toMatchObject({ status: 'queued', attempts: 0, send_after: NOW + 600 });
    expect(getFbComment(b.id)).toMatchObject({ status: 'queued', attempts: 0 });
  });

  it('an expired connection marks the Page EXPIRED, notifies once and keeps the reply queued', async () => {
    hook.comments.mockRejectedValue(new ComposioConnectionExpiredError());
    const a = queued({ send_after: NOW - 10 });
    const b = queued({ send_after: NOW - 5 });
    await sendDueComments();
    expect(getFbCommentPage(PAGE_ID)!.status).toBe('EXPIRED');
    expect(getFbComment(a.id)).toMatchObject({ status: 'queued', attempts: 0 });
    expect(getFbComment(a.id)!.send_after).toBeGreaterThan(NOW);
    expect(notify).toHaveBeenCalledTimes(1);
    // The second comment is skipped without another call: the Page is EXPIRED now.
    expect(hook.comments).toHaveBeenCalledTimes(1);
    expect(getFbComment(b.id)!.status).toBe('queued');
  });

  it('does not send for an EXPIRED Page', async () => {
    const { setFbCommentPageStatus } = await import('../store.js');
    setFbCommentPageStatus(PAGE_ID, 'EXPIRED');
    const c = queued();
    expect(await sendComment(c.id)).toBe('skipped');
    expect(hook.comments).not.toHaveBeenCalled();
  });

  it('drops a queued reply whose comment has become stale', async () => {
    const c = queued({ created_time: NOW - 49 * 3600 });
    expect(await sendComment(c.id)).toBe('skipped');
    expect(getFbComment(c.id)).toMatchObject({ status: 'skipped', reason: 'bình luận cũ' });
    expect(hook.comments).not.toHaveBeenCalled();
  });
});

describe('claiming', () => {
  it('two concurrent sends of the same comment post once', async () => {
    hook.comments.mockImplementation(async () => { await Promise.resolve(); return { id: 'r' }; });
    const c = queued();
    const [x, y] = await Promise.all([sendComment(c.id), sendComment(c.id)]);
    expect([x, y].sort()).toEqual(['sent', 'skipped']);
    expect(hook.comments).toHaveBeenCalledTimes(1);
  });

  it('force sends a comment whose send_after is in the future (manual send)', async () => {
    const c = queued({ send_after: NOW + 3600 });
    expect(await sendComment(c.id)).toBe('skipped');
    expect(await sendComment(c.id, { force: true })).toBe('sent');
  });
});
