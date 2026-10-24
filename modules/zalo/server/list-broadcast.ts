/**
 * List (1-1) broadcast: send one template to existing 1-1 chats of chosen
 * nicks, dripped inside a daily window.
 *
 * Recipients are ONLY chats the nick already has (no phone import, no
 * strangers) and never opted-out customers. The worker runs inside the zalo
 * daemon, polls SQLite every minute and processes one small batch per active
 * campaign; the dashboard only writes rows (routes-list-broadcast.ts).
 *
 * Anti-ban: every send goes through ZaloSender.sendRich({ bulk: true }) one
 * recipient at a time with a random gap, per-step progress is persisted so a
 * retry never repeats a delivered step, and anything that looks like a nick
 * problem stops the nick for the batch instead of burning through recipients.
 */

import fs from 'fs';

import {
  addZaloListRecipients,
  closeDanglingZaloListBatches,
  countZaloListRecipients,
  countZaloListSent,
  findZaloListCandidates,
  finishZaloListBatch,
  getZaloAccount,
  getZaloListBroadcast,
  getZaloListThreadState,
  getZaloTemplate,
  listPendingZaloListRecipients,
  listZaloListBroadcasts,
  markZaloListRecipientsSynced,
  setZaloListBroadcastBatchOutcome,
  setZaloListBroadcastState,
  startZaloListBatch,
  updateZaloListRecipient,
  type ZaloListBroadcast,
  type ZaloListCandidate,
  type ZaloListFilter,
  type ZaloListRecipientRow,
} from './store.js';
import { logger } from './compat.js';
import { foldVietnamese } from './content.js';
import { classifyZaloError } from './limits.js';
import type { MarketingDeps, WorkerHandle } from './marketing-deps.js';
import { dayBounds, isWithinWindow, windowLengthMinutes, sendingDaysPerWeek, type WindowSpec } from './send-window.js';
import { buildTemplateVars, renderTemplate } from './template.js';

// ── Limits (also enforced by the routes) ────────────────────────────────

export const MAX_RECIPIENTS_PER_BROADCAST = 20_000;
export const MAX_NICKS_PER_BROADCAST = 10;
export const MAX_DAILY_QUOTA = 2000;
export const MIN_DELAY_FLOOR_SEC = 20;
export const MAX_DELAY_CAP_SEC = 900;
export const BATCH_SIZE = 25;
export const AUTO_PAUSE_AFTER_BATCHES = 3;
export const MAX_RECIPIENT_ATTEMPTS = 3;

const TICK_MS = 60_000;
const FIRST_TICK_MS = 5_000;
/** After a batch that sent nothing, wait before trying the campaign again. */
const EMPTY_BATCH_COOLDOWN_SEC = 300;
/** Between the text step and the attachment step of one recipient (ms). */
const STEP_GAP_MIN_MS = 800;
const STEP_GAP_MAX_MS = 2500;
/** Average wait between two sends to the same recipient, for ETA maths (s). */
const INTRA_RECIPIENT_SEC = 1.65;

/**
 * Errors that belong to the nick, not to the customer: stop using the nick for
 * this batch and keep the recipient pending for a later try.
 */
const NICK_LEVEL_CODES = new Set([
  'QUIET_HOURS', 'BULK_BUDGET', 'RATE_LIMITED', 'NOT_CONNECTED', 'CHAT_DISABLED', 'LOCKED',
]);

export function windowSpecOf(b: ZaloListBroadcast): WindowSpec {
  return {
    windowStart: b.windowStart,
    windowEnd: b.windowEnd,
    daysOfWeek: b.daysOfWeek,
    timezone: b.timezone,
    startDate: b.startDate,
    endDate: b.endDate,
  };
}

// ── Recipients ──────────────────────────────────────────────────────────

