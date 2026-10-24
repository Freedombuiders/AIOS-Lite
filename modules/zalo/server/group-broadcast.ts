/**
 * Scheduled group broadcast worker (runs inside the zalo daemon).
 *
 * Ported from ZaloCRM's group-broadcast-{cron,worker}.ts with BullMQ/Redis
 * replaced by SQLite polling:
 *   - every 60 s the scheduler turns due times into `pending` runs (the unique
 *     key on (broadcast, scheduled_for, trigger) makes that idempotent);
 *   - runs are processed one at a time per daemon, one group at a time with a
 *     random gap, every send going through ZaloSender.sendRich(bulk: true);
 *   - a sweeper cleans runs that were never picked up or got stuck.
 *
 * Anti-ban invariants (see docs/zalo-customer-care.md): one group at a time,
 * random gap with a floor, per-step progress persisted so a retry never
 * resends a delivered step, and any "stop the run" error leaves the remaining
 * groups pending instead of failing them.
 */

import {
  claimNextZaloBroadcastRun,
  countZaloBroadcastTargets,
  failInterruptedZaloBroadcastRuns,
  finishZaloBroadcastRun,
  getZaloAccount,
  getZaloBroadcast,
  getZaloThread,
  getZaloTemplate,
  hasOtherRunningZaloBroadcastRun,
  hasZaloBroadcastRunStartedSince,
  insertZaloBroadcastRun,
  listScheduledActiveZaloBroadcasts,
  listZaloBroadcastTargets,
  setZaloBroadcastFailureCount,
  setZaloBroadcastNextRun,
  setZaloBroadcastState,
  sweepZaloBroadcastRuns,
  updateZaloBroadcastTarget,
  type ZaloBroadcastRow,
  type ZaloBroadcastRunRow,
  type ZaloBroadcastRunState,
  type ZaloBroadcastTargetRow,
  type ZaloBroadcastTrigger,
} from './store.js';
import { logger } from './compat.js';
import { MAX_DELAY_CAP_SEC, MIN_DELAY_FLOOR_SEC } from './broadcast-cost.js';
import { classifyZaloError, isQuietHours } from './limits.js';
import type { MarketingDeps, WorkerHandle } from './marketing-deps.js';
import type { ZaloAttachment } from './media.js';
import { nextRunAt, occurrencesBetween, type ScheduleSpec } from './schedule.js';
import { buildTemplateVars, renderTemplate } from './template.js';

const TICK_MS = 60_000;
/** Pending runs are polled faster than the scheduler so "Gửi ngay" starts within seconds. */
const DRAIN_POLL_MS = 10_000;
const SWEEP_MS = 5 * 60_000;

/** Times that fell due this long ago are still sent after a restart; older ones are dropped. */
export const CATCH_UP_MS = 10 * 60_000;
/** A flood of runs in one tick is worse than a late run. */
export const MAX_RUNS_PER_TICK = 20;
export const AUTO_PAUSE_AFTER_FAILED_RUNS = 3;
/** A run nobody picked up this long ago is stale: sending it now would be a surprise. */
export const PENDING_TIMEOUT_SEC = 30 * 60;
export const RUNNING_TIMEOUT_SEC = 2 * 60 * 60;
const STEP_PAUSE_MIN_MS = 800;
const STEP_PAUSE_MAX_MS = 2500;

/** ZaloSendError codes that stop the whole run and leave the rest pending. */
const STOP_CODES = new Set(['QUIET_HOURS', 'BULK_BUDGET', 'RATE_LIMITED', 'NOT_CONNECTED', 'CHAT_DISABLED', 'LOCKED']);
const STOP_REASON: Record<string, string> = {
  QUIET_HOURS: 'QUIET_HOURS',
  BULK_BUDGET: 'BULK_BUDGET',
  RATE_LIMITED: 'RATE_LIMITED',
  NOT_CONNECTED: 'NICK_OFFLINE',
  CHAT_DISABLED: 'NICK_CHAT_DISABLED',
  LOCKED: 'LOCKED',
};

export interface GroupBroadcastWorkerOptions {
  now?: () => Date;
  rng?: () => number;
  /** Resolves after `ms`; tests pass an instant one. stop() releases a pending real sleep. */
  sleep?: (ms: number) => Promise<void>;
  isQuietHours?: () => boolean;
}

export interface GroupBroadcastEngine {
  /** Create runs for times that fell due; returns how many were created. */
  scheduleTick(now?: Date): number;
  /** Process pending runs one by one until none is left. */
  drain(): Promise<void>;
  sweep(now?: Date): { stale: number; stuck: number };
  stop(): void;
}

