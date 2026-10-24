/**
 * Home dashboard (/dashboard): pure helpers that turn the local API answers into what the page shows.
 * Every number on the page comes from one of these sources (all local SQLite, no live third-party call):
 *
 *   /api/attention            what waits on the owner (approvals, failures, drafts…)
 *   /api/dashboard/kpis       agents, mission tasks, month AI spend, 14-day activity (tasks + schedule runs)
 *   /api/care/status          shared inbox: waiting / unread conversations
 *   /api/budgets/spend        AI spend per day and agent (budget ledger, USD)
 *   /api/kol/*                KOL personas and posts (followers live in business-pulse.ts)
 *   /api/fb/content           Facebook Content Studio scheduled posts
 *   /api/tasks                scheduled agent tasks (next run)
 *   /api/radar/reports        latest market-research reports
 *   /api/profit               the owner's profit ledger
 *
 * Nothing here invents a number: a missing source gives `null`, and the page shows an honest empty state.
 */


export const HOME_TZ = 'Asia/Ho_Chi_Minh';
export const HOME_POLL_MS = 30_000;
export const UPCOMING_DAYS = 7;

// ── Formatting ───────────────────────────────────────────────────────

const VI = 'vi-VN';

/** 70900 → "70,9 N"; 1250000 → "1,3 Tr"; null → "—". */
export function fmtCompact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (Math.abs(n) < 10_000) return n.toLocaleString(VI);
  return new Intl.NumberFormat(VI, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

export function fmtInt(n: number | null | undefined): string {
  return n === null || n === undefined || !Number.isFinite(n) ? '—' : Math.round(n).toLocaleString(VI);
}

/** USD with a Vietnamese decimal comma: 3.2469 → "$3,25"; small amounts keep 3 decimals. */
export function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const digits = n !== 0 && Math.abs(n) < 0.1 ? 3 : 2;
  return `$${n.toLocaleString(VI, { minimumFractionDigits: 2, maximumFractionDigits: digits })}`;
}

export function fmtMoney(n: number | null | undefined, currency: string): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return new Intl.NumberFormat(VI, { style: 'currency', currency, maximumFractionDigits: currency === 'VND' ? 0 : 2 }).format(n);
}

/** Local date parts in the home timezone. */
export function localParts(ms: number, tz = HOME_TZ): { y: number; m: number; d: number; h: number; min: number; weekday: number; key: string } {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' });
  const parts = Object.fromEntries(f.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  const y = Number(parts.year), m = Number(parts.month), d = Number(parts.day);
  return { y, m, d, h: Number(parts.hour), min: Number(parts.minute), weekday, key: `${parts.year}-${parts.month}-${parts.day}` };
}

const WEEKDAY_VI = ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy'];

/** "Thứ ba, 20 tháng 10, 2026". */
export function fmtLongDate(ms: number, tz = HOME_TZ): string {
  const p = localParts(ms, tz);
  return `${WEEKDAY_VI[p.weekday]}, ${p.d} tháng ${p.m}, ${p.y}`;
}

export function fmtTime(ms: number, tz = HOME_TZ): string {
  const p = localParts(ms, tz);
  return `${String(p.h).padStart(2, '0')}:${String(p.min).padStart(2, '0')}`;
}

/** Greeting by local hour. */
export function greeting(hour: number): string {
  if (hour >= 5 && hour < 11) return 'Chào buổi sáng';
  if (hour >= 11 && hour < 13) return 'Chào buổi trưa';
  if (hour >= 13 && hour < 18) return 'Chào buổi chiều';
  if (hour >= 18 && hour < 23) return 'Chào buổi tối';
  return 'Khuya rồi';
}

/** "vừa xong", "5 phút trước", "3 giờ trước", "2 ngày trước"; future times → "sau 2 giờ". */
export function fmtRelative(epochSec: number, nowMs = Date.now()): string {
  const diff = Math.round(nowMs / 1000 - epochSec);
  const abs = Math.abs(diff);
  const unit = abs < 60 ? null : abs < 3600 ? `${Math.round(abs / 60)} phút` : abs < 86_400 ? `${Math.round(abs / 3600)} giờ` : `${Math.round(abs / 86_400)} ngày`;
  if (!unit) return 'vừa xong';
  return diff >= 0 ? `${unit} trước` : `sau ${unit}`;
}

/** Day label for a timeline group: "Hôm nay", "Ngày mai", else "Thứ năm 22/10". */
export function dayLabel(ms: number, nowMs = Date.now(), tz = HOME_TZ): string {
  const p = localParts(ms, tz);
  const today = localParts(nowMs, tz).key;
  const tomorrow = localParts(nowMs + 86_400_000, tz).key;
  if (p.key === today) return 'Hôm nay';
  if (p.key === tomorrow) return 'Ngày mai';
  return `${WEEKDAY_VI[p.weekday]} ${p.d}/${p.m}`;
}

// ── Upcoming (next 7 days) ───────────────────────────────────────────

/** The slice of an AIOS-Lite schedule (GET /api/schedules) that the dashboard needs. */
export interface ScheduleLike { id: number; name: string; agentId: string; enabled: boolean; nextRunAt: string | null }

export type UpcomingKind = 'schedule';

export interface UpcomingItem {
  key: string;
  kind: UpcomingKind;
  /** Epoch seconds. */
  at: number;
  title: string;
  sub: string;
  href: string;
}

/** Enabled schedules due within the next `days` days, soonest first. Modules add their own plans through widgets. */
export function upcomingItems(input: { schedules: ScheduleLike[]; agentNames?: Record<string, string>; nowMs?: number; days?: number; limit?: number }): UpcomingItem[] {
  const now = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const until = now + (input.days ?? UPCOMING_DAYS) * 86_400;
  const out: UpcomingItem[] = [];
  for (const s of input.schedules) {
    if (!s.enabled || !s.nextRunAt) continue;
    const at = Math.floor(Date.parse(s.nextRunAt) / 1000);
    if (!Number.isFinite(at) || at < now - 300 || at > until) continue;
    out.push({ key: `schedule:${s.id}`, kind: 'schedule', at, title: s.name, sub: `Lịch định kỳ · ${input.agentNames?.[s.agentId] ?? s.agentId}`, href: '/schedules' });
  }
  return out.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key)).slice(0, input.limit ?? 8);
}

