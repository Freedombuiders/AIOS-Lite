/**
 * The memory ledger ("sổ ghi nhớ"): reported posts (new / rising) and pains with stable ids.
 * Re-running a layer on the same day never double counts: a post first seen today stays "new",
 * a pain's `times` grows once per report day.
 */

import { radarDb } from './store.js';
import { addDays } from './time.js';
import { foldVi } from './util.js';
import type { LayerKey } from './types.js';

// ── Posts ───────────────────────────────────────────────────────────────

export interface SeenInfo {
  isNew: boolean;
  rising?: { times: number; prevComments: number };
}

export interface LedgerItem { id: string; url: string; title: string; comments: number }

/** Growth that makes an already-reported post "rising": at least +20% and at least +10 comments. */
export function isRising(prev: number, now: number): boolean {
  return now - prev >= 10 && now >= prev * 1.2;
}

/** New / rising per item, judged against the ledger as it stands (call before recordSeen). */
export function classifySeen(layer: LayerKey, day: string, items: LedgerItem[]): Map<string, SeenInfo> {
  const get = radarDb().prepare('SELECT first_day, times, last_comments FROM radar_seen WHERE id = ? AND layer = ?');
  const out = new Map<string, SeenInfo>();
  for (const it of items) {
    const row = get.get(it.id, layer) as { first_day: string; times: number; last_comments: number } | undefined;
    if (!row || row.first_day >= day) {
      out.set(it.id, { isNew: true });
    } else if (isRising(row.last_comments, it.comments)) {
      out.set(it.id, { isNew: false, rising: { times: row.times + 1, prevComments: row.last_comments } });
    } else {
      out.set(it.id, { isNew: false });
    }
  }
  return out;
}

/** Writes the items into the ledger. A later day bumps `times` and moves the comment baseline. */
export function recordSeen(layer: LayerKey, day: string, items: LedgerItem[]): void {
  const db = radarDb();
  const get = db.prepare('SELECT first_day, last_day, times, last_comments FROM radar_seen WHERE id = ? AND layer = ?');
  const ins = db.prepare('INSERT INTO radar_seen (id, layer, url, title, first_day, last_day, times, last_comments) VALUES (?, ?, ?, ?, ?, ?, 1, ?)');
  const bump = db.prepare('UPDATE radar_seen SET last_day = ?, times = times + 1, last_comments = ?, title = ? WHERE id = ? AND layer = ?');
  const sameDay = db.prepare('UPDATE radar_seen SET last_comments = ?, title = ? WHERE id = ? AND layer = ?');
  db.transaction(() => {
    for (const it of items) {
      const row = get.get(it.id, layer) as { first_day: string; last_day: string; times: number; last_comments: number } | undefined;
      if (!row) ins.run(it.id, layer, it.url, it.title, day, day, it.comments);
      else if (row.last_day < day) bump.run(day, it.comments, it.title, it.id, layer);
      else if (row.first_day === day) sameDay.run(Math.max(row.last_comments, it.comments), it.title, it.id, layer);
    }
  })();
}

// ── Pains ───────────────────────────────────────────────────────────────

export interface LedgerPain {
  id: string;
  layer: LayerKey;
  title: string;
  detail: string;
  professions: string[];
  topics: string[];
  firstDay: string;
  lastDay: string;
  times: number;
  reportDays: string[];
}

interface PainRow {
  id: string; layer: string; title: string; detail: string; professions_json: string; topics_json: string;
  first_day: string; last_day: string; times: number; report_days_json: string;
}

function parseList(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function toPain(r: PainRow): LedgerPain {
  return {
    id: r.id, layer: r.layer as LayerKey, title: r.title, detail: r.detail, professions: parseList(r.professions_json),
    topics: parseList(r.topics_json), firstDay: r.first_day, lastDay: r.last_day, times: r.times, reportDays: parseList(r.report_days_json),
  };
}

/** Pains whose last report day is within `days` days before `day` (inclusive), newest first. All layers: ids are global. */
export function recentPains(day: string, days = 30): LedgerPain[] {
  const since = addDays(day, -days);
  return (radarDb().prepare('SELECT * FROM radar_pains WHERE last_day >= ? ORDER BY last_day DESC, id DESC').all(since) as PainRow[]).map(toPain);
}

export function getPain(id: string): LedgerPain | null {
  const r = radarDb().prepare('SELECT * FROM radar_pains WHERE id = ?').get(id) as PainRow | undefined;
  return r ? toPain(r) : null;
}

/** The next global id: P001, P002 … */
export function nextPainId(): string {
  const rows = radarDb().prepare('SELECT id FROM radar_pains').all() as { id: string }[];
  let max = 0;
  for (const r of rows) {
    const n = Number(r.id.replace(/^P/, ''));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `P${String(max + 1).padStart(3, '0')}`;
}

export interface PainInput {
  title: string;
  detail: string;
  professions: string[];
  topics: string[];
  /** An existing pain id the analyst judged to be the same pain. */
  matchId?: string | null;
}

export interface ResolvedPain {
  id: string;
  /** First reported today. */
  isNew: boolean;
  times: number;
  firstSeen: string;
}

/**
 * Gives every pain an id. A matchId that exists recurs: `times` grows once per report day (a rerun on a day
 * that is already counted changes nothing). Otherwise a new pain takes the next id.
 */
export function resolvePains(layer: LayerKey, day: string, inputs: PainInput[]): ResolvedPain[] {
  const db = radarDb();
  const out: ResolvedPain[] = [];
  db.transaction(() => {
    for (const p of inputs) {
      let existing = p.matchId ? getPain(p.matchId) : null;
      if (!existing) {
        // A rerun the same day may restate a pain it already created: same title, same layer, same day.
        const same = (db.prepare('SELECT * FROM radar_pains WHERE layer = ? AND first_day = ?').all(layer, day) as PainRow[])
          .find((r) => foldVi(r.title) === foldVi(p.title));
        if (same) existing = toPain(same);
      }
      if (existing) {
        const counted = existing.reportDays.includes(day);
        const days = counted ? existing.reportDays : [...existing.reportDays, day];
        const times = counted ? existing.times : existing.times + 1;
        db.prepare('UPDATE radar_pains SET last_day = ?, times = ?, report_days_json = ?, detail = ? WHERE id = ?')
          .run(day > existing.lastDay ? day : existing.lastDay, times, JSON.stringify(days), p.detail || existing.detail, existing.id);
        out.push({ id: existing.id, isNew: existing.firstDay === day, times, firstSeen: existing.firstDay });
      } else {
        const id = nextPainId();
        db.prepare(`INSERT INTO radar_pains (id, layer, title, detail, professions_json, topics_json, first_day, last_day, times, report_days_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`)
          .run(id, layer, p.title, p.detail, JSON.stringify(p.professions), JSON.stringify(p.topics), day, day, JSON.stringify([day]));
        out.push({ id, isNew: true, times: 1, firstSeen: day });
      }
    }
  })();
  return out;
}
