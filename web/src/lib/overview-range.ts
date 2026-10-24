// The period switch on Tổng quan: 7 / 30 / 90 days ending today (Vietnam time), plus the same span just before it.
import type { OverviewRange } from '@/module-host/contracts';
import { localParts } from './home-dashboard';

export const OVERVIEW_DAYS = [7, 30, 90] as const;
export type OverviewDays = (typeof OVERVIEW_DAYS)[number];
export const OVERVIEW_DAYS_KEY = 'aios.overview.days';


export function parseOverviewDays(v: unknown): OverviewDays {
  const n = Number(v);
  return (OVERVIEW_DAYS as readonly number[]).includes(n) ? (n as OverviewDays) : 30;
}

/** Shift a YYYY-MM-DD date by whole days (calendar math in UTC, so no DST or offset drift). */
export function addDays(date: string, delta: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + delta)).toISOString().slice(0, 10);
}

export function overviewRange(days: number, nowMs = Date.now()): OverviewRange {
  const to = localParts(nowMs).key;
  const from = addDays(to, -(days - 1));
  return { days, from, to, prevTo: addDays(from, -1), prevFrom: addDays(from, -days) };
}

/** Every date of the range, oldest first. */
export function rangeDates(range: Pick<OverviewRange, 'from' | 'to'>): string[] {
  const out: string[] = [];
  for (let d = range.from; d <= range.to && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out;
}

