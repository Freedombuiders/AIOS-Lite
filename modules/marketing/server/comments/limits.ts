/**
 * Reply limits and send timing, as pure functions (everything time-dependent
 * takes `now` / `rand`). The processor feeds them counts read from SQLite.
 */

import type { ReplyRuleConfig } from '../types.js';

/** A comment still undecided or unsent after this long is too old to answer. */
export const STALE_COMMENT_SECONDS = 48 * 3600;
export const STALE_REASON = 'bình luận cũ';

export interface LimitUsage {
  /** Replies queued or sent for the Page in the last hour. */
  pageRepliesLastHour: number;
  /** Replies queued or sent to this author on this post. */
  authorRepliesOnPost: number;
  /** Someone replied to this author on this post within `onlyIfNotRepliedHours`. */
  authorRepliedRecently: boolean;
}

export type LimitVerdict =
  | { ok: true }
  /** Not now: leave the comment undecided and look again on a later tick. */
  | { ok: false; kind: 'defer'; reason: string }
  /** Never: store the comment as skipped. */
  | { ok: false; kind: 'skip'; reason: string };

export function checkReplyLimits(step: 'template' | 'agent', rules: ReplyRuleConfig, usage: LimitUsage): LimitVerdict {
  if (usage.authorRepliesOnPost >= rules.maxPerUserPerPost) {
    return { ok: false, kind: 'skip', reason: `Đã trả lời người này ${usage.authorRepliesOnPost} lần ở bài này (tối đa ${rules.maxPerUserPerPost})` };
  }
  if (step === 'agent' && rules.onlyIfNotRepliedHours != null && usage.authorRepliedRecently) {
    return { ok: false, kind: 'skip', reason: `Người này đã được trả lời trong ${rules.onlyIfNotRepliedHours} giờ qua` };
  }
  if (usage.pageRepliesLastHour >= rules.maxPerHour) {
    return { ok: false, kind: 'defer', reason: `Đủ ${rules.maxPerHour} trả lời trong giờ này` };
  }
  return { ok: true };
}

/**
 * When a queued reply goes out: a random delay in [delayMin, delayMax]
 * minutes, plus `delayBeforeSendMinutes` in 'delay' mode. null in 'draft'
 * mode (a human sends it from the log).
 */
export function computeSendAfter(rules: ReplyRuleConfig, nowSec: number, rand: () => number = Math.random): number | null {
  if (rules.sendMode === 'draft') return null;
  const lo = Math.min(rules.delayMinMinutes, rules.delayMaxMinutes);
  const hi = Math.max(rules.delayMinMinutes, rules.delayMaxMinutes);
  let minutes = lo + rand() * (hi - lo);
  if (rules.sendMode === 'delay') minutes += rules.delayBeforeSendMinutes;
  return nowSec + Math.round(minutes * 60);
}

export function isStale(createdTimeSec: number, nowSec: number): boolean {
  return nowSec - createdTimeSec > STALE_COMMENT_SECONDS;
}

/** Retry back-off after a transient send failure: 2, 5, then 15 minutes. */
export function retryDelaySeconds(attempt: number): number {
  const minutes = [2, 5, 15];
  return minutes[Math.min(Math.max(attempt, 1), minutes.length) - 1] * 60;
}

export const MAX_SEND_ATTEMPTS = 3;
