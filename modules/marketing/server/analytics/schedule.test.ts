import { describe, expect, it } from 'vitest';

import {
  MILESTONES, dueMilestone, isAnalystDue, isSweepDue, refreshWaitSec,
} from './schedule.js';

const VN = 'Asia/Ho_Chi_Minh';
const utc = (s: string) => Date.parse(`${s}Z`) / 1000;
const H = 3600;
const D = 86400;
const none = new Set<string>();

describe('dueMilestone', () => {
  it('is not due before the milestone age', () => {
    expect(dueMilestone(1000, 1000 + H - 1, none)).toBeNull();
    expect(dueMilestone(1000, 1000, none)).toBeNull();
  });

  it('is due from the milestone age up to twice that age', () => {
    expect(dueMilestone(0, H, none)).toBe('1h');
    expect(dueMilestone(0, 2 * H, none)).toBe('1h');
    expect(dueMilestone(0, 2 * H + 1, none)).toBeNull(); // more than 2x late, 6h not reached
    expect(dueMilestone(0, 6 * H, none)).toBe('6h');
    expect(dueMilestone(0, 12 * H, none)).toBe('6h');
    expect(dueMilestone(0, 24 * H, none)).toBe('24h');
    expect(dueMilestone(0, 48 * H, none)).toBe('24h');
    expect(dueMilestone(0, 3 * D, none)).toBe('3d');
    expect(dueMilestone(0, 7 * D, none)).toBe('7d');
    expect(dueMilestone(0, 14 * D, none)).toBe('7d');
    expect(dueMilestone(0, 28 * D, none)).toBe('28d');
    expect(dueMilestone(0, 56 * D, none)).toBe('28d');
    expect(dueMilestone(0, 56 * D + 1, none)).toBeNull();
  });

  it('skips a milestone that is already captured', () => {
    expect(dueMilestone(0, 90 * 60, new Set(['1h']))).toBeNull();
    expect(dueMilestone(0, 7 * H, new Set(['1h']))).toBe('6h');
  });

  it('skips milestones the worker missed by more than 2x', () => {
    // A post found 20h after publishing: 1h and 6h are gone, 24h is not yet due.
    expect(dueMilestone(0, 20 * H, none)).toBeNull();
  });

  it('never has two milestones due at once', () => {
    for (let age = 0; age <= 60 * D; age += 1800) {
      const due = MILESTONES.filter((m) => age >= m.seconds && age <= 2 * m.seconds);
      expect(due.length).toBeLessThanOrEqual(1);
    }
  });

  it('ignores a future publish time', () => {
    expect(dueMilestone(5000, 1000, none)).toBeNull();
  });
});

describe('isSweepDue (02:00 Page-local)', () => {
  it('waits for 02:00 local', () => {
    // 2026-10-07 18:59Z = 01:59 on Oct 8 in Vietnam.
    expect(isSweepDue(utc('2026-10-07T18:59:00'), VN, '2026-10-07')).toBe(false);
    expect(isSweepDue(utc('2026-10-07T19:00:00'), VN, '2026-10-07')).toBe(true);
  });

  it('runs once per local day', () => {
    const now = utc('2026-10-07T19:30:00'); // 02:30 Oct 8 VN
    expect(isSweepDue(now, VN, '2026-10-08')).toBe(false);
    expect(isSweepDue(now, VN, '2026-10-07')).toBe(true);
    expect(isSweepDue(now, VN, undefined)).toBe(true);
  });

  it('catches up later the same day after downtime at 02:00', () => {
    expect(isSweepDue(utc('2026-10-08T05:00:00'), VN, '2026-10-07')).toBe(true); // 12:00 Oct 8 VN
  });

  it('uses the Page timezone', () => {
    // 09:00Z is 02:00 in Los Angeles (PDT) but 16:00 in Vietnam.
    const t = utc('2026-10-07T09:00:00');
    expect(isSweepDue(t, 'America/Los_Angeles', '2026-10-06')).toBe(true);
    expect(isSweepDue(utc('2026-10-07T08:59:00'), 'America/Los_Angeles', '2026-10-06')).toBe(false);
  });
});

describe('isAnalystDue (07:00 Page-local)', () => {
  const today = '2026-10-07';
  const at = utc('2026-10-07T00:30:00'); // 07:30 VN

  it('is not due before 07:00 local', () => {
    expect(isAnalystDue(utc('2026-10-06T23:59:00'), VN, '2026-10-06', today)).toBe(false);
    expect(isAnalystDue(utc('2026-10-07T00:00:00'), VN, '2026-10-06', today)).toBe(true);
  });

  it('runs once per day', () => {
    expect(isAnalystDue(at, VN, today, today)).toBe(false);
    expect(isAnalystDue(at, VN, '2026-10-06', today)).toBe(true);
    expect(isAnalystDue(at, VN, undefined, today)).toBe(true);
  });

  it('waits for today\'s sweep so the tables are fresh', () => {
    expect(isAnalystDue(at, VN, '2026-10-06', '2026-10-06')).toBe(false);
    expect(isAnalystDue(at, VN, '2026-10-06', undefined)).toBe(false);
  });
});

describe('refreshWaitSec', () => {
  it('limits a manual refresh to once per 10 minutes', () => {
    expect(refreshWaitSec(1000, null)).toBe(0);
    expect(refreshWaitSec(1000, 1000 - 300)).toBe(300);
    expect(refreshWaitSec(1000, 1000 - 600)).toBe(0);
    expect(refreshWaitSec(1000, 1000 - 5000)).toBe(0);
  });
});
