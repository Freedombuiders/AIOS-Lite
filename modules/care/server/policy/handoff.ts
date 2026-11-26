/**
 * T06 hard handoff rule: a live customer message that contains one of the configured phrases ("gặp nhân viên"...)
 * hands the conversation to the owner. Pure helpers only; the state change happens in ingest (same transaction that
 * stores the message), see application/conversation-hold.ts.
 *
 * Matching is case- and diacritic-insensitive (`foldVietnamese`, the folding the other keyword gates use) and the
 * phrase must start at a word boundary, so "CHO TOI GAP NHAN VIEN" and "cho tôi gặp nhân viên" both match.
 */

import { matchKeywordAtWordStart, stripQuotedReply } from './text-heuristics.js';

export const DEFAULT_HANDOFF_KEYWORDS: readonly string[] = Object.freeze(['gặp nhân viên', 'gặp người thật', 'khiếu nại']);
export const DEFAULT_HANDOFF_PAUSE_MINUTES = 60;
/** A pause longer than this is a unit error, not a plan. */
export const MAX_HANDOFF_PAUSE_MINUTES = 7 * 24 * 60;

export interface HandoffPolicy {
  keywords: readonly string[];
  pauseMinutes: number;
}

export const DEFAULT_HANDOFF_POLICY: HandoffPolicy = Object.freeze({
  keywords: DEFAULT_HANDOFF_KEYWORDS,
  pauseMinutes: DEFAULT_HANDOFF_PAUSE_MINUTES,
});

/**
 * Module setting -> keyword list. Accepts a comma / semicolon / newline separated string or a string array. Absent
 * (undefined/null) means the defaults; an explicitly empty value switches the rule off.
 */
export function parseHandoffKeywords(value: unknown): string[] {
  if (value === undefined || value === null) return [...DEFAULT_HANDOFF_KEYWORDS];
  const parts = Array.isArray(value) ? value.map((v) => String(v)) : String(value).split(/[,;\n]/);
  const out: string[] = [];
  for (const p of parts) {
    const k = p.trim().replace(/\s+/g, ' ').slice(0, 80);
    if (k && !out.includes(k)) out.push(k);
    if (out.length >= 50) break;
  }
  return out;
}

/** Module setting -> pause minutes (whole minutes, 1 .. 7 days). Anything unusable falls back to the default. */
export function parseHandoffPauseMinutes(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_HANDOFF_PAUSE_MINUTES;
  return Math.min(Math.floor(n), MAX_HANDOFF_PAUSE_MINUTES);
}

/**
 * The configured keyword the customer text contains, or null. Email: subject + the new part of the body only
 * (quoted history never triggers a handoff).
 */
export function matchHandoffKeyword(input: { text: string; subject?: string | null; email?: boolean }, keywords: readonly string[]): string | null {
  if (keywords.length === 0) return null;
  const body = input.email ? stripQuotedReply(input.text ?? '') : input.text ?? '';
  const text = [input.subject ?? '', body].filter(Boolean).join('\n');
  if (!text.trim()) return null;
  return matchKeywordAtWordStart(text, keywords);
}
