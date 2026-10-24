/**
 * Sender: delivers queued replies once their `send_after` has passed.
 *
 *   public reply   Graph POST /{comment-id}/comments as the Page
 *   private reply  Graph POST /{page-id}/messages {recipient:{comment_id}, message:{text}}
 *   react          Graph POST /{comment-id}/likes (the Page likes the comment)
 *
 * A private reply that fails (typically missing pages_messaging permission)
 * never undoes the public reply: the error is recorded on the row and the
 * owner is told once per Page. Each step is saved as soon as it succeeds so a
 * retry never posts the public reply twice.
 */

import {
  claimFbCommentForSend,
  getFbComment,
  getFbCommentPage,
  listFbDueComments,
  updateFbComment,
  type FbCommentPageRow,
  type FbCommentRow,
} from '../store.js';
import { logger } from '../compat.js';
import {
  ComposioConnectionExpiredError,
  ComposioRateLimitError,
  FbBudgetExceeded,
  graphAsPage,
} from '../../../_lib/composio.js';
import { notifyOwner } from '../notify.js';
import { describeError, handleExpired, targetFor } from './common.js';
import { extractId } from './extract.js';
import { isStale, MAX_SEND_ATTEMPTS, retryDelaySeconds, STALE_REASON } from './limits.js';
import { claimOnce, resetOnce } from './state.js';

const nowSec = (): number => Math.floor(Date.now() / 1000);

/** While a row is being sent it is not due again for this long (covers a crash mid-send). */
const LEASE_SECONDS = 300;
const RATE_LIMIT_BACKOFF = 600;
const MAX_PER_TICK = 10;

export type SendOutcome = 'sent' | 'retry' | 'failed' | 'expired' | 'stop' | 'skipped';

/** Delivers one queued comment that is due now. The caller has already claimed it. */
async function deliver(page: FbCommentPageRow, row: FbCommentRow, now: number): Promise<SendOutcome> {
  const target = targetFor(page);

  if (row.action === 'react') {
    await graphAsPage(page.id, { method: 'POST', path: `/${row.id}/likes` }, target);
    updateFbComment(row.id, { status: 'reacted', sent_at: nowSec(), error: '' });
    return 'sent';
  }

  let current = row;
  if (current.reply_text && !current.reply_comment_id) {
    // FACEBOOK_CREATE_COMMENT mis-parses a comment id as a page id, so reply through the Graph edge as the Page.
    const { data } = await graphAsPage(page.id, { method: 'POST', path: `/${current.id}/comments`, body: { message: current.reply_text } }, target);
    // 'posted' marks "sent, id unknown" so a retry after a later failure cannot post it again.
    updateFbComment(current.id, { reply_comment_id: extractId(data) || 'posted', sent_at: nowSec() });
    current = getFbComment(current.id) ?? current;
  }

  let privateError = '';
  if (current.private_text && !current.private_sent) {
    try {
      await graphAsPage(page.id, {
        method: 'POST',
        path: `/${page.id}/messages`,
        body: { recipient: { comment_id: current.id }, message: { text: current.private_text } },
      }, target);
      updateFbComment(current.id, { private_sent: 1 });
      resetOnce(`private-failed:${page.id}`);
    } catch (err) {
      if (err instanceof ComposioConnectionExpiredError || err instanceof ComposioRateLimitError || err instanceof FbBudgetExceeded) {
        // Transient or connection-wide: let the retry logic of the caller handle it.
        throw err;
      }
      privateError = `Không gửi được tin nhắn riêng: ${describeError(err)}`;
      if (claimOnce(`private-failed:${page.id}`)) {
        await notifyOwner(
          `Không gửi được tin nhắn riêng (trả lời bình luận → hộp thư) trên Page "${page.name}". `
          + 'Trả lời công khai vẫn được gửi. Kiểm tra quyền pages_messaging của kết nối Facebook trong Composio.',
        );
      }
    }
  }

  const publicSent = Boolean(current.reply_text) || Boolean(current.reply_comment_id);
  if (!publicSent && privateError) {
    // Private-only reply that failed: nothing reached the customer.
    updateFbComment(current.id, { status: 'failed', error: privateError, sent_at: null });
    return 'failed';
  }
  updateFbComment(current.id, { status: 'sent', sent_at: nowSec(), error: privateError });
  return 'sent';
}

/**
 * Claims and delivers one queued comment. Safe to call concurrently for the
 * same id: only one caller wins the claim. `force` ignores `send_after`
 * (manual "send now").
 */
export async function sendComment(id: string, opts: { force?: boolean } = {}): Promise<SendOutcome> {
  const now = nowSec();
  const row = getFbComment(id);
  if (!row || row.status !== 'queued') return 'skipped';
  const page = getFbCommentPage(row.page_id);
  if (!page || page.status === 'EXPIRED' || page.status === 'MISSING') return 'skipped';
  if (isStale(row.created_time, now) && !opts.force) {
    updateFbComment(row.id, { status: 'skipped', step: 'skip', reason: STALE_REASON, send_after: null });
    return 'skipped';
  }
  if (opts.force) updateFbComment(row.id, { send_after: now });
  if (!claimFbCommentForSend(row.id, now, now + LEASE_SECONDS)) return 'skipped';

  const claimed = getFbComment(row.id) ?? row;
  try {
    return await deliver(page, claimed, now);
  } catch (err) {
    if (err instanceof ComposioConnectionExpiredError) {
      await handleExpired(page);
      // Back to waiting; picked up again after the Page is reconnected.
      updateFbComment(row.id, { attempts: Math.max(0, claimed.attempts - 1), send_after: now + 3600, error: 'Kết nối Facebook đã hết hạn' });
      return 'expired';
    }
    if (err instanceof ComposioRateLimitError || err instanceof FbBudgetExceeded) {
      updateFbComment(row.id, { attempts: Math.max(0, claimed.attempts - 1), send_after: now + RATE_LIMIT_BACKOFF, error: 'Facebook giới hạn tần suất, sẽ thử lại' });
      return 'stop';
    }
    const message = describeError(err);
    if (claimed.attempts >= MAX_SEND_ATTEMPTS) {
      updateFbComment(row.id, { status: 'failed', error: message, send_after: null });
      return 'failed';
    }
    updateFbComment(row.id, { send_after: now + retryDelaySeconds(claimed.attempts), error: message });
    logger.warn({ commentId: row.id, attempt: claimed.attempts }, 'fbstudio comment send failed, will retry');
    return 'retry';
  }
}

/** Sends everything due. Stops early when Facebook is rate-limiting or the budget is spent. */
export async function sendDueComments(): Promise<number> {
  let sent = 0;
  for (const row of listFbDueComments(nowSec(), MAX_PER_TICK)) {
    const outcome = await sendComment(row.id);
    if (outcome === 'sent') sent++;
    if (outcome === 'stop') break;
  }
  return sent;
}
