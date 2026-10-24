/**
 * Radar scheduler: a 60s tick on ctx.schedule.every. When the master switch is on, each enabled layer is due once per local day
 * from its HH:MM (catches up after downtime, never past midnight). A marker per layer is written when the
 * run is queued, so a failed run is not retried in a loop.
 */

import { getKv as getDashboardSetting, setKv as setDashboardSetting } from './kv.js';
import type { ModuleContext } from '../../../src/modules/sdk.js';
import { withContext } from './context.js';
import { logger } from './log.js';
import { loadConfig } from './config.js';
import { countsOf } from './index-payload.js';
import { isLayerBusy, queueLayer } from './pipeline.js';
import { getReport, type RunInfo } from './store.js';
import { localDay, localDayStartSec, safeTimezone, slotSeconds } from './time.js';
import { LAYER_KEYS, type LayerKey } from './types.js';
import { dayLabels } from './util.js';

const TICK_MS = 60_000;

export const markerKey = (layer: LayerKey): string => `radar.lastRun.${layer}`;

/** A missed slot is caught up for this long; later the layer waits for tomorrow (turning Radar on at night must not fire all three layers at once). */
export const CATCH_UP_SEC = 6 * 3600;

/** Due: the local time has passed today's slot by less than CATCH_UP_SEC and today's marker is not set. */
export function isLayerDue(nowSec: number, tz: string, time: string, lastDay: string | null | undefined): boolean {
  const zone = safeTimezone(tz);
  const today = localDay(nowSec, zone);
  if (lastDay === today) return false;
  const slot = localDayStartSec(today, zone) + slotSeconds(time);
  return nowSec >= slot && nowSec < slot + CATCH_UP_SEC;
}

/** ISO time of the next scheduled run; null when nothing is scheduled. */
export function nextRunAt(nowSec: number, tz: string, time: string, lastDay: string | null | undefined): string | null {
  const zone = safeTimezone(tz);
  const today = localDay(nowSec, zone);
  const slotToday = localDayStartSec(today, zone) + slotSeconds(time);
  // Not run yet today: due at today's slot, or right away while the catch-up window is open.
  if (lastDay !== today && nowSec < slotToday + CATCH_UP_SEC) return new Date(Math.max(slotToday, nowSec) * 1000).toISOString();
  const [y, m, d] = today.split('-').map(Number);
  const tomorrow = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return new Date((localDayStartSec(tomorrow, zone) + slotSeconds(time)) * 1000).toISOString();
}

export function lastMarker(layer: LayerKey): string | null {
  return getDashboardSetting(markerKey(layer));
}

/** Two or three Vietnamese lines for the owner after a scheduled run. */
export function summarizeRun(run: RunInfo, label: string): string {
  const report = getReport(run.day, run.layer);
  const dl = dayLabels(run.day);
  if (run.status !== 'ok' || !report) return `Radar ${label} ${dl.short}: quét lỗi${run.error ? ` (${run.error})` : ''}.`;
  const c = countsOf(report.payload);
  const top = report.payload.sessions[0]?.pains.find((p) => p.isNew) ?? report.payload.sessions[0]?.pains[0];
  const lines = [`Radar ${label} ${dl.short}: ${c.newPosts} bài mới, ${c.newPains} nỗi đau mới, ${c.recurringPains} nỗi đau lặp lại, ${c.comments} bình luận.`];
  if (top) lines.push(`Nỗi đau nổi bật: ${top.title}.`);
  lines.push('Mở Radar thị trường để xem báo cáo.');
  return lines.join('\n');
}

/** One scheduler pass; exported for tests. Returns the layers it queued. */
export function tick(notify: (text: string) => void, nowSec = Math.floor(Date.now() / 1000)): LayerKey[] {
  const config = loadConfig();
  if (!config.enabled) return [];
  const queued: LayerKey[] = [];
  for (const layer of LAYER_KEYS) {
    const lc = config.layers[layer];
    if (!lc.enabled) continue;
    if (!isLayerDue(nowSec, config.timezone, lc.time, lastMarker(layer))) continue;
    if (isLayerBusy(layer)) continue;
    setDashboardSetting(markerKey(layer), localDay(nowSec, safeTimezone(config.timezone)));
    const { done } = queueLayer(layer, { trigger: 'schedule' });
    queued.push(layer);
    void done.then((run) => notify(summarizeRun(run, lc.label))).catch((err) => logger.warn({ err }, 'radar notify failed'));
  }
  return queued;
}

/** Starts the 60s tick on the module scheduler; returns the stop function. The tick honours the module setting `enabled`. */
export function startRadarWorker(ctx: ModuleContext, notify: (text: string) => void): () => void {
  return ctx.schedule.every('tick', TICK_MS, () => withContext(ctx, () => {
    try { tick(notify); } catch (err) { logger.warn({ err }, 'radar tick failed'); }
  }));
}
