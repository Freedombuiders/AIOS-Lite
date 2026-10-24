import { describe, expect, it } from 'vitest';

import {
  GRACE_SEC,
  MAX_ATTEMPTS,
  canApprove,
  canCancel,
  canEdit,
  canPublishNow,
  canReturn,
  canSubmit,
  checkSchedule,
  derivePostStatus,
  formatProblems,
  insideWindow,
  isPastGrace,
  isShort,
  isTransientMessage,
  isUncertainMessage,
  nextAfterTransientFailure,
  proposeSlot,
  type AccountRules,
  type MediaFacts,
} from './schedule-rules.js';

const T0 = Date.UTC(2026, 9, 20, 5, 0, 0) / 1000; // 12:00 in Vietnam (UTC+7)
const MIN = 60;
const HOUR = 3600;

const rules = (over: Partial<AccountRules> = {}): AccountRules => ({
  label: 'Instagram @mai.ai',
  timezone: 'Asia/Ho_Chi_Minh',
  maxPostsPerDay: 2,
  minGapMinutes: 180,
  windowStart: '08:00',
  windowEnd: '22:00',
  ...over,
});

const img = (w = 1080, h = 1350): MediaFacts => ({ kind: 'image', width: w, height: h, durationSec: null });
const vid = (w = 1080, h = 1920, d: number | null = 20): MediaFacts => ({ kind: 'video', width: w, height: h, durationSec: d });

describe('state machine', () => {
  it('allows each action only from the right statuses', () => {
    expect(canSubmit('draft')).toBe(true);
    expect(canSubmit('review')).toBe(false);
    expect(canApprove('review')).toBe(true);
    expect(canApprove('failed')).toBe(true);
    expect(canApprove('published')).toBe(false);
    expect(canReturn('scheduled')).toBe(true);
    expect(canReturn('draft')).toBe(false);
    expect(canEdit('scheduled')).toBe(true);
    expect(canEdit('publishing')).toBe(false);
    expect(canEdit('published')).toBe(false);
    expect(canPublishNow('approved')).toBe(true);
    expect(canPublishNow('partial')).toBe(true);
    expect(canPublishNow('review')).toBe(false);
    expect(canCancel('publishing')).toBe(false);
    expect(canCancel('published')).toBe(true);
  });
});

describe('derivePostStatus', () => {
  it('keeps authoring statuses while every target is pending', () => {
    expect(derivePostStatus('review', ['pending', 'pending'])).toBe('review');
    expect(derivePostStatus('draft', [])).toBe('draft');
    expect(derivePostStatus('scheduled', ['pending'])).toBe('draft');
  });
  it('scheduled, publishing, published, partial, failed', () => {
    expect(derivePostStatus('approved', ['scheduled', 'scheduled'])).toBe('scheduled');
    expect(derivePostStatus('scheduled', ['publishing', 'scheduled'])).toBe('publishing');
    expect(derivePostStatus('scheduled', ['processing', 'published'])).toBe('publishing');
    expect(derivePostStatus('scheduled', ['published', 'scheduled'])).toBe('publishing');
    expect(derivePostStatus('publishing', ['published', 'published'])).toBe('published');
    expect(derivePostStatus('publishing', ['published', 'failed'])).toBe('partial');
    expect(derivePostStatus('publishing', ['published', 'missed'])).toBe('partial');
    expect(derivePostStatus('publishing', ['failed', 'missed'])).toBe('failed');
  });
  it('ignores skipped targets and never leaves cancelled', () => {
    expect(derivePostStatus('publishing', ['published', 'skipped'])).toBe('published');
    expect(derivePostStatus('cancelled', ['published'])).toBe('cancelled');
    expect(derivePostStatus('review', ['skipped'])).toBe('review');
  });
});

