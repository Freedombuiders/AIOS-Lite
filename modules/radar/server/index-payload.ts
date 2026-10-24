/** The index page payload: latest report per layer and the archive by day, built from the stored reports. */

import { listReports } from './store.js';
import { loadConfig } from './config.js';
import { dayLabels } from './util.js';
import { LAYER_KEYS, type IndexArchiveDay, type IndexLayerCard, type IndexPayload, type LayerKey, type ReportPayload } from './types.js';

const MAX_ARCHIVE_DAYS = 60;

/** The session the day's numbers come from: the merged view when there is one, else the only session. */
function mainSession(payload: ReportPayload) {
  return payload.sessions[0];
}

export interface ReportCounts {
  sources: number;
  posts: number;
  comments: number;
  newPosts: number;
  newPains: number;
  recurringPains: number;
}

export function countsOf(payload: ReportPayload): ReportCounts {
  const s = mainSession(payload);
  if (!s) return { sources: 0, posts: 0, comments: 0, newPosts: 0, newPains: 0, recurringPains: 0 };
  return {
    sources: s.communities.length,
    posts: s.items.length,
    comments: s.items.filter((i) => i.within24h).reduce((sum, i) => sum + (i.metrics.comments ?? 0), 0),
    newPosts: s.items.filter((i) => i.isNew).length,
    newPains: s.pains.filter((p) => p.isNew).length,
    recurringPains: s.pains.filter((p) => !p.isNew).length,
  };
}

export function buildIndexPayload(): IndexPayload {
  const config = loadConfig();
  const reports = listReports(MAX_ARCHIVE_DAYS * LAYER_KEYS.length);
  const latest = new Map<LayerKey, (typeof reports)[number]>();
  for (const r of reports) if (!latest.has(r.layer)) latest.set(r.layer, r);

  const layers: IndexLayerCard[] = LAYER_KEYS.map((key) => {
    const lc = config.layers[key];
    const r = latest.get(key);
    let card: IndexLayerCard['latest'] = null;
    if (r) {
      const dl = dayLabels(r.day);
      const s = mainSession(r.payload);
      card = {
        date: r.day,
        dateLabel: `${dl.weekday}, ${dl.dateLabel}`,
        ...countsOf(r.payload),
        topPains: (s?.pains ?? []).slice(0, 3).map((p) => ({ title: p.title, isNew: p.isNew, times: p.times })),
      };
    }
    return { key, label: lc.label, time: lc.time, description: lc.description, latest: card };
  });

  const days = [...new Set(reports.map((r) => r.day))].sort().reverse().slice(0, MAX_ARCHIVE_DAYS);
  const archive: IndexArchiveDay[] = days.map((day) => {
    const dl = dayLabels(day);
    return {
      date: day, day: dl.day, weekday: dl.weekday, monthLabel: dl.monthLabel,
      layers: LAYER_KEYS.map((key) => {
        const r = reports.find((x) => x.day === day && x.layer === key);
        return { key, label: config.layers[key].label, time: config.layers[key].time, newPosts: r ? countsOf(r.payload).newPosts : null };
      }),
    };
  });

  const newest = days[0];
  const nl = newest ? dayLabels(newest) : null;
  return {
    owner: config.owner.name,
    updatedLabel: nl ? `${nl.weekday}, ${nl.dateLabel}` : null,
    layers,
    archive,
  };
}