function nameMatcher(filter: ZaloListFilter): ((name: string) => boolean) | undefined {
  const needle = foldVietnamese((filter.nameContains ?? '').trim());
  return needle ? (name) => foldVietnamese(name).includes(needle) : undefined;
}

/** Chats a filter would select right now, capped at the per-campaign maximum. */
export function selectListCandidates(accountIds: string[], filter: ZaloListFilter, limit = MAX_RECIPIENTS_PER_BROADCAST): ZaloListCandidate[] {
  return findZaloListCandidates(accountIds, filter, { nameMatches: nameMatcher(filter), limit });
}

/**
 * Add the campaign's current candidates to its recipient list. Safe to repeat:
 * chats already in the campaign keep their state, so a running campaign can
 * pick up newly active customers without resending to anyone.
 */
export function syncListRecipients(broadcast: ZaloListBroadcast): { added: number; total: number; capped: boolean } {
  const room = Math.max(0, MAX_RECIPIENTS_PER_BROADCAST - countZaloListRecipients(broadcast.id).total);
  const candidates = selectListCandidates(broadcast.accountIds, broadcast.filter);
  const { added, capped } = addZaloListRecipients(broadcast.id, candidates, room);
  markZaloListRecipientsSynced(broadcast.id);
  return { added, total: countZaloListRecipients(broadcast.id).total, capped };
}

// ── Cost / ETA preview ──────────────────────────────────────────────────

export interface ListBroadcastEstimate {
  /** Send operations one recipient costs (text + attachments). */
  opsPerRecipient: number;
  /** Customers per day after the campaign and per-nick quotas. */
  effectiveDailyQuota: number;
  /** Sending days needed for `pending` recipients. */
  sendingDays: number;
  /** Calendar days, counting the weekdays the window is closed. */
  calendarDays: number;
  /** Seconds the daily quota takes at the chosen delays (one recipient at a time). */
  dailyDurationSec: number;
  windowMinutes: number;
  /** Customers per day the window fits at the chosen delays. */
  fitsPerDay: number;
  warnings: string[];
}

export function estimateListBroadcast(args: {
  pending: number;
  nickCount: number;
  dailyQuota: number;
  perNickDailyQuota: number;
  minDelaySec: number;
  maxDelaySec: number;
  hasText: boolean;
  attachmentCount: number;
  window: Pick<WindowSpec, 'windowStart' | 'windowEnd' | 'daysOfWeek'>;
  /**
   * Smallest daily marketing budget among the campaign's nicks (bulk share
   * of the warm-up-aware cap, in messages). The sender refuses bulk sends
   * past it, so a per-nick quota above it can never be reached.
   */
  minNickBulkBudget?: number;
}): ListBroadcastEstimate {
  const opsPerRecipient = Math.max(1, (args.hasText ? 1 : 0) + (args.attachmentCount > 0 ? 1 : 0));
  const nicks = Math.max(1, args.nickCount);
  const effectiveDailyQuota = Math.max(1, Math.min(args.dailyQuota, nicks * args.perNickDailyQuota));
  const sendingDays = Math.ceil(args.pending / effectiveDailyQuota);
  const perWeek = sendingDaysPerWeek(args.window);
  const calendarDays = sendingDays === 0 ? 0 : Math.ceil((sendingDays * 7) / perWeek);

  const avgGap = (args.minDelaySec + args.maxDelaySec) / 2;
  const perRecipientSec = avgGap + (opsPerRecipient - 1) * INTRA_RECIPIENT_SEC;
  const dailyDurationSec = Math.round(effectiveDailyQuota * perRecipientSec);
  const windowMinutes = windowLengthMinutes(args.window);
  const fitsPerDay = windowMinutes > 0 ? Math.floor((windowMinutes * 60) / perRecipientSec) : 0;

  const warnings: string[] = [];
  if (args.perNickDailyQuota * nicks < args.dailyQuota) {
    warnings.push(
      `Hạn mức mỗi nick (${args.perNickDailyQuota}) × ${nicks} nick chỉ đủ ${args.perNickDailyQuota * nicks} tin/ngày, thấp hơn hạn mức chiến dịch (${args.dailyQuota}).`,
    );
  }
  if (args.minNickBulkBudget !== undefined && args.perNickDailyQuota * opsPerRecipient > args.minNickBulkBudget) {
    warnings.push(
      `Mỗi nick chỉ được gửi marketing khoảng ${args.minNickBulkBudget} tin/ngày (phần dành cho marketing trong trần tin của nick, đã tính lịch nuôi nick), nên hạn mức ${args.perNickDailyQuota} khách/nick sẽ không đạt được.`,
    );
  }
  if (windowMinutes > 0 && dailyDurationSec > windowMinutes * 60) {
    warnings.push(
      `Khung giờ ${Math.round(windowMinutes / 6) / 10} giờ chỉ gửi được khoảng ${fitsPerDay} khách/ngày với giãn cách này, ít hơn hạn mức ${effectiveDailyQuota}. Phần dư tự dồn sang hôm sau — nới khung giờ, giảm giãn cách hoặc giảm hạn mức nếu muốn xong sớm hơn.`,
    );
  }
  if (sendingDays > 14) {
    warnings.push(`Cần khoảng ${sendingDays} ngày gửi để hết danh sách. Cân nhắc thêm nick hoặc chia nhỏ danh sách.`);
  }
  return { opsPerRecipient, effectiveDailyQuota, sendingDays, calendarDays, dailyDurationSec, windowMinutes, fitsPerDay, warnings };
}

