import { describe, expect, it } from 'vitest';

import { DEFAULT_REPLY_RULES, type ReplyRuleConfig } from '../types.js';
import {
  checkReplyLimits,
  computeSendAfter,
  isStale,
  MAX_SEND_ATTEMPTS,
  retryDelaySeconds,
  STALE_COMMENT_SECONDS,
} from './limits.js';

const rules = (patch: Partial<ReplyRuleConfig> = {}): ReplyRuleConfig => ({ ...DEFAULT_REPLY_RULES, ...patch });
const usage = (patch = {}) => ({ pageRepliesLastHour: 0, authorRepliesOnPost: 0, authorRepliedRecently: false, ...patch });

describe('checkReplyLimits', () => {
  it('allows a reply under every limit', () => {
    expect(checkReplyLimits('agent', rules(), usage())).toEqual({ ok: true });
    expect(checkReplyLimits('template', rules(), usage())).toEqual({ ok: true });
  });

  it('defers (does not drop) when the Page hourly cap is reached', () => {
    const v = checkReplyLimits('template', rules({ maxPerHour: 30 }), usage({ pageRepliesLastHour: 30 }));
    expect(v).toMatchObject({ ok: false, kind: 'defer' });
    expect(checkReplyLimits('template', rules({ maxPerHour: 30 }), usage({ pageRepliesLastHour: 29 })).ok).toBe(true);
  });

  it('skips when the author already got maxPerUserPerPost replies on the post', () => {
    const v = checkReplyLimits('agent', rules({ maxPerUserPerPost: 2 }), usage({ authorRepliesOnPost: 2 }));
    expect(v).toMatchObject({ ok: false, kind: 'skip' });
    expect(checkReplyLimits('agent', rules({ maxPerUserPerPost: 2 }), usage({ authorRepliesOnPost: 1 })).ok).toBe(true);
  });

  it('onlyIfNotRepliedHours applies to the agent step only, and only when set', () => {
    const recent = usage({ authorRepliedRecently: true });
    expect(checkReplyLimits('agent', rules({ onlyIfNotRepliedHours: 24 }), recent)).toMatchObject({ ok: false, kind: 'skip' });
    expect(checkReplyLimits('template', rules({ onlyIfNotRepliedHours: 24 }), recent).ok).toBe(true);
    expect(checkReplyLimits('agent', rules({ onlyIfNotRepliedHours: null }), recent).ok).toBe(true);
  });

  it('a permanent skip outranks a deferral', () => {
    const v = checkReplyLimits('agent', rules({ maxPerHour: 1, maxPerUserPerPost: 1 }), usage({ pageRepliesLastHour: 5, authorRepliesOnPost: 1 }));
    expect(v).toMatchObject({ ok: false, kind: 'skip' });
  });
});

describe('computeSendAfter', () => {
  const NOW = 1_800_000_000;

  it('is null in draft mode', () => {
    expect(computeSendAfter(rules({ sendMode: 'draft' }), NOW)).toBeNull();
  });

  it('auto mode: now + a delay inside [delayMin, delayMax] minutes', () => {
    const r = rules({ sendMode: 'auto', delayMinMinutes: 1, delayMaxMinutes: 4 });
    expect(computeSendAfter(r, NOW, () => 0)).toBe(NOW + 60);
    expect(computeSendAfter(r, NOW, () => 1)).toBe(NOW + 240);
    expect(computeSendAfter(r, NOW, () => 0.5)).toBe(NOW + 150);
    for (let i = 0; i < 50; i++) {
      const t = computeSendAfter(r, NOW)!;
      expect(t).toBeGreaterThanOrEqual(NOW + 60);
      expect(t).toBeLessThanOrEqual(NOW + 240);
    }
  });

  it('delay mode adds delayBeforeSendMinutes on top of the random delay', () => {
    const r = rules({ sendMode: 'delay', delayMinMinutes: 1, delayMaxMinutes: 4, delayBeforeSendMinutes: 10 });
    expect(computeSendAfter(r, NOW, () => 0)).toBe(NOW + 11 * 60);
    expect(computeSendAfter(r, NOW, () => 1)).toBe(NOW + 14 * 60);
  });

  it('tolerates min greater than max and equal bounds', () => {
    expect(computeSendAfter(rules({ delayMinMinutes: 4, delayMaxMinutes: 1 }), NOW, () => 0)).toBe(NOW + 60);
    expect(computeSendAfter(rules({ delayMinMinutes: 2, delayMaxMinutes: 2 }), NOW, () => 0.9)).toBe(NOW + 120);
    expect(computeSendAfter(rules({ delayMinMinutes: 0, delayMaxMinutes: 0 }), NOW)).toBe(NOW);
  });
});

describe('staleness and retry timing', () => {
  it('a comment older than 48 hours is stale', () => {
    const now = 1_800_000_000;
    expect(isStale(now - STALE_COMMENT_SECONDS, now)).toBe(false);
    expect(isStale(now - STALE_COMMENT_SECONDS - 1, now)).toBe(true);
  });

  it('retries back off 2, 5, 15 minutes and clamp', () => {
    expect([1, 2, 3, 4, 0].map(retryDelaySeconds)).toEqual([120, 300, 900, 900, 120]);
    expect(MAX_SEND_ATTEMPTS).toBe(3);
  });
});