describe('formatProblems', () => {
  it('TikTok and YouTube need exactly one video', () => {
    expect(formatProblems('tiktok', 'reel', [vid()])).toEqual([]);
    expect(formatProblems('youtube', 'video', [vid(1920, 1080, 600)])).toEqual([]);
    expect(formatProblems('tiktok', 'photo', [img()])[0]).toMatch(/TikTok chỉ đăng video/);
    expect(formatProblems('youtube', 'reel', [vid(), vid()])[0]).toMatch(/đúng 1 video/);
    expect(formatProblems('tiktok', 'reel', [vid(), img()])[0]).toMatch(/không kèm ảnh/);
  });
  it('Instagram: photo 1 image, carousel 2–10 images, reel 1 video, no text', () => {
    expect(formatProblems('instagram', 'photo', [img()])).toEqual([]);
    expect(formatProblems('instagram', 'photo', [img(), img()])[0]).toMatch(/Carousel/);
    expect(formatProblems('instagram', 'photo', [])[0]).toMatch(/đúng 1 ảnh/);
    expect(formatProblems('instagram', 'carousel', [img()])[0]).toMatch(/2 đến 10/);
    expect(formatProblems('instagram', 'carousel', Array.from({ length: 11 }, () => img()))[0]).toMatch(/2 đến 10/);
    expect(formatProblems('instagram', 'carousel', Array.from({ length: 10 }, () => img()))).toEqual([]);
    expect(formatProblems('instagram', 'reel', [vid()])).toEqual([]);
    expect(formatProblems('instagram', 'reel', [img()])[0]).toMatch(/Reel/);
    expect(formatProblems('instagram', 'reel', [vid(1080, 1920, 2)])[0]).toMatch(/3 giây/);
    expect(formatProblems('instagram', 'text', [], 'hello')[0]).toMatch(/chỉ có chữ/);
  });
  it('Facebook takes every format', () => {
    expect(formatProblems('facebook', 'text', [], 'Xin chào')).toEqual([]);
    expect(formatProblems('facebook', 'text', [], '  ')[0]).toMatch(/cần có nội dung/);
    expect(formatProblems('facebook', 'photo', [img(), img()])).toEqual([]);
    expect(formatProblems('facebook', 'carousel', [img()])[0]).toMatch(/2 ảnh/);
    expect(formatProblems('facebook', 'reel', [vid()])).toEqual([]);
    expect(formatProblems('facebook', 'video', [])[0]).toMatch(/1 video/);
  });
  it('refuses audio files everywhere', () => {
    expect(formatProblems('facebook', 'reel', [vid(), { kind: 'audio', width: null, height: null, durationSec: 5 }])[0]).toMatch(/âm thanh/);
  });
  it('isShort: vertical and at most 3 minutes', () => {
    expect(isShort({ width: 1080, height: 1920, durationSec: 180 })).toBe(true);
    expect(isShort({ width: 1080, height: 1920, durationSec: 181 })).toBe(false);
    expect(isShort({ width: 1920, height: 1080, durationSec: 30 })).toBe(false);
    expect(isShort(undefined)).toBe(false);
  });
});

