/**
 * Hourly Meta Ads snapshot for enabled ad accounts. One interval; every tick
 * returns at once unless the studio is on and there is an enabled account
 * whose last snapshot is old enough. Read-only towards Meta.
 */

import { expireStaleFbAdsRecommendations, listFbAdAccounts } from './store.js';
import { logger } from '../../../src/modules/compat/logger.js';
import {
  ComposioAuthError,
  ComposioConnectionExpiredError,
  ComposioRateLimitError,
  FbBudgetExceeded,
  hasComposioKey,
} from '../../_lib/composio.js';
import { isFbStudioEnabled } from './context.js';
import { getMetaadsConnections, syncAdAccounts } from './accounts.js';
import { THRESHOLDS } from './rules.js';
import { AdsRefreshBusyError, runAccountSnapshot } from './snapshot.js';

const TICK_MS = 5 * 60_000;
const SNAPSHOT_EVERY_SEC = 55 * 60;
const RETRY_AFTER_ERROR_SEC = 15 * 60;
const RELINK_EVERY_SEC = 60 * 60;

let running = false;
/** Per-account earliest next attempt after a failure. */
const retryAt = new Map<string, number>();
let backoffUntil = 0;
let lastRelinkAt = 0;

export function _resetAdsWorker(): void {
  retryAt.clear();
  backoffUntil = 0;
  lastRelinkAt = 0;
  running = false;
}

/** One pass over the accounts. Exported for tests; never throws. */
export async function runAdsTick(nowSec: number = Math.floor(Date.now() / 1000)): Promise<void> {
  if (running || !isFbStudioEnabled()) return;
  running = true;
  try {
    expireStaleFbAdsRecommendations(nowSec - THRESHOLDS.staleSec);

    const accounts = listFbAdAccounts();
    if (!accounts.some((a) => a.enabled === 1) || !hasComposioKey() || nowSec < backoffUntil) return;

    // Keep account status in step with the connection, and re-bind accounts to a re-linked connection.
    const { connections } = await getMetaadsConnections();
    const anyDown = listFbAdAccounts().some((a) => a.enabled === 1 && a.status !== 'ACTIVE');
    if (anyDown && connections.some((c) => c.status === 'ACTIVE') && nowSec - lastRelinkAt >= RELINK_EVERY_SEC) {
      lastRelinkAt = nowSec;
      await syncAdAccounts();
    }

    for (const account of listFbAdAccounts()) {
      if (account.enabled !== 1 || account.status !== 'ACTIVE') continue;
      if (nowSec - (account.synced_at ?? 0) < SNAPSHOT_EVERY_SEC) continue;
      if (nowSec < (retryAt.get(account.id) ?? 0)) continue;
      try {
        await runAccountSnapshot(account.id, { nowSec });
        retryAt.delete(account.id);
      } catch (err) {
        if (err instanceof ComposioConnectionExpiredError) continue; // marked EXPIRED and notified by the guard
        if (err instanceof AdsRefreshBusyError) continue;
        if (err instanceof ComposioRateLimitError || err instanceof FbBudgetExceeded) {
          backoffUntil = nowSec + TICK_MS / 1000; // next tick
          return;
        }
        if (err instanceof ComposioAuthError) return;
        retryAt.set(account.id, nowSec + RETRY_AFTER_ERROR_SEC);
        logger.warn({ err: (err as Error)?.name, message: String((err as Error)?.message ?? err).slice(0, 200), account: account.id }, 'fbstudio ads snapshot failed');
      }
    }
  } catch (err) {
    logger.warn({ err: (err as Error)?.name }, 'fbstudio ads tick failed');
  } finally {
    running = false;
  }
}

