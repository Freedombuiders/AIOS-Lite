/**
 * Per-Page worker state kept in fb_settings: when auto-reply was first
 * enabled (the backlog cut-off), last poll times and one-shot notification flags.
 */

import { getFbSetting, setFbSetting } from '../store.js';

const nowSec = (): number => Math.floor(Date.now() / 1000);

function getNumber(key: string): number | null {
  const raw = getFbSetting(key);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Unix seconds when auto-reply was first enabled for the Page; comments created earlier are backlog. */
export function getAutoReplySince(pageId: string): number | null {
  return getNumber(`comments_since:${pageId}`);
}

export function ensureAutoReplySince(pageId: string, at: number = nowSec()): number {
  const existing = getAutoReplySince(pageId);
  if (existing) return existing;
  setFbSetting(`comments_since:${pageId}`, String(at));
  return at;
}

/** Called when the Page or its rules are switched off: the next enable starts a fresh cut-off. */
export function clearAutoReplySince(pageId: string): void {
  if (getAutoReplySince(pageId)) setFbSetting(`comments_since:${pageId}`, '');
}

export function getLastPollAt(pageId: string): number | null {
  return getNumber(`comments_last_poll:${pageId}`);
}

export function getAnyLastPollAt(): number | null {
  return getNumber('comments_last_poll_at');
}

export function setLastPollAt(pageId: string, at: number = nowSec()): void {
  setFbSetting(`comments_last_poll:${pageId}`, String(at));
  setFbSetting('comments_last_poll_at', String(at));
}

/** True the first time for `key`; false afterwards until `resetOnce(key)`. */
export function claimOnce(key: string): boolean {
  const k = `comments_once:${key}`;
  if (getFbSetting(k) === '1') return false;
  setFbSetting(k, '1');
  return true;
}

export function resetOnce(key: string): void {
  const k = `comments_once:${key}`;
  if (getFbSetting(k) === '1') setFbSetting(k, '0');
}