// ── Worker ──────────────────────────────────────────────────────────────

export interface ListWorkerOptions {
  tickMs?: number;
  /** Test seam: replaces real waiting. */
  sleep?: (ms: number) => Promise<void>;
  rng?: () => number;
  now?: () => Date;
  isStopped?: () => boolean;
}

export interface ListBatchContext {
  sleep: (ms: number) => Promise<void>;
  rng: () => number;
  now: () => Date;
  isStopped: () => boolean;
}

export interface BatchSummary {
  batchId: number;
  sent: number;
  failed: number;
  skipped: number;
  stopReason: string;
}

function gapMs(b: ZaloListBroadcast, rng: () => number): number {
  const lo = Math.min(Math.max(b.minDelaySec, MIN_DELAY_FLOOR_SEC), MAX_DELAY_CAP_SEC);
  const hi = Math.min(Math.max(b.maxDelaySec, lo), MAX_DELAY_CAP_SEC);
  return (lo + rng() * (hi - lo)) * 1000;
}

/** Next pending recipients, interleaved across the campaign's nicks so no nick bursts. */
function pickBatchRecipients(b: ZaloListBroadcast, take: number): ZaloListRecipientRow[] {
  const queues = b.accountIds.map((id) => listPendingZaloListRecipients(b.id, id, take));
  const out: ZaloListRecipientRow[] = [];
  for (let i = 0; out.length < take; i++) {
    let any = false;
    for (const q of queues) {
      if (i < q.length && out.length < take) { out.push(q[i]); any = true; }
    }
    if (!any) break;
  }
  return out;
}

function pauseCampaign(deps: MarketingDeps, b: ZaloListBroadcast, reason: string, message: string): void {
  setZaloListBroadcastState(b.id, 'paused', reason);
  logger.warn({ broadcastId: b.id, reason }, 'list broadcast paused');
  void deps.notify(`Chiến dịch gửi 1-1 "${b.name}" đã tự tạm dừng: ${message}`).catch(() => {});
}

type DeliverOutcome =
  | { kind: 'sent' }
  | { kind: 'failed'; code: string }
  | { kind: 'nick_error'; code: string };

