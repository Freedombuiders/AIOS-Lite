/** GET /status and GET/PUT /settings. */


import { countFbApiCallsSince, getNextScheduledFbContent } from '../store.js';
import { configuredBudgetPerHour, isFbStudioEnabled, readComposioKey, setBudgetPerHour, setFbStudioEnabled } from '../settings.js';
import { logger } from '../compat.js';
import { commentsWorkerStatus } from '../comments/worker.js';
import { FB_MEDIA_DIR, hasComposioKey, listConnections, type ComposioConnection } from '../../../_lib/composio.js';
import type { ConnStatus, FbSettingsDto, FbSettingsUpdate, FbStatusDto } from '../types.js';
import { FbError } from './errors.js';
import { getPublisherState } from './publisher.js';


const DEFAULT_BUDGET_PER_HOUR = 600;
const CONNECTION_CACHE_MS = 5 * 60_000;
const CONNECTION_ERROR_CACHE_MS = 60_000;
const CONNECTION_TIMEOUT_MS = 8_000;

const nowSec = (): number => Math.floor(Date.now() / 1000);

interface ConnectionCheck {
  facebook: ConnStatus;
  metaads: ConnStatus;
  checkedAt: number;
  expiresAt: number;
}

let connectionCache: ConnectionCheck | null = null;
let connectionCacheKey: string | undefined;

export function _resetStatusCache(): void {
  connectionCache = null;
}

function statusOfToolkit(all: ComposioConnection[], toolkit: string): ConnStatus {
  const mine = all.filter((c) => c.toolkit === toolkit);
  if (mine.length === 0) return 'MISSING';
  return mine.some((c) => c.status === 'ACTIVE') ? 'ACTIVE' : 'EXPIRED';
}

/** Composio connection state, cached for 5 minutes (1 minute after a failed check). */
async function checkConnections(): Promise<ConnectionCheck> {
  const nowMs = Date.now();
  if (connectionCache && connectionCache.expiresAt > nowMs) return connectionCache;
  let result: ConnectionCheck;
  try {
    const all = await Promise.race([
      listConnections(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), CONNECTION_TIMEOUT_MS).unref?.()),
    ]);
    result = {
      facebook: statusOfToolkit(all, 'facebook'),
      metaads: statusOfToolkit(all, 'metaads'),
      checkedAt: nowSec(),
      expiresAt: nowMs + CONNECTION_CACHE_MS,
    };
  } catch (err) {
    logger.warn({ err: String(err) }, 'fbstudio: connection check failed');
    result = { facebook: 'UNKNOWN', metaads: 'UNKNOWN', checkedAt: nowSec(), expiresAt: nowMs + CONNECTION_ERROR_CACHE_MS };
  }
  connectionCache = result;
  return result;
}

export function budgetPerHour(): number {
  return configuredBudgetPerHour() ?? DEFAULT_BUDGET_PER_HOUR;
}

export async function getStatus(): Promise<FbStatusDto> {
  const key = readComposioKey();
  if (key !== connectionCacheKey) { connectionCache = null; connectionCacheKey = key; }
  const keyConfigured = hasComposioKey();
  let facebook: ConnStatus = 'MISSING';
  let metaads: ConnStatus = 'MISSING';
  let checkedAt: number | null = null;
  if (keyConfigured) {
    const check = await checkConnections();
    facebook = check.facebook;
    metaads = check.metaads;
    checkedAt = check.checkedAt;
  }

  const publisher = getPublisherState();
  const next = getNextScheduledFbContent();
  const now = nowSec();
  return {
    composio: { keyConfigured, facebook, metaads, checkedAt },
    publisher: {
      running: publisher.running,
      lastTickAt: publisher.lastTickAt,
      next: next && next.scheduled_at !== null
        ? { contentId: next.id, title: next.title || next.caption.slice(0, 60), pageName: next.page_name ?? '', scheduledAt: next.scheduled_at }
        : null,
    },
    comments: commentsWorkerStatus(),
    apiCallsThisHour: countFbApiCallsSince(now - (now % 3600)),
    apiBudgetPerHour: budgetPerHour(),
  };
}

// ── Settings ─────────────────────────────────────────────────────────

export function getSettings(): FbSettingsDto {
  return {
    composioKeyConfigured: hasComposioKey(),
    apiBudgetPerHour: budgetPerHour(),
    mediaDir: FB_MEDIA_DIR,
    enabled: isFbStudioEnabled(),
  };
}

export async function updateSettings(update: FbSettingsUpdate): Promise<FbSettingsDto> {
  if (update.apiBudgetPerHour !== undefined) {
    const n = update.apiBudgetPerHour;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 100_000) {
      throw new FbError(400, 'Ngân sách API mỗi giờ phải là số nguyên từ 1 đến 100000.');
    }
  }
  if (update.enabled !== undefined && typeof update.enabled !== 'boolean') throw new FbError(400, 'Giá trị bật/tắt không hợp lệ.');

  if (update.composioApiKey !== undefined) throw new FbError(400, 'Quản lý Composio API key tại Kết nối → Composio.');
  if (update.apiBudgetPerHour !== undefined) setBudgetPerHour(update.apiBudgetPerHour);
  if (update.enabled !== undefined) setFbStudioEnabled(update.enabled);
  return getSettings();
}
