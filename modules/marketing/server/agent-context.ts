// Short data block for agents that hold a marketing scope (ModuleDefinition.agentContext).
import { loadChannelDashboard } from './analytics/service.js';
import { formatLocal } from './core/time.js';
import { isFbStudioEnabled } from './settings.js';
import { parsePillars } from './core/dto.js';
import { getFbPage, getNextScheduledFbContent, listFbAnalyticsPages, listFbCalendarRows } from './store.js';

const MAX_CHARS = 3000;
const MAX_PAGES = 8;
const MAX_SCHEDULED = 5;
const nowSec = (): number => Math.floor(Date.now() / 1000);

const PAGE_LINE_MAX = 200;
const clip = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/** One short line: brand voice, pillars and posting window (clipped). */
function styleLine(pageId: string): string {
  const p = getFbPage(pageId);
  if (!p) return '';
  const pillars = parsePillars(p.pillars_json).map((x) => `${x.name} ${x.targetPct}%`).join(', ');
  const voice = p.brand_voice.replace(/\s+/g, ' ').trim();
  return clip(`  giọng: ${voice || '(chưa đặt)'} | tuyến: ${pillars || '(chưa đặt)'} | giờ đăng ${p.window_start}-${p.window_end} (${p.timezone})`, PAGE_LINE_MAX);
}

const fmt = (n: number | null | undefined, digits = 0): string => (n === null || n === undefined ? '?' : n.toFixed(digits));

export function buildAgentContext(scopes: string[], now: number = nowSec()): string | undefined {
  if (!isFbStudioEnabled()) return undefined;
  const pages = listFbAnalyticsPages({ enabledOnly: true }).slice(0, MAX_PAGES);
  if (pages.length === 0) return undefined;
  const lines: string[] = ['Fanpage đang bật:'];
  if (scopes.includes('analytics.read')) {
    for (const p of pages) {
      lines.push(`- ${p.name} (id ${p.id})`);
      if (scopes.includes('content.write')) lines.push(styleLine(p.id));
      const d = loadChannelDashboard(p.id, 7, now);
      if (!d || d.posts === 0) { lines.push('  7 ngày qua: chưa có bài hoặc số liệu.'); continue; }
      const kpi = (key: string) => d.kpis.find((k) => k.key === key)?.value ?? null;
      lines.push(`  7 ngày qua: ${d.posts} bài, reach ${fmt(kpi('reach'))}, ER ${fmt(kpi('er'), 2)}%, bình luận/bài ${fmt(kpi('commentsPerPost'), 1)}`);
      for (const t of d.top.slice(0, 3)) lines.push(`  top: ${t.postId} "${(t.title || '').slice(0, 50)}" (${t.format}, ER ${fmt(t.er, 2)}%)`);
    }
  } else {
    for (const p of pages) {
      lines.push(`- ${p.name} (id ${p.id})`);
      if (scopes.includes('content.write')) lines.push(styleLine(p.id));
    }
  }
  if (scopes.includes('content.write') && !scopes.includes('analytics.read')) {
    const rows = listFbCalendarRows(now, now + 60 * 86400).filter((r) => r.status === 'scheduled').sort((a, b) => (a.scheduled_at ?? 0) - (b.scheduled_at ?? 0)).slice(0, MAX_SCHEDULED);
    if (rows.length === 0 && !getNextScheduledFbContent()) lines.push('Chưa có bài nào hẹn giờ.');
    else {
      lines.push('Bài sắp đăng:');
      for (const r of rows) lines.push(`- #${r.id} ${formatLocal(r.scheduled_at as number, 'Asia/Ho_Chi_Minh')} "${(r.title || r.caption).slice(0, 50)}"`);
    }
  }
  return lines.join('\n').slice(0, MAX_CHARS);
}