async function deliver(
  deps: MarketingDeps,
  ctx: ListBatchContext,
  b: ZaloListBroadcast,
  r: ZaloListRecipientRow,
  template: NonNullable<ReturnType<typeof getZaloTemplate>>,
  threadName: string,
  accountName: string,
): Promise<DeliverOutcome> {
  // Render per recipient so spintax varies between customers.
  const rendered = renderTemplate(
    { text: template.text, styles: template.styles },
    buildTemplateVars({ threadName, threadType: 'user', accountName, now: ctx.now() }),
    { rng: ctx.rng },
  );
  const text = rendered.text.trim() ? rendered : null;
  const attachments = template.attachments.map((a) => ({ path: a.path, kind: a.kind, name: a.name }));
  const steps: Array<'text' | 'attachments'> = [];
  if (text) steps.push('text');
  if (attachments.length > 0) steps.push('attachments');
  if (steps.length === 0) {
    updateZaloListRecipient(r.id, { state: 'failed', attempts: r.attempts + 1, error_code: 'EMPTY_MESSAGE' });
    return { kind: 'failed', code: 'EMPTY_MESSAGE' };
  }

  let done = r.sent_steps;
  try {
    for (let i = r.sent_steps; i < steps.length; i++) {
      if (i > r.sent_steps) await ctx.sleep(STEP_GAP_MIN_MS + ctx.rng() * (STEP_GAP_MAX_MS - STEP_GAP_MIN_MS));
      if (steps[i] === 'text') {
        await deps.sender.sendRich({
          threadId: r.thread_id, text: text!.text, styles: text!.styles, senderType: 'broadcast', bulk: true,
        });
      } else {
        await deps.sender.sendRich({
          threadId: r.thread_id, attachments, senderType: 'broadcast', bulk: true,
        });
      }
      done = i + 1;
      // Persist after every delivered step: a crash or retry must never resend it.
      updateZaloListRecipient(r.id, { sent_steps: done });
    }
  } catch (err) {
    const code = (err as { code?: string })?.code ?? '';
    if (NICK_LEVEL_CODES.has(code)) return { kind: 'nick_error', code };
    const errorCode = String(classifyZaloError(err));
    updateZaloListRecipient(r.id, { state: 'failed', attempts: r.attempts + 1, error_code: errorCode, sent_steps: done });
    logger.warn({ broadcastId: b.id, recipientId: r.id, errorCode, err: String((err as Error)?.message ?? err) }, 'list broadcast send failed');
    return { kind: 'failed', code: errorCode };
  }

  updateZaloListRecipient(r.id, {
    state: 'sent', attempts: r.attempts + 1, error_code: '', sent_steps: done, sent_at: Math.floor(ctx.now().getTime() / 1000),
  });
  return { kind: 'sent' };
}

/**
 * Process one batch (≤ BATCH_SIZE recipients) of an active campaign. Returns
 * null when the campaign had nothing to do right now (closed window, quota
 * reached, cooldown, nothing pending); otherwise the batch's summary.
 */
