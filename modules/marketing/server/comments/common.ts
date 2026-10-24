/**
 * Small helpers shared by the poller, processor, sender and routes.
 */

import { setFbCommentPageStatus, type FbCommentPageRow } from '../store.js';
import { graphAsPage, type FbCallTarget } from '../../../_lib/composio.js';
import { notifyOwner } from '../notify.js';

export function targetFor(page: FbCommentPageRow): FbCallTarget {
  return { area: 'comments', connectionId: page.connection_id, entityId: page.entity_id };
}

/** Hides or unhides a comment on the Page's behalf. */
export async function setCommentHidden(page: FbCommentPageRow, commentId: string, hidden: boolean): Promise<void> {
  await graphAsPage(page.id, { method: 'POST', path: `/${commentId}`, body: { is_hidden: hidden } }, targetFor(page));
}

/** Marks the Page's connection expired and tells the owner once (only the call that flips the status notifies). */
export async function handleExpired(page: FbCommentPageRow): Promise<void> {
  if (setFbCommentPageStatus(page.id, 'EXPIRED')) {
    await notifyOwner(`Kết nối Facebook của Page "${page.name}" đã hết hạn. Hãy kết nối lại trong Composio để tiếp tục trả lời bình luận.`);
  }
}

/** One-line error text safe to store and show (no stack, bounded length). */
export function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, ' ').slice(0, 300);
}
