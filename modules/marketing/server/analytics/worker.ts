/**
 * Analytics worker: per enabled Page, every 5 minutes —
 *   1. capture post milestones that are due (1h … 28d, skipped when over 2× late);
 *   2. the daily sweep from 02:00 Page-local: import new posts, Page daily
 *      numbers, a 'latest' snapshot of every post ≤ 28 days (the first run
 *      imports 90 days and snapshots them all);
 *   3. the Analyst from 07:00 Page-local, once per Page per day.
 *
 * Calls per Page per day (Composio, ~3 posts a day): sweep = 1 Page insights
 * + 1 post list + 1 insight read per post ≤ 28 days (~85); milestones = 6
 * insight reads per new post (~18) + 1 post list per tick that has something
 * due (≤ 18). Total ≈ 105–125. The first run adds ~1 read per post of the
 * last 90 days once. The Analyst adds no Facebook calls.
 */

import { getFbSetting, listFbAnalyticsPages, setFbAnalyticsPageStatus, setFbSetting, type FbAnalyticsPageRow } from '../store.js';
import { logger } from '../compat.js';
import {
  ComposioAuthError,
  ComposioConnectionExpiredError,
  ComposioRateLimitError,
  FbBudgetExceeded,
  hasComposioKey,
} from '../../../_lib/composio.js';
import { isFbStudioEnabled } from '../settings.js';
import { notifyOwner } from '../notify.js';
import type { AgentRunner } from './agent-turn.js';
import { classifyImportedPosts, runAnalyst, type AnalystOutcome } from './analyst.js';
import { BACKFILL_DAYS, IMPORT_DAYS, SWEEP_POST_DAYS, isAnalystDue, isSweepDue, refreshWaitSec } from './schedule.js';
import { captureDueMilestones, syncPage, type SyncResult } from './sync.js';
import { localDay, safeTimezone } from './time.js';

const TICK_MS = 5 * 60 * 1000;
const ANALYST_RETRY_SEC = 3600;

export const settingKeys = {
  imported: (pageId: string) => `analytics.import.${pageId}`,
  sweep: (pageId: string) => `analytics.sweep.${pageId}`,
  analyst: (pageId: string) => `analytics.analyst.${pageId}`,
  refresh: (pageId: string) => `analytics.refresh.${pageId}`,
};

function nowSec(): number { return Math.floor(Date.now() / 1000); }

export interface CycleDeps {
  runner?: AgentRunner;
  pauseMs?: number;
}

export interface CycleReport {
  milestones: number;
  sweep: SyncResult | null;
  classified: number;
  analyst: AnalystOutcome | null;
}

const analystRetryAfter = new Map<string, number>();

/** Imports (when never done) + sweep + classification, and records the markers. Shared by the daily sweep and manual refresh. */
async function sweepPage(page: FbAnalyticsPageRow, now: number, deps: CycleDeps, force: boolean): Promise<{ sweep: SyncResult; classified: number }> {
  const tz = safeTimezone(page.timezone);
  const firstImport = !getFbSetting(settingKeys.imported(page.id));
  const sweep = await syncPage(page, {
    now,
    importDays: firstImport ? IMPORT_DAYS : SWEEP_POST_DAYS,
    snapshotDays: firstImport ? IMPORT_DAYS : SWEEP_POST_DAYS,
    backfillDays: BACKFILL_DAYS,
    force,
    pauseMs: deps.pauseMs,
  });
  setFbSetting(settingKeys.imported(page.id), String(now));
  setFbSetting(settingKeys.sweep(page.id), localDay(now, tz));
  let classified = 0;
  try {
    classified = await classifyImportedPosts(page, { runner: deps.runner });
  } catch (err) {
    logger.warn({ pageId: page.id, err: String((err as Error)?.message ?? err).slice(0, 160) }, 'fbstudio classification failed');
  }
  return { sweep, classified };
}

export async function runPageCycle(page: FbAnalyticsPageRow, now: number, deps: CycleDeps = {}): Promise<CycleReport> {
  const tz = safeTimezone(page.timezone);
  const report: CycleReport = { milestones: 0, sweep: null, classified: 0, analyst: null };

  report.milestones = await captureDueMilestones(page, now, { pauseMs: deps.pauseMs });

  const firstImport = !getFbSetting(settingKeys.imported(page.id));
  if (firstImport || isSweepDue(now, tz, getFbSetting(settingKeys.sweep(page.id)))) {
    const swept = await sweepPage(page, now, deps, false);
    report.sweep = swept.sweep;
    report.classified = swept.classified;
  }

  const retryAfter = analystRetryAfter.get(page.id) ?? 0;
  if (now >= retryAfter && isAnalystDue(now, tz, getFbSetting(settingKeys.analyst(page.id)), getFbSetting(settingKeys.sweep(page.id)))) {
    const outcome = await runAnalyst(page, now, { runner: deps.runner });
    report.analyst = outcome;
    if (outcome === 'error') analystRetryAfter.set(page.id, now + ANALYST_RETRY_SEC);
    else {
      analystRetryAfter.delete(page.id);
      setFbSetting(settingKeys.analyst(page.id), localDay(now, tz));
    }
  }
  return report;
}

