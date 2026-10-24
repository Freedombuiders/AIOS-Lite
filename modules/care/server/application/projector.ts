/**
 * Customer Care Conversation Projector
 *
 * The projection itself (thread pointer, waiting SLA, remote unread) is derived causally from
 * the stored message set by `CareConversationStore.recomputeProjection` (see its header for the
 * exact rules), so arrival order can never change the outcome. This module holds the pure
 * per-message relevance decision that feeds it.
 */

import type { CareAccountRecord, NormalizedMessage } from '../../../_lib/care-kit/types.js';

/**
 * Does this message target THIS account? Only meaningful for group/topic conversations, where
 * casual banter must not start a waiting SLA. Exact account targeting only:
 *  - a mention whose uid equals the account's native ID (an @all/broadcast mention is not a
 *    target, and a mention of any other member is not either), or
 *  - a quote of a message authored by this account.
 * DMs and email threads do not depend on this flag (they are always relevant).
 */
export function isDirectedAtAccount(
  account: Pick<CareAccountRecord, 'nativeAccountId'>,
  msg: Pick<NormalizedMessage, 'metadata'>,
): boolean {
  const metadata = msg.metadata;
  if (metadata.type !== 'chat') return true;
  const self = account.nativeAccountId;
  const mentioned = (metadata.mentions ?? []).some((m) => !m.isAll && m.uid === self);
  const quotedSelf = metadata.quote?.senderId !== undefined && metadata.quote.senderId === self;
  return mentioned || quotedSelf;
}
