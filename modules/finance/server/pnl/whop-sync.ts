/**
 * Whop revenue per Vietnam day into pnl_whop_daily (USD): gross, refunded, net. Read-only: only the
 * accounts_list and stats_time-series_get tools are ever called. First pass backfills a year, later passes
 * refresh the last 10 days. Optional: a no-op until a Whop MCP endpoint is set in the module settings.
 */

import { randomUUID } from 'node:crypto';
import type { DB } from '../../../../src/core/db.js';
import { hasTarget, parseToolResult, type McpConnector, type McpTarget } from '../mcp.js';
import { upsertWhopDays, whopHistoryDays } from './store.js';
import type { WhopDayRow } from './engine.js';

const TZ = 'Asia/Ho_Chi_Minh';
const VN_OFFSET_SEC = 7 * 3600;
const DAY_SEC = 86_400;

export const WHOP_READ_TOOLS: ReadonlySet<string> = new Set(['accounts_list', 'stats_time-series_get']);

const vnDate = (sec: number) => new Date((sec + VN_OFFSET_SEC) * 1000).toISOString().slice(0, 10);

/** Pure: three daily series → one row per day. */
export function mergeWhopSeries(series: Record<'gross' | 'refunded' | 'net', Array<{ timestamp: number; value: number }>>): WhopDayRow[] {
  const days = new Map<string, WhopDayRow>();
  for (const key of ['gross', 'refunded', 'net'] as const) {
    for (const p of series[key]) {
      const date = vnDate(p.timestamp);
      const row = days.get(date) ?? { date, gross: 0, refunded: 0, net: 0 };
      row[key] += p.value;
      days.set(date, row);
    }
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

const firstAccountId = (raw: unknown): string | null => {
  const first = (raw as { data?: Array<{ id?: unknown }> })?.data?.[0];
  return first?.id ? String(first.id) : null;
};

export interface WhopSyncDeps {
  db: DB;
  connect: McpConnector;
  target: () => McpTarget;
  log?: { warn(obj: unknown, msg?: string): void };
}

export interface WhopSync {
  /** Rows written; 0 when Whop is not configured. Never throws. */
  run(): Promise<number>;
  configured(): boolean;
}

export function createWhopSync(deps: WhopSyncDeps): WhopSync {
  let running: Promise<number> | null = null;

  async function doSync(): Promise<number> {
    const target = deps.target();
    if (!hasTarget(target)) return 0;
    const nowSec = Math.floor(Date.now() / 1000);
    const back = whopHistoryDays(deps.db) < 30 ? 365 : 10;
    const from = new Date((nowSec - back * DAY_SEC) * 1000).toISOString();
    const to = new Date(nowSec * 1000).toISOString();
    try {
      const link = await deps.connect(target);
      let rows: WhopDayRow[];
      try {
        const intent = { intent: 'AIOS finance: read Whop business metrics (read-only)', intent_id: randomUUID() };
        const call = async (name: string, args: Record<string, unknown>) => {
          if (!WHOP_READ_TOOLS.has(name)) throw new Error(`Công cụ Whop "${name}" không nằm trong danh sách chỉ đọc.`);
          return parseToolResult(await link.session.callTool(name, { ...intent, ...args }, 40_000));
        };
        const accountId = firstAccountId(await call('accounts_list', {}));
        if (!accountId) return 0;
        const series = async (metric: string) => {
          const raw = await call('stats_time-series_get', { account_id: accountId, time_zone: TZ, metric, from, to, interval: 'day' });
          const pts = (raw as { data?: { points?: Array<{ timestamp: number; value: number }> } })?.data?.points;
          if (!Array.isArray(pts)) throw new Error(`Whop ${metric} không có dữ liệu`);
          return pts.filter((p) => typeof p.timestamp === 'number' && typeof p.value === 'number');
        };
        const gross = await series('gross_revenue');
        const refunded = await series('total_refunded');
        const net = await series('net_revenue');
        rows = mergeWhopSeries({ gross, refunded, net });
      } finally {
        await link.close();
      }
      upsertWhopDays(deps.db, rows, nowSec);
      return rows.length;
    } catch (err) {
      deps.log?.warn({ err: (err as Error).message?.slice(0, 200) }, 'finance whop daily sync failed');
      return 0;
    }
  }

  return {
    run: () => (running ??= doSync().finally(() => { running = null; })),
    configured: () => hasTarget(deps.target()),
  };
}