/** What a failed Page cycle means for the rest of the tick. */
async function handleCycleError(page: FbAnalyticsPageRow, err: unknown): Promise<'continue' | 'stop'> {
  if (err instanceof ComposioConnectionExpiredError) {
    if (page.status !== 'EXPIRED') {
      setFbAnalyticsPageStatus(page.id, 'EXPIRED');
      await notifyOwner(`Kết nối Facebook của Page "${page.name}" đã hết hạn nên số liệu ngừng cập nhật. Vào Marketing › Facebook › Pages để kết nối lại.`);
    }
    return 'continue';
  }
  if (err instanceof ComposioRateLimitError || err instanceof FbBudgetExceeded) {
    logger.warn({ pageId: page.id, err: err.message.slice(0, 120) }, 'fbstudio analytics backing off');
    return 'stop';
  }
  if (err instanceof ComposioAuthError) {
    logger.warn('fbstudio analytics: Composio key missing or rejected');
    return 'stop';
  }
  logger.error({ pageId: page.id, err }, 'fbstudio analytics cycle failed');
  return 'continue';
}

let inFlight = false;

export async function analyticsTick(deps: CycleDeps = {}): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    if (!isFbStudioEnabled() || !hasComposioKey()) return;
    const now = nowSec();
    for (const page of listFbAnalyticsPages({ enabledOnly: true })) {
      if (page.status === 'EXPIRED' || !page.connection_id) continue;
      try {
        await runPageCycle(page, now, deps);
      } catch (err) {
        if ((await handleCycleError(page, err)) === 'stop') break;
      }
    }
  } catch (err) {
    logger.error({ err }, 'fbstudio analytics tick failed');
  } finally {
    inFlight = false;
  }
}

// ── Manual refresh ─────────────────────────────────────────────────────

const refreshing = new Set<string>();

export type RefreshStart =
  | { ok: true; done: Promise<void> }
  | { ok: false; status: 404 | 409 | 429 | 503; error: string; retryAfterSec?: number };

/**
 * Starts "import + latest snapshot now" for one Page in the background.
 * Allowed once per 10 minutes per Page. `done` settles when the run ends
 * (never rejects); the route does not wait for it.
 */
export function startRefresh(page: FbAnalyticsPageRow | undefined, deps: CycleDeps = {}): RefreshStart {
  if (!page) return { ok: false, status: 404, error: 'Không tìm thấy Page' };
  if (!isFbStudioEnabled()) return { ok: false, status: 409, error: 'Facebook Studio đang tắt. Bật trong Cài đặt trước.' };
  if (!hasComposioKey()) return { ok: false, status: 503, error: 'Chưa cấu hình khóa Composio.' };
  if (!page.enabled || !page.connection_id) return { ok: false, status: 409, error: 'Page chưa được bật hoặc chưa có kết nối.' };
  if (page.status === 'EXPIRED') return { ok: false, status: 409, error: 'Kết nối Facebook của Page đã hết hạn. Kết nối lại trước khi làm mới.' };
  if (refreshing.has(page.id)) return { ok: false, status: 409, error: 'Đang làm mới số liệu của Page này.' };
  const now = nowSec();
  const last = Number(getFbSetting(settingKeys.refresh(page.id))) || null;
  const wait = refreshWaitSec(now, last);
  if (wait > 0) {
    return { ok: false, status: 429, error: `Vừa làm mới xong. Thử lại sau ${Math.ceil(wait / 60)} phút.`, retryAfterSec: wait };
  }
  setFbSetting(settingKeys.refresh(page.id), String(now));
  refreshing.add(page.id);
  const done = (async () => {
    try {
      await sweepPage(page, now, deps, true);
    } catch (err) {
      await handleCycleError(page, err);
    } finally {
      refreshing.delete(page.id);
    }
  })();
  return { ok: true, done };
}

let timer: ReturnType<typeof setInterval> | null = null;
let firstTick: ReturnType<typeof setTimeout> | null = null;

export function startAnalyticsWorker(): void {
  if (timer) return;
  timer = setInterval(() => { void analyticsTick(); }, TICK_MS);
  timer.unref?.();
  // First pass shortly after boot instead of waiting a full tick.
  firstTick = setTimeout(() => { void analyticsTick(); }, 30_000);
  firstTick.unref?.();
  logger.info('Facebook analytics worker started');
}

export function stopAnalyticsWorker(): void {
  if (timer) clearInterval(timer);
  if (firstTick) clearTimeout(firstTick);
  timer = null;
  firstTick = null;
}
