/**
 * Comment worker: one interval, two independent guarded jobs.
 *
 *   poll+decide   per eligible Page every `pollMinutes`: fetch new comments,
 *                 then run the pipeline over comments still `new` (slow: the
 *                 agent turn can take minutes)
 *   send          deliver queued replies whose send_after has passed (fast)
 *
 * Every tick returns at once unless the studio and the FB_AUTOREPLY_ENABLED
 * kill switch are on, so the dashboard can switch the worker off and on
 * without a restart. Nothing thrown here may reach the main process.
 */

import { listFbCommentPages } from '../store.js';
import { isEnabled } from '../settings.js';
import { logger } from '../compat.js';
import { ComposioConnectionExpiredError, ComposioRateLimitError, FbBudgetExceeded } from '../../../_lib/composio.js';
import { isFbStudioEnabled } from '../settings.js';
import { handleExpired } from './common.js';
import { loadPageRules } from './config.js';
import { pollPage } from './poller.js';
import { processNewComments } from './processor.js';
import { sendDueComments } from './sender.js';
import { clearAutoReplySince, ensureAutoReplySince, getAnyLastPollAt, getLastPollAt, setLastPollAt } from './state.js';

const TICK_MS = 30_000;
const nowSec = (): number => Math.floor(Date.now() / 1000);

let timer: ReturnType<typeof setInterval> | null = null;
let pollInFlight = false;
let sendInFlight = false;

function workerOn(): boolean {
  return isFbStudioEnabled() && isEnabled('FB_AUTOREPLY_ENABLED');
}

/** Polls the Pages whose interval has elapsed (backing off on rate limits), then decides on every new comment. */
export async function pollAndDecide(): Promise<void> {
  const eligible: string[] = [];
  let backOff = false;
  for (const page of listFbCommentPages()) {
    const rules = loadPageRules(page.id);
    if (!page.enabled || !rules.enabled) {
      clearAutoReplySince(page.id);
      continue;
    }
    if (page.status === 'EXPIRED' || page.status === 'MISSING' || !page.connection_id) continue;
    ensureAutoReplySince(page.id);
    eligible.push(page.id);
    if (backOff) continue;
    if (nowSec() - (getLastPollAt(page.id) ?? 0) < rules.pollMinutes * 60) continue;
    try {
      await pollPage(page, rules);
    } catch (err) {
      if (err instanceof ComposioConnectionExpiredError) await handleExpired(page);
      else if (err instanceof ComposioRateLimitError || err instanceof FbBudgetExceeded) backOff = true;
      else logger.warn({ err: (err as Error)?.name, pageId: page.id }, 'fbstudio comment poll failed');
    } finally {
      // Stamp failures too, so a broken Page is retried at its normal pace, not every tick.
      setLastPollAt(page.id);
    }
  }
  await processNewComments(eligible);
}

async function guarded(flag: 'poll' | 'send', job: () => Promise<unknown>): Promise<void> {
  if (flag === 'poll' ? pollInFlight : sendInFlight) return;
  if (flag === 'poll') pollInFlight = true; else sendInFlight = true;
  try {
    await job();
  } catch (err) {
    logger.warn({ err: (err as Error)?.name, job: flag }, 'fbstudio comments worker job failed');
  } finally {
    if (flag === 'poll') pollInFlight = false; else sendInFlight = false;
  }
}

/** One tick; exported for tests. */
export async function runCommentsTick(): Promise<void> {
  try {
    if (!workerOn()) return;
    await Promise.all([guarded('poll', pollAndDecide), guarded('send', sendDueComments)]);
  } catch (err) {
    logger.warn({ err: (err as Error)?.name }, 'fbstudio comments tick failed');
  }
}

export function startCommentsWorker(): void {
  if (timer) return;
  timer = setInterval(() => { void runCommentsTick(); }, TICK_MS);
  timer.unref?.();
}

export function stopCommentsWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** For GET /status: whether the worker is started and when any Page was last polled. */
export function commentsWorkerStatus(): { running: boolean; lastPollAt: number | null } {
  return { running: timer !== null && workerOn(), lastPollAt: getAnyLastPollAt() };
}
