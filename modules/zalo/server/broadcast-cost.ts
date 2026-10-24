/**
 * Send-budget maths for scheduled group broadcasts.
 *
 * A campaign is limited by how many Zalo send operations it spends per day
 * against the nick's bulk share of its daily message cap, not by group count
 * alone: one group costs text (1) + image album (1) + every file/video (1 each).
 * The rest of the cap stays free for people typing by hand and for agents.
 *
 * Everything except `getBroadcastBudgetInputs` is pure so routes and tests
 * share it.
 */

import { getZaloProtectionSettings, type ZaloAccountRow } from './store.js';
import { effectiveMessageCap } from './limits.js';
import { minGapMinutes, MAX_TIMES_PER_DAY } from './schedule.js';

/** Hard cap on groups per campaign; the real limit is the daily budget. */
export const MAX_GROUPS_PER_BROADCAST = 50;
/** Gap between two groups (seconds): below the floor Zalo flags the nick. */
export const MIN_DELAY_FLOOR_SEC = 10;
export const MAX_DELAY_CAP_SEC = 600;
export const DEFAULT_MIN_DELAY_SEC = 20;
export const DEFAULT_MAX_DELAY_SEC = 45;
/** Average of the 0.8–2.5 s pause between two sends to the same group. */
const INTRA_GROUP_DELAY_SEC = 1.65;

export type BroadcastIssueCode =
  | 'DAILY_BUDGET_EXCEEDED' | 'SCHEDULE_TOO_TIGHT' | 'TOO_MANY_GROUPS' | 'TOO_MANY_TIMES' | 'TEMPLATE_EMPTY';

export interface BroadcastIssue {
  code: BroadcastIssueCode;
  message: string;
}

export interface BroadcastCost {
  /** (text ? 1 : 0) + (any image ? 1 : 0) + one per file and per video. */
  opsPerGroup: number;
  opsPerRun: number;
  opsPerDay: number;
  /** Estimated wall time of one run, seconds. */
  runDurationSec: number;
}

export interface BroadcastCostInput {
  groupCount: number;
  hasText: boolean;
  attachments: Array<{ kind: 'image' | 'file' | 'video' }>;
  /** timesOfDay.length; 1 for a 'now' campaign. */
  timesPerDay: number;
  minDelaySec: number;
  maxDelaySec: number;
}

export function estimateBroadcastCost(input: BroadcastCostInput): BroadcastCost {
  const hasImage = input.attachments.some((a) => a.kind === 'image');
  const others = input.attachments.filter((a) => a.kind !== 'image').length;
  const opsPerGroup = (input.hasText ? 1 : 0) + (hasImage ? 1 : 0) + others;
  const opsPerRun = input.groupCount * opsPerGroup;
  const opsPerDay = opsPerRun * Math.max(1, input.timesPerDay);

  const avgGap = (input.minDelaySec + input.maxDelaySec) / 2;
  // The first group does not wait: n groups have n-1 gaps.
  const runDurationSec = Math.max(0, input.groupCount - 1) * avgGap + opsPerRun * INTRA_GROUP_DELAY_SEC;
  return { opsPerGroup, opsPerRun, opsPerDay, runDurationSec: Math.round(runDurationSec) };
}

/** Daily operations a campaign may spend: its share of the nick's effective cap. */
export function dailyBudget(dailyCap: number, bulkSharePercent: number): number {
  return Math.floor((Math.max(0, bulkSharePercent) / 100) * Math.max(0, dailyCap));
}

/** Largest group count that still fits the budget (suggestion shown to the operator). */
export function maxGroupsWithinBudget(budget: number, opsPerGroup: number, timesPerDay: number): number {
  const perGroupPerDay = opsPerGroup * Math.max(1, timesPerDay);
  return perGroupPerDay <= 0 ? 0 : Math.floor(budget / perGroupPerDay);
}

export interface BroadcastPlanInput extends BroadcastCostInput {
  timesOfDay: string[];
  dailyCap: number;
  bulkSharePercent: number;
}

export interface BroadcastPlan {
  cost: BroadcastCost;
  dailyCap: number;
  bulkSharePercent: number;
  budget: number;
  /** Smallest gap between two send times in minutes; null with fewer than two. */
  minGapMinutes: number | null;
  errors: BroadcastIssue[];
  warnings: BroadcastIssue[];
}

/** Cost, budget and the errors/warnings the editor shows live. */
export function evaluateBroadcastPlan(input: BroadcastPlanInput): BroadcastPlan {
  const cost = estimateBroadcastCost(input);
  const budget = dailyBudget(input.dailyCap, input.bulkSharePercent);
  const errors: BroadcastIssue[] = [];
  const warnings: BroadcastIssue[] = [];

  if (!input.hasText && input.attachments.length === 0) {
    errors.push({ code: 'TEMPLATE_EMPTY', message: 'Mẫu tin rỗng, không có gì để gửi.' });
  }
  if (input.groupCount > MAX_GROUPS_PER_BROADCAST) {
    errors.push({ code: 'TOO_MANY_GROUPS', message: `Tối đa ${MAX_GROUPS_PER_BROADCAST} nhóm mỗi lịch gửi.` });
  }
  if (input.timesPerDay > MAX_TIMES_PER_DAY) {
    errors.push({ code: 'TOO_MANY_TIMES', message: `Tối đa ${MAX_TIMES_PER_DAY} mốc giờ mỗi ngày.` });
  }
  if (cost.opsPerDay > budget) {
    const fit = maxGroupsWithinBudget(budget, cost.opsPerGroup, input.timesPerDay);
    errors.push({
      code: 'DAILY_BUDGET_EXCEEDED',
      message:
        `Ước tính ${cost.opsPerDay} lượt gửi/ngày, vượt ngưỡng an toàn ${budget} lượt ` +
        `(${input.bulkSharePercent}% hạn mức ${input.dailyCap} tin/ngày của nick). ` +
        `Giảm còn tối đa ${fit} nhóm, hoặc bớt mốc giờ, hoặc bớt tệp đính kèm.`,
    });
  }

  const gap = minGapMinutes(input.timesOfDay);
  const minGap = Number.isFinite(gap) ? gap : null;
  if (minGap !== null && minGap * 60 < cost.runDurationSec) {
    warnings.push({
      code: 'SCHEDULE_TOO_TIGHT',
      message:
        `Hai mốc giờ cách nhau ${minGap} phút nhưng một lượt gửi mất khoảng ${Math.ceil(cost.runDurationSec / 60)} phút. ` +
        'Lượt sau có thể bị bỏ qua. Hãy giãn mốc giờ ra hoặc bớt nhóm.',
    });
  }

  return { cost, dailyCap: input.dailyCap, bulkSharePercent: input.bulkSharePercent, budget, minGapMinutes: minGap, errors, warnings };
}

/** Today's effective cap (warm-up aware) and the bulk share, from the protection settings. */
export function getBroadcastBudgetInputs(account: ZaloAccountRow): { dailyCap: number; bulkSharePercent: number } {
  return {
    dailyCap: effectiveMessageCap(account),
    bulkSharePercent: getZaloProtectionSettings().bulkSharePercent,
  };
}
