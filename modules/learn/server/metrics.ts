// The two "is the team getting better" measures, by ISO week (Monday to Sunday, Vietnam time by default):
//   1. median ER of the Facebook posts published that week, at one milestone (from the bai-dang notes);
//   2. share of bot reply drafts sent as written ("nháp gửi nguyên"), from care's draftStats read function.
// All pure except the care call, which goes through care's `provides` (learn never reads care's tables).
import { DEFAULT_TZ, localDate } from './note-format.js';
import { erAt, median, type NoteInput } from './stats.js';

export interface IsoWeek {
  year: number;
  week: number;
}

export interface WeekRange extends IsoWeek {
  /** Monday, YYYY-MM-DD */
  from: string;
  /** Sunday, YYYY-MM-DD */
  to: string;
  /** epoch seconds of Monday 00:00 and of the next Monday 00:00 in the timezone */
  startSec: number;
  endSec: number;
}

/** care's provides.draftStats (modules/care/server/draft-stats.ts) */
export interface DraftStats {
  botDrafts: number;
  sentUnchanged: number;
  sentEdited: number;
  discarded: number;
  notDelivered: number;
  open: number;
  unchangedRate: number | null;
}
export type DraftStatsFn = (range: { fromMs: number; toMs: number }) => DraftStats;

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const parseYmd = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!));
};

/** ISO 8601 week of a calendar date. */
export function isoWeekOf(date: string): IsoWeek {
  const d = parseYmd(date);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day); // Thursday of this week decides the year
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return { year: d.getUTCFullYear(), week: Math.ceil(((d.getTime() - yearStart) / 86400000 + 1) / 7) };
}

/** Offset of the timezone from UTC at an instant, in ms. */
function tzOffsetMs(ms: number, tz: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(ms)).map((x) => [x.type, x.value]),
  );
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Epoch seconds of 00:00 of a date in the timezone. */
export function zonedMidnight(date: string, tz = DEFAULT_TZ): number {
  const guess = parseYmd(date).getTime();
  let t = guess - tzOffsetMs(guess, tz);
  t = guess - tzOffsetMs(t, tz); // once more across a DST change
  return Math.floor(t / 1000);
}

export function weekRange(w: IsoWeek, tz = DEFAULT_TZ): WeekRange {
  const jan4 = new Date(Date.UTC(w.year, 0, 4));
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() || 7) - 1) + (w.week - 1) * 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const next = new Date(monday);
  next.setUTCDate(monday.getUTCDate() + 7);
  return { ...w, from: ymd(monday), to: ymd(sunday), startSec: zonedMidnight(ymd(monday), tz), endSec: zonedMidnight(ymd(next), tz) };
}

/** The week before the one `nowSec` falls in (the last complete week). */
export function lastCompleteWeek(nowSec: number, tz = DEFAULT_TZ): WeekRange {
  const today = parseYmd(localDate(nowSec, tz));
  today.setUTCDate(today.getUTCDate() - 7);
  return weekRange(isoWeekOf(ymd(today)), tz);
}

export function previousWeek(w: IsoWeek, tz = DEFAULT_TZ): WeekRange {
  const r = weekRange(w, tz);
  const d = parseYmd(r.from);
  d.setUTCDate(d.getUTCDate() - 7);
  return weekRange(isoWeekOf(ymd(d)), tz);
}

/** The `count` weeks ending with the one `nowSec` falls in, oldest first. */
export function recentWeeks(nowSec: number, count: number, tz = DEFAULT_TZ): WeekRange[] {
  let w = weekRange(isoWeekOf(localDate(nowSec, tz)), tz);
  const out = [w];
  while (out.length < count) {
    w = previousWeek(w, tz);
    out.unshift(w);
  }
  return out;
}

/** The local date of a post (from `dang_luc`, already in the Page's time). */
function postDate(data: Record<string, unknown>): string | null {
  const m = typeof data.dang_luc === 'string' ? data.dang_luc.match(/^(\d{4}-\d{2}-\d{2})/) : null;
  return m ? m[1]! : null;
}

export function postsInWeek(posts: readonly NoteInput[], w: WeekRange, platform = 'facebook'): NoteInput[] {
  return posts.filter((p) => {
    if (p.data.loai !== 'bai-dang' || p.data.nen_tang !== platform) return false;
    const d = postDate(p.data);
    return d !== null && d >= w.from && d <= w.to;
  });
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export interface WeekPoint {
  year: number;
  week: number;
  from: string;
  to: string;
  /** posts published that week */
  posts: number;
  /** of those, measured at the milestone */
  measured: number;
  medianEr: number | null;
  /** care drafts; null when care is not enabled */
  drafts: DraftStats | null;
  /** the week `nowSec` is in */
  running: boolean;
}

export function weekPoint(posts: readonly NoteInput[], w: WeekRange, moc: string, drafts: DraftStatsFn | undefined, running = false): WeekPoint {
  const list = postsInWeek(posts, w);
  const vals = list.map((p) => erAt(p.data, moc)).filter((v): v is number => v !== null);
  const m = median(vals);
  return {
    year: w.year, week: w.week, from: w.from, to: w.to, posts: list.length, measured: vals.length,
    medianEr: m === null ? null : round2(m),
    drafts: drafts ? drafts({ fromMs: w.startSec * 1000, toMs: w.endSec * 1000 }) : null,
    running,
  };
}

/** ER median and draft rate for the last `count` weeks (the current one last, marked running). */
export function weeklySeries(posts: readonly NoteInput[], opts: { nowSec: number; count?: number; moc: string; drafts?: DraftStatsFn; tz?: string }): WeekPoint[] {
  const weeks = recentWeeks(opts.nowSec, opts.count ?? 8, opts.tz);
  return weeks.map((w, i) => weekPoint(posts, w, opts.moc, opts.drafts, i === weeks.length - 1));
}