export async function runListBroadcastBatch(deps: MarketingDeps, broadcastId: number, ctx: ListBatchContext): Promise<BatchSummary | null> {
  const found = getZaloListBroadcast(broadcastId);
  if (!found || found.state !== 'active') return null;
  const b: ZaloListBroadcast = found;

  // Done once nothing is pending (failed recipients wait for an explicit retry).
  if (countZaloListRecipients(b.id).pending === 0) {
    setZaloListBroadcastState(b.id, 'completed');
    logger.info({ broadcastId: b.id }, 'list broadcast completed');
    return null;
  }

  const spec = windowSpecOf(b);
  const start = ctx.now();
  if (!isWithinWindow(start, spec)) return null;
  if (b.lastEmptyBatchAt && start.getTime() / 1000 - b.lastEmptyBatchAt < EMPTY_BATCH_COOLDOWN_SEC) return null;

  const day = dayBounds(b.timezone, start);
  const dayStartSec = Math.floor(day.startMs / 1000);
  const dayEndSec = Math.floor(day.endMs / 1000);
  const remaining = b.dailyQuota - countZaloListSent({ broadcastId: b.id }, dayStartSec, dayEndSec);
  if (remaining <= 0) return null;

  const template = getZaloTemplate(b.templateId);
  if (!template) {
    pauseCampaign(deps, b, 'TEMPLATE_MISSING', 'mẫu tin đã bị xoá.');
    return null;
  }
  if (!template.text.trim() && template.attachments.length === 0) {
    pauseCampaign(deps, b, 'TEMPLATE_EMPTY', 'mẫu tin không có nội dung.');
    return null;
  }
  const missingFile = template.attachments.find((a) => !fs.existsSync(a.path));
  if (missingFile) {
    pauseCampaign(deps, b, 'ATTACHMENT_MISSING', `không tìm thấy tệp đính kèm "${missingFile.name ?? missingFile.path}".`);
    return null;
  }

  const recipients = pickBatchRecipients(b, Math.min(BATCH_SIZE, remaining));
  if (recipients.length === 0) return null;

  const batchId = startZaloListBatch(b.id);
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let stopReason = '';
  let attempted = 0;
  const blocked = new Set<string>();

  for (const r of recipients) {
    if (ctx.isStopped()) { stopReason = 'STOPPED'; break; }
    // Operator pause/cancel takes effect between recipients.
    const live = getZaloListBroadcast(b.id);
    if (!live || live.state !== 'active') { stopReason = 'NOT_ACTIVE'; break; }
    if (!isWithinWindow(ctx.now(), spec)) { stopReason = 'OUT_OF_WINDOW'; break; }
    if (blocked.has(r.account_id)) continue;

    const thread = getZaloListThreadState(r.thread_id);
    if (!thread || !thread.isUser) {
      updateZaloListRecipient(r.id, { state: 'skipped', error_code: 'THREAD_GONE' });
      skipped++;
      continue;
    }
    // Opted out after the recipient list was built: never message them.
    if (thread.optedOut) {
      updateZaloListRecipient(r.id, { state: 'skipped', error_code: 'OPTED_OUT' });
      skipped++;
      continue;
    }

    const today = dayBounds(b.timezone, ctx.now());
    const todayStartSec = Math.floor(today.startMs / 1000);
    const todayEndSec = Math.floor(today.endMs / 1000);
    if (countZaloListSent({ broadcastId: b.id }, todayStartSec, todayEndSec) >= b.dailyQuota) {
      stopReason = 'DAILY_QUOTA';
      break;
    }
    // Nick quota counts every list campaign: a nick is shared, so per-campaign
    // counting would let two campaigns together exceed what one may send.
    if (countZaloListSent({ accountId: r.account_id }, todayStartSec, todayEndSec) >= b.perNickDailyQuota) {
      blocked.add(r.account_id);
      continue;
    }
    if (!deps.pool.getApi(r.account_id)) { blocked.add(r.account_id); continue; }
    if (deps.sender.bulkBudgetRemaining(r.account_id) <= 0) { blocked.add(r.account_id); continue; }

    // Random gap between customers (not before the first send of the batch).
    if (attempted > 0) {
      await ctx.sleep(gapMs(b, ctx.rng));
      if (ctx.isStopped()) { stopReason = 'STOPPED'; break; }
      if (!isWithinWindow(ctx.now(), spec)) { stopReason = 'OUT_OF_WINDOW'; break; }
      const cur = getZaloListBroadcast(b.id);
      if (!cur || cur.state !== 'active') { stopReason = 'NOT_ACTIVE'; break; }
    }
    attempted++;

    const account = getZaloAccount(r.account_id);
    const outcome = await deliver(
      deps, ctx, b, r, template, thread.name || r.name_snapshot,
      account?.display_name || account?.label || '',
    );
    if (outcome.kind === 'sent') sent++;
    else if (outcome.kind === 'failed') failed++;
    else {
      blocked.add(r.account_id);
      stopReason = stopReason || `NICK_${outcome.code}`;
      logger.warn({ broadcastId: b.id, accountId: r.account_id, code: outcome.code }, 'list broadcast: nick stopped for this batch');
    }
  }

  if (!stopReason && blocked.size > 0) stopReason = 'NICK_BLOCKED';
  finishZaloListBatch(batchId, { sent, failed, skipped, stopReason });

  // Safety counters. A batch that only skipped opted-out chats made progress;
  // one that sent nothing and skipped nothing waits out a cooldown.
  const fresh = getZaloListBroadcast(b.id) ?? b;
  let consecutive = fresh.consecutiveFailedBatches;
  if (sent > 0) consecutive = 0;
  else if (failed > 0) consecutive += 1;
  setZaloListBroadcastBatchOutcome(b.id, {
    consecutiveFailedBatches: consecutive,
    lastEmptyBatchAt: sent === 0 && skipped === 0 ? Math.floor(ctx.now().getTime() / 1000) : null,
  });
  logger.info({ broadcastId: b.id, batchId, sent, failed, skipped, stopReason }, 'list broadcast batch finished');

  if (consecutive >= AUTO_PAUSE_AFTER_BATCHES && fresh.state === 'active') {
    pauseCampaign(deps, fresh, 'CONSECUTIVE_FAILURES', `${consecutive} lượt gửi liên tiếp không gửi được tin nào. Kiểm tra nick Zalo rồi bấm "Tiếp tục".`);
  } else if (fresh.state === 'active' && countZaloListRecipients(b.id).pending === 0) {
    setZaloListBroadcastState(b.id, 'completed');
  }
  return { batchId, sent, failed, skipped, stopReason };
}

