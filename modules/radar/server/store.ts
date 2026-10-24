/** Typed accessors over the radar tables. */

import type Database from 'better-sqlite3';

import { radarDatabase } from './context.js';
import type { LayerKey, RawItem, ReportPayload } from './types.js';

export type RunStatus = 'queued' | 'running' | 'ok' | 'error';
export type RunTrigger = 'schedule' | 'manual';

export interface RunInfo {
  id: number;
  layer: LayerKey;
  day: string;
  sessionKey: string | null;
  status: RunStatus;
  trigger: RunTrigger;
  startedAt: string;
  finishedAt: string | null;
  phase: string | null;
  error: string | null;
  itemCount: number;
  costUsd: number;
}

/** What the pipeline decided about an item in the session that first collected it. */
export interface ItemMeta {
  title: string;
  note?: string;
  profession?: string;
  theme?: string;
  topics: string[];
  buy: boolean;
  isNew: boolean;
  rising?: { times: number; prevComments: number };
  sessionKey: string;
}

/** An item as stored: the collected RawItem (comments included) plus the pipeline's decisions. */
export type StoredItem = RawItem & { meta?: ItemMeta };

/** The shared database; the radar tables come from migrations/001_init.sql. */
export function radarDb(): Database.Database {
  return radarDatabase() as unknown as Database.Database;
}

interface RunRow {
  id: number; layer: string; day: string; session_key: string | null; label: string; status: string; trigger: string;
  phase: string | null; error: string | null; item_count: number; cost_usd: number; log: string;
  started_at: string; finished_at: string | null;
}

function toRun(r: RunRow): RunInfo {
  return {
    id: r.id, layer: r.layer as LayerKey, day: r.day, sessionKey: r.session_key, status: r.status as RunStatus,
    trigger: r.trigger as RunTrigger, startedAt: r.started_at, finishedAt: r.finished_at, phase: r.phase,
    error: r.error, itemCount: r.item_count, costUsd: r.cost_usd,
  };
}