export function scheduleSpecOf(b: ZaloBroadcastRow): ScheduleSpec {
  return {
    scheduleKind: b.schedule_kind,
    timesOfDay: b.times_of_day,
    daysOfWeek: b.days_of_week,
    daysOfMonth: b.days_of_month,
    timezone: b.timezone,
    startDate: b.start_date,
    endDate: b.end_date,
  };
}

/**
 * Insert a run with one pending target per group. Returns null when a run for
 * the same (broadcast, scheduled_for, trigger) already exists.
 */
export function materializeBroadcastRun(
  broadcast: Pick<ZaloBroadcastRow, 'id' | 'target_thread_ids'>,
  scheduledForSec: number,
  triggeredBy: ZaloBroadcastTrigger,
  targets?: Array<{ threadId: number; attempts?: number; sentSteps?: string[]; messageIds?: number[] }>,
): ZaloBroadcastRunRow | null {
  return insertZaloBroadcastRun({
    broadcastId: broadcast.id,
    scheduledFor: scheduledForSec,
    triggeredBy,
    targets: targets ?? broadcast.target_thread_ids.map((threadId) => ({ threadId })),
  });
}

/** Estimated seconds one run takes: only the gaps between groups matter for overlap checks. */
export function estimatedRunSeconds(b: Pick<ZaloBroadcastRow, 'min_delay_sec' | 'max_delay_sec' | 'target_thread_ids'>): number {
  return Math.max(0, b.target_thread_ids.length - 1) * ((b.min_delay_sec + b.max_delay_sec) / 2);
}

/** One message to send to a group: a text, the image album, or a single file/video. */
interface SendStep {
  key: string;
  text?: string;
  styles?: ReturnType<typeof renderTemplate>['styles'];
  attachments?: ZaloAttachment[];
}

function buildSteps(
  rendered: { text: string; styles: SendStep['styles'] },
  attachments: Array<ZaloAttachment & { mediaId: number }>,
): SendStep[] {
  const steps: SendStep[] = [];
  if (rendered.text.trim()) steps.push({ key: 'text', text: rendered.text, styles: rendered.styles });
  const images = attachments.filter((a) => a.kind === 'image');
  if (images.length > 0) steps.push({ key: 'album', attachments: images });
  for (const a of attachments.filter((x) => x.kind !== 'image')) {
    steps.push({ key: `file:${a.mediaId}`, attachments: [a] });
  }
  return steps;
}