/** One scheduler pass: start a batch for every active campaign that isn't already running one. */
export async function tickListBroadcasts(deps: MarketingDeps, ctx: ListBatchContext, running: Set<number>): Promise<Array<Promise<unknown>>> {
  const started: Array<Promise<unknown>> = [];
  for (const b of listZaloListBroadcasts('active')) {
    if (running.has(b.id)) continue;
    running.add(b.id);
    started.push(
      runListBroadcastBatch(deps, b.id, ctx)
        .catch((err) => logger.error({ err: String(err), broadcastId: b.id }, 'list broadcast batch crashed'))
        .finally(() => running.delete(b.id)),
    );
  }
  return started;
}

export function startListBroadcastWorker(deps: MarketingDeps, opts: ListWorkerOptions = {}): WorkerHandle {
  let stopped = false;
  const running = new Set<number>();
  // A previous daemon may have died mid-batch; close its dangling rows.
  try { closeDanglingZaloListBatches(); } catch (err) { logger.warn({ err: String(err) }, 'list broadcast: closing stale batches failed'); }

  const ctx: ListBatchContext = {
    sleep: opts.sleep ?? ((ms) => new Promise((resolve) => {
      // Re-check the stop flag every few seconds so shutdown isn't held up by a 90 s gap.
      let left = ms;
      const step = () => {
        if (stopped || left <= 0) return resolve();
        const slice = Math.min(left, 3_000);
        left -= slice;
        setTimeout(step, slice).unref();
      };
      step();
    })),
    rng: opts.rng ?? Math.random,
    now: opts.now ?? (() => new Date()),
    isStopped: opts.isStopped ?? (() => stopped),
  };

  const tick = () => {
    if (stopped) return;
    void tickListBroadcasts(deps, ctx, running).catch((err) => logger.error({ err: String(err) }, 'list broadcast tick failed'));
  };
  const first = setTimeout(tick, FIRST_TICK_MS);
  first.unref();
  const timer = setInterval(tick, opts.tickMs ?? TICK_MS);
  timer.unref();

  return {
    stop() {
      stopped = true;
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}
