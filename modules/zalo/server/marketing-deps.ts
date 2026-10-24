/**
 * What the zalo daemon hands to every marketing worker (group broadcast,
 * list broadcast, birthday). Workers run inside the daemon, send through the
 * shared ZaloSender (rate limits, quiet hours, bulk budget) and never touch
 * zca-js directly.
 */

import type { ZaloSender } from './sender.js';
import type { ZaloSessionPool } from './session.js';

export interface MarketingDeps {
  pool: ZaloSessionPool;
  sender: ZaloSender;
  /** Best-effort operator notice (becomes an attention item in AIOS). Never throws. */
  notify: (text: string) => Promise<void>;
}

export interface WorkerHandle {
  stop(): void;
}

export const DEFAULT_TIMEZONE = 'Asia/Ho_Chi_Minh';
