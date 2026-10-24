import { describe, expect, it } from 'vitest';

import {
  RETRY_DELAYS_MIN,
  canApprove,
  canDeleteLocal,
  canDeleteRemote,
  canPatchStatus,
  canReturn,
  canUnschedule,
  completenessProblems,
  isEditable,
  isPastGrace,
  isTransientMessage,
  nextAfterTransientFailure,
  validateSchedule,
  type PageScheduleRules,
} from './state.js';
import { parseLocalDateTime } from './time.js';

const VN = 'Asia/Ho_Chi_Minh';
const rules: PageScheduleRules = { timezone: VN, maxPostsPerDay: 2, minGapMinutes: 180, windowStart: '07:00', windowEnd: '22:00' };
const at = (text: string): number => parseLocalDateTime(text, VN) as number;
const NOW = at('2026-10-20 06:00');

describe('state machine', () => {
  it('approves from authoring, approved, scheduled, failed and missed only', () => {
    for (const s of ['idea', 'draft', 'review', 'approved', 'scheduled', 'failed', 'missed'] as const) expect(canApprove(s)).toBe(true);
    for (const s of ['publishing', 'published', 'deleted'] as const) expect(canApprove(s)).toBe(false);
  });

  it('limits PATCH status moves to idea → draft → review', () => {
    expect(canPatchStatus('idea', 'draft')).toBe(true);
    expect(canPatchStatus('draft', 'review')).toBe(true);
    expect(canPatchStatus('review', 'review')).toBe(true);
    for (const [from, to] of [
      ['idea', 'review'], ['draft', 'idea'], ['review', 'draft'], ['review', 'approved'], ['review', 'published'],
      ['scheduled', 'draft'], ['published', 'draft'], ['failed', 'draft'], ['approved', 'review'],
    ] as const) expect(canPatchStatus(from, to), `${from} → ${to}`).toBe(false);
  });

  it('protects live rows from edits', () => {
    expect(isEditable('draft')).toBe('full');
    expect(isEditable('scheduled')).toBe('full');
    expect(isEditable('published')).toBe('tags');
    expect(isEditable('publishing')).toBe('none');
    expect(isEditable('deleted')).toBe('none');
  });

  it('gates unschedule, return and deletes', () => {
    expect(canUnschedule('scheduled')).toBe(true);
    expect(canUnschedule('approved')).toBe(false);
    expect(canUnschedule('publishing')).toBe(false);
    expect(canReturn('review')).toBe(true);
    expect(canReturn('draft')).toBe(false);
    expect(canReturn('published')).toBe(false);
    expect(canDeleteLocal('publishing')).toBe(false);
    expect(canDeleteLocal('published')).toBe(true);
    expect(canDeleteRemote('published')).toBe(true);
    expect(canDeleteRemote('scheduled')).toBe(false);
  });
});

describe('completenessProblems', () => {
  const base = { pageId: 'p1', caption: 'hi', linkUrl: '', media: [] as Array<{ kind: 'video' | 'image' }> };
  it('needs a Page', () => {
    expect(completenessProblems({ ...base, pageId: null, format: 'text' })).toHaveLength(1);
  });
  it('checks each format', () => {
    expect(completenessProblems({ ...base, format: 'text' })).toEqual([]);
    expect(completenessProblems({ ...base, format: 'text', caption: '  ' })).toHaveLength(1);
    expect(completenessProblems({ ...base, format: 'link', linkUrl: 'example.com' })).toHaveLength(1);
    expect(completenessProblems({ ...base, format: 'link', linkUrl: 'https://example.com' })).toEqual([]);
    expect(completenessProblems({ ...base, format: 'photo' })).toHaveLength(1);
    expect(completenessProblems({ ...base, format: 'photo', media: [{ kind: 'image' }] })).toEqual([]);
    expect(completenessProblems({ ...base, format: 'album', media: [{ kind: 'video' }] })).toHaveLength(1);
    expect(completenessProblems({ ...base, format: 'video', media: [{ kind: 'image' }] })).toHaveLength(1);
    expect(completenessProblems({ ...base, format: 'reel', media: [{ kind: 'video' }] })).toEqual([]);
  });
});

