/**
 * Workers of KOL Studio's publish side, started from src/kol/index.ts in the
 * main process: publisher (60 s), metrics (30 min), autopilot (hourly).
 * `notify` delivers owner notifications (Telegram via the main messenger).
 */

import { logger } from './compat.js';
import { setPublishNotifier } from './accounts.js';
import { startAutopilot, stopAutopilot } from './autopilot.js';
import { startMetrics, stopMetrics } from './metrics.js';
import { recoverStuckTargets, startPublisher, stopPublisher } from './publisher.js';

let started = false;

export function startPublishWorkers(notify: (text: string) => Promise<void>): void {
  setPublishNotifier(notify);
  if (started) return;
  started = true;
  // Targets left 'publishing' by a previous process are failed (never re-posted) before anything else runs.
  void recoverStuckTargets().catch((err) => logger.error({ err: String(err) }, 'kol: stuck target recovery failed'));
  startPublisher();
  startMetrics();
  startAutopilot();
}

export function stopPublishWorkers(): void {
  stopPublisher();
  stopMetrics();
  stopAutopilot();
  setPublishNotifier(null);
  started = false;
}
