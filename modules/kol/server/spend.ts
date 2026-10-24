/**
 * Spend for KOL Studio: admission (kill switch, master switch, studio caps,
 * persona cap) and the ledger. Every cost goes to kol_spend
 * (no budget_spend mirror in AIOS-Lite; the Costs module can read kol_spend).
 *
 * Caps count recorded spend PLUS the estimates of jobs that are queued or still
 * running (minus what those jobs already recorded), so queuing many jobs at once
 * cannot slip past a cap. Days and months are local time, like Budgets.
 */

import { checkBudgetAdmission, windowBounds } from './budget.js';
import { isEnabled } from './compat.js';
import { KolError, kolDb, loadSettings, nowSec } from './core.js';
import { fmtUsd } from './pricing.js';
import type { SpendSummaryDto } from './types.js';

export const KOL_AGENT_ID = 'kol-studio';
/** Ledger bucket (persona_id) for library catalog photos, which belong to no persona. */
export const LIBRARY_SPEND_ID = '_library';

export type SpendKind = 'image' | 'video' | 'speech' | 'lipsync' | 'judge';

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Recorded spend since `sinceSec` (optionally for one persona / requester). */
export function recordedSince(sinceSec: number, personaId?: string, requestedBy?: string): number {
  const where = ['created_at >= ?'];
  const params: (string | number)[] = [sinceSec];
  if (personaId) { where.push('persona_id = ?'); params.push(personaId); }
  if (requestedBy) { where.push('requested_by = ?'); params.push(requestedBy); }
  const r = kolDb().prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS s FROM kol_spend WHERE ${where.join(' AND ')}`).get(...params) as { s: number };
  return r.s;
}

/** Estimates of unfinished jobs not yet covered by recorded spend. */
export function inflightUsd(opts: { personaId?: string; requestedBy?: string; sinceSec?: number } = {}): number {
  const where = ["g.status IN ('queued', 'running')"];
  const params: (string | number)[] = [];
  if (opts.personaId) { where.push('g.persona_id = ?'); params.push(opts.personaId); }
  if (opts.requestedBy) { where.push('g.requested_by = ?'); params.push(opts.requestedBy); }
  if (opts.sinceSec !== undefined) { where.push('g.created_at >= ?'); params.push(opts.sinceSec); }
  const r = kolDb().prepare(
    `SELECT COALESCE(SUM(MAX(0, g.estimate_usd - COALESCE((SELECT SUM(s.cost_usd) FROM kol_spend s WHERE s.generation_id = g.id), 0))), 0) AS s
     FROM kol_generations g WHERE ${where.join(' AND ')}`,
  ).get(...params) as { s: number };
  return r.s;
}

export function spendSummary(nowMs = Date.now()): SpendSummaryDto {
  const s = loadSettings();
  return {
    todayUsd: round4(recordedSince(windowBounds('day', nowMs).start)),
    monthUsd: round4(recordedSince(windowBounds('month', nowMs).start)),
    dailyCapUsd: s.dailyCapUsd,
    monthlyCapUsd: s.monthlyCapUsd,
  };
}

/** A persona's spend since `sinceSec`, including unfinished jobs (autopilot uses it for its weekly budget). */
export function personaSpendSince(personaId: string, sinceSec: number, requestedBy?: string): number {
  return round4(recordedSince(sinceSec, personaId, requestedBy) + inflightUsd({ personaId, requestedBy, sinceSec }));
}

export function personaMonthSpend(personaId: string, nowMs = Date.now()): number {
  return round4(recordedSince(windowBounds('month', nowMs).start, personaId));
}

function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Spend per local day for the last `days` days, oldest first, zero days included. */
export function spendByDay(personaId: string, days: number, nowMs = Date.now()): { day: string; usd: number }[] {
  const n = Math.min(Math.max(Math.floor(days) || 1, 1), 366);
  const today = new Date(nowMs);
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (n - 1));
  const rows = kolDb().prepare(
    `SELECT strftime('%Y-%m-%d', created_at, 'unixepoch', 'localtime') AS day, SUM(cost_usd) AS usd
     FROM kol_spend WHERE persona_id = ? AND created_at >= ? GROUP BY day`,
  ).all(personaId, Math.floor(start.getTime() / 1000)) as { day: string; usd: number }[];
  const map = new Map(rows.map((r) => [r.day, r.usd]));
  const out: { day: string; usd: number }[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const key = localDay(d);
    out.push({ day: key, usd: round4(map.get(key) ?? 0) });
  }
  return out;
}

/** Kill switch + master switch, without money checks. Throws 409. */
export function assertGenerationOpen(): void {
  if (!isEnabled('KOL_GENERATE_ENABLED')) throw new KolError(409, 'Tạo ảnh/video đang bị tắt (công tắc "Cho phép tạo ảnh/video" của module KOL Studio đang tắt).', 'kill_switch');
  if (!loadSettings().enabled) throw new KolError(409, 'KOL Studio đang tắt. Bật lại ở KOL Studio › Cài đặt.', 'disabled');
}

/**
 * May this persona spend `estimateUsd` more? Throws 409 (switched off) or 402
 * (a cap or a Budgets hard stop) with a Vietnamese reason.
 */
export function admission(personaId: string, estimateUsd: number, nowMs = Date.now()): void {
  assertGenerationOpen();
  const s = loadSettings();
  const est = Math.max(0, estimateUsd);
  const pending = inflightUsd();
  const today = recordedSince(windowBounds('day', nowMs).start) + pending;
  if (today + est > s.dailyCapUsd + 1e-9) {
    throw new KolError(402, `Vượt hạn mức ngày của KOL Studio: đã dùng và đang chờ ${fmtUsd(today)} / ${fmtUsd(s.dailyCapUsd)}, lần này ≈ ${fmtUsd(est)}. Nâng hạn mức ở KOL Studio › Cài đặt.`, 'daily_cap');
  }
  const month = recordedSince(windowBounds('month', nowMs).start) + pending;
  if (month + est > s.monthlyCapUsd + 1e-9) {
    throw new KolError(402, `Vượt hạn mức tháng của KOL Studio: đã dùng và đang chờ ${fmtUsd(month)} / ${fmtUsd(s.monthlyCapUsd)}, lần này ≈ ${fmtUsd(est)}.`, 'monthly_cap');
  }
  const persona = kolDb().prepare('SELECT name, monthly_cap_usd FROM kol_personas WHERE id = ?').get(personaId) as { name: string; monthly_cap_usd: number | null } | undefined;
  if (persona && persona.monthly_cap_usd !== null && persona.monthly_cap_usd !== undefined) {
    const used = recordedSince(windowBounds('month', nowMs).start, personaId) + inflightUsd({ personaId });
    if (used + est > persona.monthly_cap_usd + 1e-9) {
      throw new KolError(402, `Vượt hạn mức tháng của ${persona.name}: đã dùng và đang chờ ${fmtUsd(used)} / ${fmtUsd(persona.monthly_cap_usd)}, lần này ≈ ${fmtUsd(est)}.`, 'persona_cap');
    }
  }
  const budget = checkBudgetAdmission(KOL_AGENT_ID, nowMs);
  if (!budget.allowed) throw new KolError(402, `Ngân sách (Budgets) đang chặn KOL Studio. ${budget.error.message}`, 'budget');
}

export interface SpendRecord {
  personaId: string;
  generationId: string | null;
  provider: string;
  model: string;
  kind: SpendKind;
  costUsd: number;
  costStatus: 'reported' | 'estimated';
  requestedBy: string;
}

/** One ledger row in kol_spend (the Costs module can read this table). */
export function recordSpend(r: SpendRecord, nowS = nowSec()): void {
  const cost = Number.isFinite(r.costUsd) && r.costUsd > 0 ? round6(r.costUsd) : 0;
  const db = kolDb();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO kol_spend (persona_id, generation_id, provider, model, kind, cost_usd, cost_status, requested_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(r.personaId, r.generationId, r.provider, r.model, r.kind, cost, r.costStatus, r.requestedBy, nowS);
  })();
}

/** Total recorded for one generation. */
export function generationSpend(generationId: string): number {
  const r = kolDb().prepare('SELECT COALESCE(SUM(cost_usd), 0) AS s FROM kol_spend WHERE generation_id = ?').get(generationId) as { s: number };
  return round6(r.s);
}
