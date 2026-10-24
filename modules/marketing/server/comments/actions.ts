/**
 * Manual actions on one comment from the log: retry, hide, unhide, send a draft.
 */

import { getFbComment, getFbCommentForLog, getFbCommentPage, updateFbComment, type FbCommentLogRow } from '../store.js';
import { setCommentHidden } from './common.js';
import { sendComment } from './sender.js';

const nowSec = (): number => Math.floor(Date.now() / 1000);

export class ActionError extends Error {
  constructor(public readonly status: 404 | 409, message: string) {
    super(message);
    this.name = 'ActionError';
  }
}

function load(id: string) {
  const row = getFbComment(id);
  if (!row || row.from_page) throw new ActionError(404, 'Không tìm thấy bình luận');
  const page = getFbCommentPage(row.page_id);
  if (!page) throw new ActionError(404, 'Không tìm thấy Page của bình luận');
  return { row, page };
}

function result(id: string): FbCommentLogRow {
  const row = getFbCommentForLog(id);
  if (!row) throw new ActionError(404, 'Không tìm thấy bình luận');
  return row;
}

/**
 * Retry a failed (or re-evaluate a skipped/human) comment. A failed hide is
 * redone now; a failed reply goes back to the queue and is sent now; anything
 * else returns to `new` so the worker decides again.
 */
export async function retryComment(id: string): Promise<FbCommentLogRow> {
  const { row, page } = load(id);
  if (!['failed', 'skipped', 'human'].includes(row.status)) {
    throw new ActionError(409, 'Chỉ thử lại được bình luận lỗi, bị bỏ qua hoặc chuyển người');
  }
  const now = nowSec();
  if (row.status === 'failed' && row.step === 'spam') {
    await setCommentHidden(page, row.id, true);
    updateFbComment(id, { status: 'hidden', error: '', decided_at: now });
  } else if (row.status === 'failed' && (row.reply_text || row.private_text || row.action === 'react')) {
    updateFbComment(id, { status: 'queued', attempts: 0, error: '', send_after: now });
    await sendComment(id, { force: true });
  } else {
    updateFbComment(id, {
      status: 'new', step: '', rule_ref: '', reason: '', reply_text: '', private_text: '', action: '', topic: '',
      error: '', attempts: 0, send_after: null, decided_at: null,
    });
  }
  return result(id);
}

export async function hideManually(id: string): Promise<FbCommentLogRow> {
  const { row, page } = load(id);
  if (row.status === 'hidden') return result(id);
  await setCommentHidden(page, row.id, true);
  updateFbComment(id, {
    status: 'hidden', send_after: null, error: '',
    ...(row.reason ? {} : { reason: 'Ẩn thủ công' }),
  });
  return result(id);
}

export async function unhideManually(id: string): Promise<FbCommentLogRow> {
  const { row, page } = load(id);
  if (row.status !== 'hidden') throw new ActionError(409, 'Bình luận này không bị ẩn');
  await setCommentHidden(page, row.id, false);
  updateFbComment(id, { status: 'skipped', step: 'skip', rule_ref: '', reason: 'Đã bỏ ẩn thủ công', error: '' });
  return result(id);
}

/** Sends a `draft` reply now. */
export async function sendDraftNow(id: string): Promise<FbCommentLogRow> {
  const { row } = load(id);
  if (row.status !== 'draft') throw new ActionError(409, 'Chỉ gửi được trả lời đang ở trạng thái nháp');
  updateFbComment(id, { status: 'queued', attempts: 0, send_after: nowSec(), error: '' });
  await sendComment(id, { force: true });
  return result(id);
}
