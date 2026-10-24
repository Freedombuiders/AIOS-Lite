/**
 * Pure window / checkpoint helpers of the Gmail connector (no I/O).
 *
 * Coverage model (frozen with the legacy `src/email/sync.ts`): an explicit query window with
 * ABSOLUTE epoch-second bounds fixed when it opens, so a resume on a later day, a token restart
 * or newly arrived mail never moves it. `covered` (seconds) only advances to a window's end once
 * every page of that window was read AND stored. Epoch SECONDS here are Gmail query bounds;
 * everything that crosses into Care (`sentAtMs`, event timestamps) is MILLISECONDS.
 */

import crypto from 'node:crypto';

export const GMAIL_BOX = 'gmail_mailbox' as const;

export const FIRST_SYNC_PAGE_SIZE = 50;
export const POLL_PAGE_SIZE = 25;
export const DEFAULT_MAX_PAGES = 4;
/** Re-read this much before the covered cursor: Gmail's `after:` is coarse and mail can land late. */
export const CURSOR_OVERLAP_SEC = 600;

export type WindowKind = 'backfill' | 'poll' | 'full_backfill';

/** Durable state of one open window (page token included; the token is opaque and not sensitive). */
export interface WindowState {
  kind: WindowKind;
  query: string;
  pageSize: number;
  /** Inclusive upper bound in seconds (the query uses `before:<end + 1>`). */
  endSec: number;
  /** `after:` bound in seconds. */
  lowerSec: number;
  /** Token of the NEXT page to fetch (null = first page). */
  pageToken: string | null;
  pagesDone: number;
  restarts: number;
  startedSec: number;
}

/** Query for a window opened at `startSec` (same arithmetic as the legacy `windowQuery`). */
export function buildWindowQuery(lowerSec: number, startSec: number): string {
  return `after:${Math.max(0, lowerSec)} before:${startSec + 1} {in:inbox in:sent}`;
}

export interface OpenWindowInput {
  coveredSec: number | null;
  backfillDays: number;
  startSec: number;
  fullBackfill?: boolean;
}

export function openWindowState(input: OpenWindowInput): WindowState {
  const { coveredSec, backfillDays, startSec } = input;
  const first = coveredSec == null;
  const full = input.fullBackfill === true;
  const lower = full || first ? startSec - backfillDays * 86400 : (coveredSec as number) - CURSOR_OVERLAP_SEC;
  return {
    kind: full ? 'full_backfill' : first ? 'backfill' : 'poll',
    query: buildWindowQuery(lower, startSec),
    pageSize: full || first ? FIRST_SYNC_PAGE_SIZE : POLL_PAGE_SIZE,
    endSec: startSec,
    lowerSec: Math.max(0, lower),
    pageToken: null,
    pagesDone: 0,
    restarts: 0,
    startedSec: startSec,
  };
}

// ── checkpoint cursor ─────────────────────────────────────────────────────────────────────────

/**
 * Compact, parseable mirror of the mailbox position that rides on Care's checkpoint:
 *   `gm1.<covered|->.<windowEnd|0>.<lower|0>.<step>`
 * Page tokens are NOT in the cursor (they can be long); a connector that lost its own store
 * rebuilds the window query from the cursor and restarts at page one, which is always safe.
 */
export interface MailboxCursor {
  coveredSec: number | null;
  windowEndSec: number;
  windowLowerSec: number;
  step: number;
}

export function encodeCursor(c: MailboxCursor): string {
  return `gm1.${c.coveredSec == null ? '-' : c.coveredSec}.${c.windowEndSec}.${c.windowLowerSec}.${c.step}`;
}

export function decodeCursor(cursor: string | undefined | null): MailboxCursor | null {
  if (typeof cursor !== 'string') return null;
  const m = /^gm1\.(-|\d{1,12})\.(\d{1,12})\.(\d{1,12})\.(\d{1,12})$/.exec(cursor);
  if (!m) return null;
  return {
    coveredSec: m[1] === '-' ? null : Number(m[1]),
    windowEndSec: Number(m[2]),
    windowLowerSec: Number(m[3]),
    step: Number(m[4]),
  };
}

/**
 * Causal position: covered, then window end, then a per-mailbox step that only grows. Completing a
 * window raises `covered` past anything the window could have had; opening one raises the end.
 */
export function cursorPosition(c: MailboxCursor): string {
  return `${c.coveredSec ?? 0}.${c.windowEndSec}.${c.step}`;
}

export function sha256(parts: unknown): string {
  return crypto.createHash('sha256').update(typeof parts === 'string' ? parts : JSON.stringify(parts)).digest('hex');
}

/** Hash of reply text, whitespace-normalised: only used to RECOGNISE our own echo, never as a retry guarantee. */
export function textHash(text: string): string {
  return sha256(text.replace(/\s+/g, ' ').trim());
}

/** Next top-of-hour in ms: the earliest a shared hourly budget can have room again. */
export function nextHourMs(nowMs: number): number {
  const hour = 3_600_000;
  return nowMs - (nowMs % hour) + hour;
}