describe('checkSchedule', () => {
  it('accepts a time inside the window with room', () => {
    expect(checkSchedule(rules(), T0 + HOUR, T0, [])).toEqual({ ok: true, reason: '' });
  });

  it('refuses the past (but publish-now is "now")', () => {
    expect(checkSchedule(rules(), T0 - MIN, T0, []).ok).toBe(false);
    expect(checkSchedule(rules(), T0, T0, [], { publishNow: true }).ok).toBe(true);
  });

  it('uses the account timezone for the window and names the account', () => {
    // 23:30 Vietnam = 16:30 UTC.
    const late = Date.UTC(2026, 9, 20, 16, 30) / 1000;
    const v = checkSchedule(rules(), late, T0, []);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('Tài khoản Instagram @mai.ai');
    expect(v.reason).toContain('23:30');
    expect(v.reason).toContain('08:00–22:00');
    // Same instant is 18:30 in Paris (UTC+2 in October): inside the window there.
    expect(checkSchedule(rules({ timezone: 'Europe/Paris' }), late, T0, []).ok).toBe(true);
  });

  it('handles an overnight window', () => {
    const r = rules({ windowStart: '20:00', windowEnd: '02:00' });
    expect(insideWindow(r, Date.UTC(2026, 9, 20, 17, 30) / 1000)).toBe(true); // 00:30 local
    expect(insideWindow(r, Date.UTC(2026, 9, 20, 13, 0) / 1000)).toBe(true); // 20:00 local, the start
    expect(insideWindow(r, Date.UTC(2026, 9, 20, 12, 59) / 1000)).toBe(false); // 19:59 local
  });

  it('enforces the minimum gap against other targets', () => {
    const v = checkSchedule(rules(), T0 + 2 * HOUR, T0, [T0 + HOUR]);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/chỉ 60 phút, cần tối thiểu 180 phút/);
    expect(checkSchedule(rules(), T0 + 4 * HOUR, T0, [T0 + HOUR]).ok).toBe(true);
  });

  it('counts posts per LOCAL day for maxPostsPerDay', () => {
    // 09:00 and 11:00 local on the 21st; 23:00 UTC on the 20th is 06:00 local on the 21st.
    const d21_09 = Date.UTC(2026, 9, 21, 2, 0) / 1000;
    const d21_11 = Date.UTC(2026, 9, 21, 4, 0) / 1000;
    const r = rules({ minGapMinutes: 0 });
    const v = checkSchedule(r, Date.UTC(2026, 9, 21, 10, 0) / 1000, T0, [d21_09, d21_11]);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/đã đủ 2 bài/);
    // The 20th (local) has room even though the UTC date differs.
    expect(checkSchedule(r, Date.UTC(2026, 9, 20, 14, 0) / 1000, T0, [d21_09, d21_11]).ok).toBe(true);
  });

  it('publish-now skips window and gap but not the daily cap', () => {
    const night = Date.UTC(2026, 9, 20, 17, 0) / 1000; // 00:00 local on the 21st
    expect(checkSchedule(rules(), night, night, [night - 10 * MIN], { publishNow: true }).ok).toBe(true);
    const full = checkSchedule(rules({ maxPostsPerDay: 1 }), night, night, [night + 5 * HOUR], { publishNow: true });
    expect(full.ok).toBe(false);
  });

  it('0 = unlimited posts per day', () => {
    expect(checkSchedule(rules({ maxPostsPerDay: 0, minGapMinutes: 0 }), T0 + HOUR, T0, [T0 + 2 * HOUR, T0 + 3 * HOUR]).ok).toBe(true);
  });
});

describe('proposeSlot', () => {
  it('returns the preferred time when it fits every account', () => {
    expect(proposeSlot([{ rules: rules(), others: [] }], T0, T0 + 86_400, T0, T0 + 2 * HOUR)).toBe(T0 + 2 * HOUR);
  });
  it('finds the next time that fits all accounts (window, gap)', () => {
    const a = { rules: rules(), others: [T0 + HOUR] };
    const b = { rules: rules({ label: 'TikTok @mai', minGapMinutes: 60 }), others: [T0 + 4 * HOUR] };
    const slot = proposeSlot([a, b], T0, T0 + 86_400, T0, T0 + HOUR);
    expect(slot).not.toBeNull();
    expect(checkSchedule(a.rules, slot!, T0, a.others).ok).toBe(true);
    expect(checkSchedule(b.rules, slot!, T0, b.others).ok).toBe(true);
    expect(slot! % 900).toBe(0);
  });
  it('null when nothing fits', () => {
    const full = { rules: rules({ maxPostsPerDay: 1 }), others: [T0 + HOUR] };
    expect(proposeSlot([full], T0, T0 + 6 * HOUR, T0)).toBeNull();
  });
});

describe('retry policy', () => {
  it('3 attempts in total with backoff', () => {
    expect(MAX_ATTEMPTS).toBe(3);
    expect(nextAfterTransientFailure(1)).toEqual({ kind: 'retry', delayMin: 2 });
    expect(nextAfterTransientFailure(2)).toEqual({ kind: 'retry', delayMin: 5 });
    expect(nextAfterTransientFailure(3)).toEqual({ kind: 'failed' });
  });
  it('grace window', () => {
    expect(isPastGrace(T0, T0 + GRACE_SEC)).toBe(false);
    expect(isPastGrace(T0, T0 + GRACE_SEC + 1)).toBe(true);
  });
  it('separates transient from uncertain errors', () => {
    expect(isTransientMessage('Request failed with status 503')).toBe(true);
    expect(isTransientMessage('Bad Gateway')).toBe(true);
    expect(isTransientMessage('Invalid parameter')).toBe(false);
    expect(isUncertainMessage('ETIMEDOUT')).toBe(true);
    expect(isUncertainMessage('Request timed out after 300s')).toBe(true);
    expect(isUncertainMessage('504 Gateway Timeout')).toBe(true);
    expect(isUncertainMessage('socket hang up')).toBe(true);
    expect(isUncertainMessage('Invalid parameter')).toBe(false);
  });
});
