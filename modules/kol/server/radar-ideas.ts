/**
 * Content ideas from the latest Radar reports (Marketing › Radar), read-only.
 * Ideas live in ReportPayload.sessions[].ideas (the merged 'all' session when
 * a layer ran several times that day); trends add a few more angles. Plain
 * SQL on radar_reports so KOL Studio never depends on Radar being set up:
 * no table or a bad payload just means no ideas.
 */

import { moduleCompat } from './compat.js';
import { kolDb } from './core.js';
import type { RadarIdeaDto } from './types.js';

interface RawIdea {
  channel?: unknown;
  title?: unknown;
  evidence?: unknown;
  status?: unknown;
}

interface RawTrend {
  rank?: unknown;
  title?: unknown;
  description?: unknown;
  vnAngle?: unknown;
}

interface RawSession {
  key?: unknown;
  ideas?: unknown;
  trends?: unknown;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

/** Ideas of one report payload (pure; exported for tests). */
export function ideasFromPayload(day: string, layer: string, payload: unknown): RadarIdeaDto[] {
  const sessions = (payload && typeof payload === 'object' ? (payload as { sessions?: unknown }).sessions : null);
  if (!Array.isArray(sessions)) return [];
  const all = (sessions as RawSession[]).find((s) => s?.key === 'all');
  const use = all ? [all] : (sessions as RawSession[]);
  const out: RadarIdeaDto[] = [];
  for (const s of use) {
    const sk = str(s?.key) || 's';
    (Array.isArray(s?.ideas) ? (s.ideas as RawIdea[]) : []).forEach((idea, i) => {
      const title = str(idea?.title);
      if (!title || idea?.status === 'done') return;
      const evidence = Array.isArray(idea.evidence) ? (idea.evidence as unknown[]).map(str).filter(Boolean) : [];
      const channel = str(idea.channel);
      out.push({
        key: `${day}:${layer}:${sk}:i${i}`,
        day,
        layer,
        title,
        detail: [channel && `Kênh: ${channel}`, ...evidence].filter(Boolean).join(' · ').slice(0, 600),
        url: '',
      });
    });
    (Array.isArray(s?.trends) ? (s.trends as RawTrend[]) : []).forEach((t, i) => {
      const title = str(t?.title);
      if (!title) return;
      out.push({
        key: `${day}:${layer}:${sk}:t${i}`,
        day,
        layer,
        title,
        detail: [str(t.description), str(t.vnAngle)].filter(Boolean).join(' — ').slice(0, 600),
        url: '',
      });
    });
  }
  return out;
}

/** False only when the module host is bound and the Radar module is off (unbound = tests: allowed). */
export function radarEnabled(): boolean {
  const ctx = moduleCompat('kol');
  return ctx ? ctx.modules.isEnabled('radar') : true;
}

/** Newest first, deduplicated by title, at most `limit` (1–100). */
export function listRadarIdeas(limit = 30): RadarIdeaDto[] {
  if (!radarEnabled()) return [];
  const max = Math.min(100, Math.max(1, Math.round(limit) || 30));
  let rows: { day: string; layer: string; payload_json: string }[];
  try {
    rows = kolDb().prepare('SELECT day, layer, payload_json FROM radar_reports ORDER BY day DESC, updated_at DESC LIMIT 12').all() as typeof rows;
  } catch {
    return [];
  }
  const out: RadarIdeaDto[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    let payload: unknown;
    try {
      payload = JSON.parse(r.payload_json);
    } catch {
      continue;
    }
    for (const idea of ideasFromPayload(r.day, r.layer, payload)) {
      const k = idea.title.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(idea);
      if (out.length >= max) return out;
    }
  }
  return out;
}