export function createGroupBroadcastEngine(deps: MarketingDeps, opts: GroupBroadcastWorkerOptions = {}): GroupBroadcastEngine {
  const now = opts.now ?? (() => new Date());
  const rng = opts.rng ?? Math.random;
  const quiet = opts.isQuietHours ?? (() => isQuietHours(now()));
  let stopped = false;
  let drainPromise: Promise<void> | null = null;
  const sleepers = new Set<() => void>();

  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    const done = () => { clearTimeout(timer); sleepers.delete(done); resolve(); };
    const timer = setTimeout(done, ms);
    sleepers.add(done);
  }));

  function groupGapMs(b: ZaloBroadcastRow): number {
    const lo = Math.min(Math.max(b.min_delay_sec, MIN_DELAY_FLOOR_SEC), MAX_DELAY_CAP_SEC);
    const hi = Math.min(Math.max(b.max_delay_sec, lo), MAX_DELAY_CAP_SEC);
    return (lo + rng() * (hi - lo)) * 1000;
  }

  const stepPauseMs = () => STEP_PAUSE_MIN_MS + rng() * (STEP_PAUSE_MAX_MS - STEP_PAUSE_MIN_MS);

  /** Whether the campaign state lets this kind of run proceed. */
  function stateAllowsRun(b: ZaloBroadcastRow, trigger: ZaloBroadcastTrigger): boolean {
    // A scheduled run created for the final occurrence may be picked up after
    // the scheduler already closed the campaign ('completed'), so allow that.
    if (trigger === 'schedule') return b.state === 'active' || b.state === 'completed';
    // Manual/retry is a deliberate operator action: fine on drafts and paused campaigns.
    return b.state !== 'cancelled';
  }

  /** Why the run must not start, or null. Re-evaluated before every group via `checkNickReady`. */
  function resolveSkipReason(run: ZaloBroadcastRunRow, b: ZaloBroadcastRow): string | null {
    if (!stateAllowsRun(b, run.triggered_by)) return 'BROADCAST_INACTIVE';
    const account = getZaloAccount(b.account_id);
    if (!account) return 'NICK_MISSING';
    if (!account.chat_enabled) return 'NICK_CHAT_DISABLED';

    // Overlap guards: two runs close together would hit the same groups twice
    // in a short time. Dropping the newer run is safer than queueing it.
    if (hasOtherRunningZaloBroadcastRun(b.id, run.id)) return 'PREVIOUS_RUN_ACTIVE';
    if (run.triggered_by === 'schedule') {
      const since = run.scheduled_for - estimatedRunSeconds(b);
      if (hasZaloBroadcastRunStartedSince(b.id, run.id, since)) return 'RECENT_RUN';
    }
    return checkNickReady(b);
  }

  /** Nick-level readiness; checked before the run and again before each group. */
  function checkNickReady(b: ZaloBroadcastRow): string | null {
    const account = getZaloAccount(b.account_id);
    if (!account) return 'NICK_MISSING';
    if (!account.chat_enabled) return 'NICK_CHAT_DISABLED';
    if (quiet()) return 'QUIET_HOURS';
    if (!deps.pool.getApi(b.account_id)) return 'NICK_OFFLINE';
    if (deps.sender.bulkBudgetRemaining(b.account_id) <= 0) return 'BULK_BUDGET';
    return null;
  }

  function notifyOperator(text: string): void {
    void deps.notify(text).catch(() => {});
  }

  /** Update the campaign after a run that attempted sends (skips never reach here). */
  function afterRun(b: ZaloBroadcastRow, sent: number, failed: number): void {
    const fresh = getZaloBroadcast(b.id);
    if (!fresh) return;

    if (sent > 0) {
      if (fresh.consecutive_failed_runs !== 0) setZaloBroadcastFailureCount(fresh.id, 0);
    } else if (failed > 0) {
      const count = fresh.consecutive_failed_runs + 1;
      if (count >= AUTO_PAUSE_AFTER_FAILED_RUNS && fresh.state === 'active') {
        setZaloBroadcastState(fresh.id, 'paused', { pausedReason: 'CONSECUTIVE_FAILURES', nextRunAt: null, consecutiveFailedRuns: count });
        logger.warn({ broadcastId: fresh.id, count }, 'zalo group broadcast auto-paused after consecutive failed runs');
        notifyOperator(
          `Lịch gửi nhóm "${fresh.name}" đã tự tạm dừng: ${count} lượt liên tiếp không gửi được tin nào. ` +
          'Hãy kiểm tra nick Zalo và các nhóm đích, rồi bấm Tiếp tục ở Marketing › Gửi nhóm theo lịch.',
        );
        return;
      }
      setZaloBroadcastFailureCount(fresh.id, count);
    }
    finishCampaignBookkeeping(fresh);
  }

  /** A one-shot ('now') campaign is done after its run; a scheduled one gets its next time. */
  function finishCampaignBookkeeping(b: ZaloBroadcastRow): void {
    if (b.state !== 'active') return;
    if (b.schedule_kind === 'now') {
      setZaloBroadcastState(b.id, 'completed', { nextRunAt: null });
      return;
    }
    const next = nextRunAt(scheduleSpecOf(b), now());
    setZaloBroadcastNextRun(b.id, next ? Math.floor(next.getTime() / 1000) : null);
  }

  /** Send every unsent step of one group; returns the stop reason when the run must stop. */
  async function sendToTarget(
    b: ZaloBroadcastRow,
    target: ZaloBroadcastTargetRow,
    accountName: string,
    template: { text: string; styles: SendStep['styles']; attachments: Array<ZaloAttachment & { mediaId: number }> },
  ): Promise<{ stop: string | null; attempted: boolean }> {
    const thread = getZaloThread(target.thread_id);
    if (!thread || thread.thread_type !== 'group' || thread.account_id !== b.account_id) {
      updateZaloBroadcastTarget(target.id, { state: 'skipped', errorCode: 'GROUP_REMOVED', errorMessage: 'Nhóm không còn thuộc nick này' });
      return { stop: null, attempted: false };
    }

    // Render per group so spintax varies between groups.
    const rendered = renderTemplate(
      { text: template.text, styles: template.styles ?? [] },
      buildTemplateVars({ threadName: thread.name, threadType: 'group', accountName, now: now() }),
      { rng },
    );
    const steps = buildSteps(rendered, template.attachments);
    if (steps.length === 0) {
      updateZaloBroadcastTarget(target.id, { state: 'skipped', errorCode: 'EMPTY_MESSAGE', errorMessage: 'Tin trống sau khi áp biến' });
      return { stop: null, attempted: false };
    }

    let sentSteps = [...target.sent_steps];
    let messageIds = [...target.message_ids];
    let sentSomething = false;

    for (const step of steps) {
      if (sentSteps.includes(step.key)) continue;
      if (sentSomething) await sleep(stepPauseMs());
      try {
        const res = await deps.sender.sendRich({
          threadId: thread.id,
          text: step.text,
          styles: step.styles,
          attachments: step.attachments,
          senderType: 'broadcast',
          bulk: true,
        });
        sentSteps = [...sentSteps, step.key];
        messageIds = [...messageIds, ...res.messageIds];
        sentSomething = true;
        // Persist after every step: a crash or a later failure must never cause this step to be resent.
        updateZaloBroadcastTarget(target.id, { sentSteps, messageIds });
      } catch (err) {
        const code = (err as { code?: unknown })?.code;
        if (typeof code === 'string' && STOP_CODES.has(code)) {
          // The nick, not the group, is the problem: keep the target pending for a later retry.
          return { stop: STOP_REASON[code] ?? code, attempted: sentSomething };
        }
        updateZaloBroadcastTarget(target.id, {
          state: 'failed',
          attempts: target.attempts + 1,
          errorCode: String(classifyZaloError(err)),
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        logger.warn({ broadcastId: b.id, threadId: thread.id, err: String(err) }, 'zalo group broadcast send failed');
        return { stop: null, attempted: true };
      }
    }

    updateZaloBroadcastTarget(target.id, {
      state: 'sent',
      attempts: target.attempts + 1,
      errorCode: '',
      errorMessage: '',
      sentAt: Math.floor(now().getTime() / 1000),
    });
    return { stop: null, attempted: sentSomething };
  }

  async function processRun(run: ZaloBroadcastRunRow): Promise<void> {
    const b = getZaloBroadcast(run.broadcast_id);
    if (!b) {
      finishZaloBroadcastRun(run.id, { state: 'skipped', skipReason: 'BROADCAST_MISSING' });
      return;
    }

    const skip = resolveSkipReason(run, b);
    if (skip) {
      finishZaloBroadcastRun(run.id, { state: 'skipped', skipReason: skip, counts: countZaloBroadcastTargets(run.id) });
      logger.info({ runId: run.id, broadcastId: b.id, skip }, 'zalo group broadcast run skipped');
      // An inactive campaign is the operator's choice, anything else still ends a one-shot campaign.
      if (skip !== 'BROADCAST_INACTIVE') finishCampaignBookkeeping(b);
      return;
    }

    const template = getZaloTemplate(b.template_id);
    if (!template || (!template.text.trim() && template.attachments.length === 0)) {
      finishZaloBroadcastRun(run.id, { state: 'failed', skipReason: template ? 'TEMPLATE_EMPTY' : 'TEMPLATE_MISSING' });
      return;
    }

    const account = getZaloAccount(b.account_id)!;
    const accountName = account.display_name || account.label;
    const tpl = { text: template.text, styles: template.styles, attachments: template.attachments };

    let abort: string | null = null;
    let needGap = false;
    for (const target of listZaloBroadcastTargets(run.id, { state: 'pending' })) {
      if (stopped) { abort = 'WORKER_STOPPED'; break; }
      if (needGap) {
        await sleep(groupGapMs(b));
        if (stopped) { abort = 'WORKER_STOPPED'; break; }
      }

      // The nick or the campaign may change while a long run is in flight.
      const live = getZaloBroadcast(b.id);
      if (!live || !stateAllowsRun(live, run.triggered_by)) { abort = 'BROADCAST_INACTIVE'; break; }
      const notReady = checkNickReady(b);
      if (notReady) { abort = notReady; break; }

      const result = await sendToTarget(b, target, accountName, tpl);
      if (result.stop) { abort = result.stop; break; }
      needGap = result.attempted;
    }

    const counts = countZaloBroadcastTargets(run.id);
    let state: ZaloBroadcastRunState;
    if (counts.sent === 0 && counts.failed === 0) state = 'skipped';
    else if (counts.failed === 0 && counts.pending === 0) state = 'completed';
    else state = counts.sent > 0 ? 'partial' : 'failed';
    finishZaloBroadcastRun(run.id, { state, skipReason: abort ?? (state === 'skipped' ? 'NO_TARGETS' : ''), counts });
    logger.info({ runId: run.id, broadcastId: b.id, state, ...counts, abort }, 'zalo group broadcast run finished');

    // Only runs that actually tried to send move the failure counter; a run that
    // stopped before sending anything (quiet hours, nick offline) does not.
    if (counts.sent > 0 || counts.failed > 0) afterRun(b, counts.sent, counts.failed);
    else finishCampaignBookkeeping(b);
  }

  return {
    scheduleTick(at: Date = now()): number {
      let created = 0;
      const broadcasts = listScheduledActiveZaloBroadcasts();
      for (const [index, b] of broadcasts.entries()) {
        if (created >= MAX_RUNS_PER_TICK) {
          // The cap drops the remaining campaigns for this tick; say so instead of failing silently.
          logger.warn({ cap: MAX_RUNS_PER_TICK, skipped: broadcasts.length - index }, 'zalo group broadcast tick hit run cap');
          break;
        }
        const spec = scheduleSpecOf(b);
        // Never catch up times from before the campaign was (re)activated.
        const since = Math.max(at.getTime() - CATCH_UP_MS, (b.activated_at ?? 0) * 1000);
        for (const due of occurrencesBetween(spec, new Date(since), at)) {
          if (created >= MAX_RUNS_PER_TICK) break;
          if (materializeBroadcastRun(b, Math.floor(due.getTime() / 1000), 'schedule')) created++;
        }

        const next = nextRunAt(spec, at);
        if (!next) {
          setZaloBroadcastState(b.id, 'completed', { nextRunAt: null });
        } else if (Math.floor(next.getTime() / 1000) !== b.next_run_at) {
          setZaloBroadcastNextRun(b.id, Math.floor(next.getTime() / 1000));
        }
      }
      return created;
    },

    drain(): Promise<void> {
      if (drainPromise) return drainPromise;
      const work = (async () => {
        let run: ZaloBroadcastRunRow | null;
        while (!stopped && (run = claimNextZaloBroadcastRun())) {
          try {
            await processRun(run);
          } catch (err) {
            logger.error({ runId: run.id, err: String(err) }, 'zalo group broadcast run crashed');
            finishZaloBroadcastRun(run.id, { state: 'failed', skipReason: 'ERROR', counts: countZaloBroadcastTargets(run.id) });
          }
        }
      })();
      // Clear the guard asynchronously. With nothing to claim the body never
      // awaits, so a `finally` inside it would run before this assignment and
      // leave a settled promise in the guard — every later drain would then
      // return it without looking for new runs.
      drainPromise = work.finally(() => { drainPromise = null; });
      return drainPromise;
    },

    sweep(at: Date = now()) {
      const res = sweepZaloBroadcastRuns(Math.floor(at.getTime() / 1000), {
        pendingMaxAgeSec: PENDING_TIMEOUT_SEC,
        runningMaxAgeSec: RUNNING_TIMEOUT_SEC,
      });
      if (res.stale > 0 || res.stuck > 0) logger.warn(res, 'zalo group broadcast sweeper closed runs');
      return res;
    },

    stop() {
      stopped = true;
      for (const wake of [...sleepers]) wake();
    },
  };
}

export function startGroupBroadcastWorker(deps: MarketingDeps, opts: GroupBroadcastWorkerOptions = {}): WorkerHandle {
  const engine = createGroupBroadcastEngine(deps, opts);

  // Concurrency is 1, so a run still 'running' belongs to a daemon that died.
  const interrupted = failInterruptedZaloBroadcastRuns();
  if (interrupted > 0) logger.warn({ interrupted }, 'zalo group broadcast closed runs interrupted by a restart');

  const guarded = (what: string, fn: () => void) => () => {
    try { fn(); } catch (err) { logger.error({ err: String(err) }, `zalo group broadcast ${what} failed`); }
  };
  const drain = () => { void engine.drain().catch((err) => logger.error({ err: String(err) }, 'zalo group broadcast drain failed')); };
  const tick = guarded('tick', () => { engine.scheduleTick(); drain(); });

  const timers = [
    setInterval(tick, TICK_MS),
    setInterval(drain, DRAIN_POLL_MS),
    setInterval(guarded('sweep', () => { engine.sweep(); }), SWEEP_MS),
  ];
  for (const t of timers) t.unref();
  tick();

  return {
    stop() {
      for (const t of timers) clearInterval(t);
      engine.stop();
    },
  };
}