/** Groups upcoming items by local day, keeping order. */
export function groupByDay<T extends { at: number }>(items: T[], nowMs = Date.now(), tz = HOME_TZ): { label: string; items: T[] }[] {
  const groups: { label: string; items: T[] }[] = [];
  for (const it of items) {
    const label = dayLabel(it.at * 1000, nowMs, tz);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(it);
    else groups.push({ label, items: [it] });
  }
  return groups;
}

// ── Spend ────────────────────────────────────────────────────────────

export interface SpendRowLike { day: string; agentId: string; costUsd: number; turns: number }

/** One value per local day for the last `days` days (oldest first), zero-filled. */
export function spendByDay(rows: SpendRowLike[], days: number, nowMs = Date.now(), tz = HOME_TZ): { day: string; usd: number }[] {
  const sums = new Map<string, number>();
  for (const r of rows) sums.set(r.day, (sums.get(r.day) ?? 0) + (Number.isFinite(r.costUsd) ? r.costUsd : 0));
  const out: { day: string; usd: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = localParts(nowMs - i * 86_400_000, tz).key;
    out.push({ day: key, usd: Math.round((sums.get(key) ?? 0) * 1e6) / 1e6 });
  }
  return out;
}

/** Spend per agent over the rows, largest first. */
export function spendByAgent(rows: SpendRowLike[]): { agentId: string; usd: number; turns: number }[] {
  const m = new Map<string, { usd: number; turns: number }>();
  for (const r of rows) {
    const cur = m.get(r.agentId) ?? { usd: 0, turns: 0 };
    cur.usd += Number.isFinite(r.costUsd) ? r.costUsd : 0;
    cur.turns += r.turns || 0;
    m.set(r.agentId, cur);
  }
  return [...m.entries()].map(([agentId, v]) => ({ agentId, usd: Math.round(v.usd * 1e6) / 1e6, turns: v.turns })).sort((a, b) => b.usd - a.usd);
}

/** Display name for a spend agent id. */
export function spendAgentLabel(agentId: string, names: Record<string, string> = {}): string {
  if (agentId === '*') return 'Tất cả';
  return names[agentId] ?? agentId;
}

// ── Status line ──────────────────────────────────────────────────────

/** One sentence under the greeting: what needs the owner, how the agents are doing, today's plan. */
export function statusLine(s: {
  needsYou: number | null;
  agentsRunning: number | null;
  agentsTotal: number | null;
  tasksRunning: number | null;
  upcomingToday: number;
  careWaiting: number | null;
}): string[] {
  const parts: string[] = [];
  if (s.needsYou !== null) parts.push(s.needsYou === 0 ? 'Không có việc nào chờ bạn' : `${s.needsYou} việc cần bạn xử lý`);
  if (s.careWaiting) parts.push(`${s.careWaiting} khách đang chờ trả lời`);
  if (s.agentsRunning !== null && s.agentsTotal !== null) {
    parts.push(`${s.agentsRunning}/${s.agentsTotal} agent trực tuyến${s.tasksRunning ? ` · ${s.tasksRunning} việc đang chạy` : ''}`);
  }
  parts.push(s.upcomingToday ? `${s.upcomingToday} mục trong lịch hôm nay` : 'Lịch hôm nay trống');
  return parts;
}

// ── Activity ─────────────────────────────────────────────────────────

export interface ActivityDay { day: string; succeeded: number; failed: number }

/** Totals and the success rate (null when nothing ran) over the activity window. */
export function activityTotals(days: ActivityDay[]): { succeeded: number; failed: number; total: number; rate: number | null } {
  const succeeded = days.reduce((s, d) => s + d.succeeded, 0);
  const failed = days.reduce((s, d) => s + d.failed, 0);
  const total = succeeded + failed;
  return { succeeded, failed, total, rate: total ? Math.round((succeeded / total) * 100) : null };
}
