/** Short text/JSON view of the newest report, for the dashboard widget and for agents holding radar.read. */
import { countsOf } from './index-payload.js';
import { listReports } from './store.js';
import { LAYER_KEYS, type LayerKey } from './types.js';
import { dayLabels } from './util.js';

export interface LatestSummary {
  date: string;
  dateLabel: string;
  layer: LayerKey;
  layerLabel: string;
  headline: string;
  newPosts: number;
  newPains: number;
  topPains: { title: string; isNew: boolean; times: number }[];
  link: string;
}

/** Newest report (latest day; among that day's layers, the one with most new pains). Null when none exists. */
export function latestSummary(): LatestSummary | null {
  const reports = listReports(LAYER_KEYS.length * 2);
  if (reports.length === 0) return null;
  const day = reports[0].day;
  const best = reports.filter((r) => r.day === day)
    .sort((a, b) => countsOf(b.payload).newPains - countsOf(a.payload).newPains)[0];
  const c = countsOf(best.payload);
  const pains = (best.payload.sessions[0]?.pains ?? []).slice(0, 3).map((p) => ({ title: p.title, isNew: p.isNew, times: p.times }));
  const dl = dayLabels(best.day);
  const headline = pains[0]
    ? `${best.payload.layerLabel}: ${c.newPosts} bài mới, ${c.newPains} nỗi đau mới. Nổi bật: ${pains[0].title}.`
    : `${best.payload.layerLabel}: ${c.newPosts} bài mới, ${c.newPains} nỗi đau mới.`;
  return {
    date: best.day, dateLabel: `${dl.weekday}, ${dl.dateLabel}`, layer: best.layer, layerLabel: best.payload.layerLabel,
    headline, newPosts: c.newPosts, newPains: c.newPains, topPains: pains, link: `/m/radar/${best.day}/${best.layer}`,
  };
}

/** Plain-text block (well under 3000 chars) for agentContext. */
export function summaryForAgent(): string | undefined {
  const s = latestSummary();
  if (!s) return 'Radar thị trường: chưa có báo cáo nào.';
  const lines = [`Radar thị trường, báo cáo mới nhất (${s.dateLabel}, lớp ${s.layerLabel}):`, s.headline];
  for (const p of s.topPains) lines.push(`- ${p.isNew ? '[mới] ' : ''}${p.title} (xuất hiện ${p.times} lần)`);
  lines.push(`Xem đầy đủ: ${s.link}`);
  return lines.join('\n');
}
