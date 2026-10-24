/**
 * When things are due: post milestones, the 02:00 local sweep and the 07:00
 * local Analyst run. Pure functions of (now, timezone, markers).
 */

import type { Milestone } from '../types.js';
import { localDay, localParts } from './time.js';

export const MILESTONES: { key: Milestone; seconds: number }[] = [
  { key: '1h', seconds: 3600 },
  { key: '6h', seconds: 6 * 3600 },
  { key: '24h', seconds: 24 * 3600 },
  { key: '3d', seconds: 3 * 86400 },
  { key: '7d', seconds: 7 * 86400 },
  { key: '28d', seconds: 28 * 86400 },
];

export const MILESTONE_KEYS: Milestone[] = MILESTONES.map((m) => m.key);

/** A milestone later than this many times its age is skipped (the post has moved on). */
export const MAX_LATE_FACTOR = 2;

export const SWEEP_HOUR = 2;
export const ANALYST_HOUR = 7;
/** Posts younger than this get a 'latest' snapshot in the daily sweep. */
export const SWEEP_POST_DAYS = 28;
/** Older posts up to this age get one snapshot if they never had any (previous period of a 28 day view). */
export const BACKFILL_DAYS = 56;
/** First import reaches this far back. */
export const IMPORT_DAYS = 90;

/** The oldest post age (seconds) that can still be due for any milestone. */
export const MAX_MILESTONE_AGE_SEC = 28 * 86400 * MAX_LATE_FACTOR;

/**
 * The milestone to capture now for a post, or null. A milestone is due when
 * the post is at least that old and not more than 2× that old; the windows
 * never overlap, so at most one is due at any time.
 */
export function dueMilestone(publishedAt: number, now: number, captured: ReadonlySet<string>): Milestone | null {
  const age = now - publishedAt;
  if (age < 0) return null;
  for (const m of MILESTONES) {
    if (age >= m.seconds && age <= m.seconds * MAX_LATE_FACTOR && !captured.has(m.key)) return m.key;
  }
  return null;
}

/** Local 02:00 sweep: due once per local day, from 02:00 on (catches up after downtime). */
export function isSweepDue(now: number, tz: string, lastSweepDay: string | undefined): boolean {
  if (localParts(now, tz).hour < SWEEP_HOUR) return false;
  return lastSweepDay !== localDay(now, tz);
}

/**
 * Analyst: once per local day, from 07:00 on, and only after today's sweep has
 * run so the tables it explains are fresh.
 */
export function isAnalystDue(
  now: number,
  tz: string,
  lastAnalystDay: string | undefined,
  lastSweepDay: string | undefined,
): boolean {
  const today = localDay(now, tz);
  if (localParts(now, tz).hour < ANALYST_HOUR) return false;
  if (lastSweepDay !== today) return false;
  return lastAnalystDay !== today;
}

/** Manual refresh allowed at most once per this many seconds per Page. */
export const REFRESH_MIN_INTERVAL_SEC = 600;

export function refreshWaitSec(now: number, lastRefreshAt: number | null | undefined): number {
  if (!lastRefreshAt) return 0;
  return Math.max(0, lastRefreshAt + REFRESH_MIN_INTERVAL_SEC - now);
}