describe('validateSchedule', () => {
  it('accepts a time inside the window with no neighbours', () => {
    expect(validateSchedule(rules, at('2026-10-20 19:30'), NOW, []).ok).toBe(true);
  });

  it('rejects the past', () => {
    const v = validateSchedule(rules, at('2026-10-20 05:00'), NOW, []);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/đã qua/);
  });

  it('rejects times outside the posting window, edges included', () => {
    expect(validateSchedule(rules, at('2026-10-20 06:59'), NOW - 7200, []).ok).toBe(false);
    expect(validateSchedule(rules, at('2026-10-20 07:00'), NOW - 7200, []).ok).toBe(true);
    expect(validateSchedule(rules, at('2026-10-20 22:00'), NOW, []).ok).toBe(true);
    const late = validateSchedule(rules, at('2026-10-20 22:01'), NOW, []);
    expect(late.ok).toBe(false);
    expect(late.reason).toMatch(/07:00–22:00/);
  });

  it('supports an overnight window', () => {
    const night: PageScheduleRules = { ...rules, windowStart: '20:00', windowEnd: '02:00' };
    expect(validateSchedule(night, at('2026-10-20 23:00'), NOW, []).ok).toBe(true);
    expect(validateSchedule(night, at('2026-10-21 01:30'), NOW, []).ok).toBe(true);
    expect(validateSchedule(night, at('2026-10-20 12:00'), NOW, []).ok).toBe(false);
  });

  it('enforces the minimum gap on both sides', () => {
    const others = [at('2026-10-20 12:00')];
    const tooClose = validateSchedule(rules, at('2026-10-20 14:59'), NOW, others);
    expect(tooClose.ok).toBe(false);
    expect(tooClose.reason).toMatch(/12:00/);
    expect(validateSchedule(rules, at('2026-10-20 15:00'), NOW, others).ok).toBe(true);
    expect(validateSchedule(rules, at('2026-10-20 09:01'), NOW, others).ok).toBe(false);
    expect(validateSchedule(rules, at('2026-10-20 09:00'), NOW, others).ok).toBe(true);
  });

  it('enforces max posts per day in the Page timezone', () => {
    const others = [at('2026-10-20 08:00'), at('2026-10-20 12:00')];
    const full = validateSchedule(rules, at('2026-10-20 18:00'), NOW, others);
    expect(full.ok).toBe(false);
    expect(full.reason).toMatch(/đủ 2 bài/);
    // the next local day is free
    expect(validateSchedule(rules, at('2026-10-21 08:00'), NOW, others).ok).toBe(true);
  });

  it('counts the day in Page time, not UTC', () => {
    // 00:30 on the 21st in Vietnam is still the 20th in UTC; both existing posts are on the 20th local.
    const night: PageScheduleRules = { ...rules, windowStart: '00:00', windowEnd: '23:59', minGapMinutes: 0 };
    const others = [at('2026-10-21 00:10'), at('2026-10-21 00:20')];
    expect(validateSchedule(night, at('2026-10-21 00:30'), NOW, others).ok).toBe(false);
    expect(validateSchedule(night, at('2026-10-20 23:30'), NOW, others).ok).toBe(true);
  });

  it('treats 0 as "no limit" for max per day and gap', () => {
    const open: PageScheduleRules = { ...rules, maxPostsPerDay: 0, minGapMinutes: 0 };
    const others = [at('2026-10-20 12:00'), at('2026-10-20 12:00'), at('2026-10-20 12:00')];
    expect(validateSchedule(open, at('2026-10-20 12:00'), NOW, others).ok).toBe(true);
  });
});

describe('publish policy', () => {
  it('retries after 2, 5 and 15 minutes then fails', () => {
    expect(RETRY_DELAYS_MIN).toEqual([2, 5, 15]);
    expect(nextAfterTransientFailure(1)).toEqual({ kind: 'retry', delayMin: 2 });
    expect(nextAfterTransientFailure(2)).toEqual({ kind: 'retry', delayMin: 5 });
    expect(nextAfterTransientFailure(3)).toEqual({ kind: 'retry', delayMin: 15 });
    expect(nextAfterTransientFailure(4)).toEqual({ kind: 'failed' });
  });

  it('applies the grace window strictly after the limit', () => {
    const t = 1_000_000;
    expect(isPastGrace(t, 30, t + 30 * 60)).toBe(false);
    expect(isPastGrace(t, 30, t + 30 * 60 + 1)).toBe(true);
    expect(isPastGrace(t, 0, t + 1)).toBe(true);
  });

  it('only retries 5xx style errors', () => {
    expect(isTransientMessage('Request failed with status 503')).toBe(true);
    expect(isTransientMessage('Internal Server Error')).toBe(true);
    expect(isTransientMessage('(#100) Invalid parameter')).toBe(false);
    expect(isTransientMessage('fetch failed')).toBe(false);
    expect(isTransientMessage('timeout')).toBe(false);
  });
});