export function createRun(input: { layer: LayerKey; day: string; trigger: RunTrigger; status?: RunStatus; startedAt?: string }): RunInfo {
  const info = radarDb().prepare(
    `INSERT INTO radar_runs (layer, day, status, trigger, started_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(input.layer, input.day, input.status ?? 'queued', input.trigger, input.startedAt ?? new Date().toISOString());
  return getRun(Number(info.lastInsertRowid))!;
}

export function getRun(id: number): RunInfo | null {
  const r = radarDb().prepare('SELECT * FROM radar_runs WHERE id = ?').get(id) as RunRow | undefined;
  return r ? toRun(r) : null;
}

export function getRunLog(id: number): string[] {
  const r = radarDb().prepare('SELECT log FROM radar_runs WHERE id = ?').get(id) as { log: string } | undefined;
  if (!r) return [];
  try {
    const parsed = JSON.parse(r.log);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function listRuns(limit = 20): RunInfo[] {
  return (radarDb().prepare('SELECT * FROM radar_runs ORDER BY id DESC LIMIT ?').all(limit) as RunRow[]).map(toRun);
}

export function updateRun(id: number, patch: Partial<{
  status: RunStatus; phase: string | null; error: string | null; itemCount: number; costUsd: number;
  sessionKey: string | null; label: string; startedAt: string; finishedAt: string | null;
}>): void {
  const cols: string[] = [];
  const vals: unknown[] = [];
  const map: Record<string, string> = {
    status: 'status', phase: 'phase', error: 'error', itemCount: 'item_count', costUsd: 'cost_usd',
    sessionKey: 'session_key', label: 'label', startedAt: 'started_at', finishedAt: 'finished_at',
  };
  for (const [k, col] of Object.entries(map)) {
    if (k in patch) {
      cols.push(`${col} = ?`);
      vals.push((patch as Record<string, unknown>)[k] ?? null);
    }
  }
  if (!cols.length) return;
  radarDb().prepare(`UPDATE radar_runs SET ${cols.join(', ')} WHERE id = ?`).run(...vals, id);
}

/** Appends one log line stamped with the local HH:MM:SS of `timeZone`. */
export function appendRunLog(id: number, line: string, timeZone = 'Asia/Ho_Chi_Minh'): void {
  const lines = getRunLog(id);
  let stamp: string;
  try {
    stamp = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date());
  } catch {
    stamp = new Date().toISOString().slice(11, 19);
  }
  lines.push(`${stamp} ${line}`);
  radarDb().prepare('UPDATE radar_runs SET log = ? WHERE id = ?').run(JSON.stringify(lines.slice(-400)), id);
}

/** Runs left queued/running by a process that died. */
export function failStaleRuns(): number {
  const r = radarDb().prepare(
    `UPDATE radar_runs SET status = 'error', error = ?, finished_at = ? WHERE status IN ('queued','running')`,
  ).run('Bị gián đoạn khi ứng dụng khởi động lại', new Date().toISOString());
  return r.changes;
}

export function hasOkRun(layer: LayerKey): boolean {
  return !!radarDb().prepare(`SELECT 1 FROM radar_runs WHERE layer = ? AND status = 'ok' LIMIT 1`).get(layer);
}

export function okRunsOfDay(layer: LayerKey, day: string): RunInfo[] {
  return (radarDb().prepare(
    `SELECT * FROM radar_runs WHERE layer = ? AND day = ? AND status = 'ok' ORDER BY id`,
  ).all(layer, day) as RunRow[]).map(toRun);
}

export function lastOkDay(layer: LayerKey): string | null {
  const r = radarDb().prepare(
    `SELECT day FROM radar_runs WHERE layer = ? AND status = 'ok' ORDER BY day DESC, id DESC LIMIT 1`,
  ).get(layer) as { day: string } | undefined;
  return r?.day ?? null;
}

// ── Items ───────────────────────────────────────────────────────────────

export function saveSessionItems(day: string, layer: LayerKey, sessionKey: string, items: StoredItem[]): void {
  const db = radarDb();
  const del = db.prepare('DELETE FROM radar_items WHERE day = ? AND layer = ? AND session_key = ?');
  const ins = db.prepare('INSERT OR REPLACE INTO radar_items (day, layer, session_key, id, json) VALUES (?, ?, ?, ?, ?)');
  db.transaction(() => {
    del.run(day, layer, sessionKey);
    for (const it of items) ins.run(day, layer, sessionKey, it.id, JSON.stringify(it));
  })();
}

/** Items of the (day, layer) from sessions other than `exceptSession`, newest session wins per id. */
export function loadDayItems(day: string, layer: LayerKey, exceptSession?: string): { sessionKey: string; item: StoredItem }[] {
  const rows = radarDb().prepare(
    'SELECT session_key, json FROM radar_items WHERE day = ? AND layer = ? ORDER BY session_key',
  ).all(day, layer) as { session_key: string; json: string }[];
  const out: { sessionKey: string; item: StoredItem }[] = [];
  for (const r of rows) {
    if (exceptSession && r.session_key === exceptSession) continue;
    try { out.push({ sessionKey: r.session_key, item: JSON.parse(r.json) as StoredItem }); } catch { /* skip corrupt row */ }
  }
  return out;
}

// ── Reports ─────────────────────────────────────────────────────────────

export function saveReport(payload: ReportPayload): void {
  radarDb().prepare(
    `INSERT INTO radar_reports (day, layer, payload_json, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(day, layer) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`,
  ).run(payload.date, payload.layer, JSON.stringify(payload), new Date().toISOString());
}

export function getReport(day: string, layer: LayerKey): { payload: ReportPayload; updatedAt: string } | null {
  const r = radarDb().prepare('SELECT payload_json, updated_at FROM radar_reports WHERE day = ? AND layer = ?')
    .get(day, layer) as { payload_json: string; updated_at: string } | undefined;
  if (!r) return null;
  try { return { payload: JSON.parse(r.payload_json) as ReportPayload, updatedAt: r.updated_at }; } catch { return null; }
}

export function listReports(limit = 400): { day: string; layer: LayerKey; payload: ReportPayload; updatedAt: string }[] {
  const rows = radarDb().prepare(
    'SELECT day, layer, payload_json, updated_at FROM radar_reports ORDER BY day DESC, layer LIMIT ?',
  ).all(limit) as { day: string; layer: string; payload_json: string; updated_at: string }[];
  const out: { day: string; layer: LayerKey; payload: ReportPayload; updatedAt: string }[] = [];
  for (const r of rows) {
    try { out.push({ day: r.day, layer: r.layer as LayerKey, payload: JSON.parse(r.payload_json) as ReportPayload, updatedAt: r.updated_at }); } catch { /* skip */ }
  }
  return out;
}
