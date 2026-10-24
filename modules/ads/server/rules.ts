/**
 * The recommendation engine: pure functions from daily numbers to advice.
 * The app never changes anything in Meta, so every result is a sentence for
 * the owner ("Tắt ...", "Tăng 20% ...") with the numbers that justify it.
 *
 * Rules (target = the account's target CPA, windows end today, account tz):
 *   R1  spend7 >= 2x target and no result at all           -> off_now
 *   R2  out of learning, spend7 >= 3x target, CPA > 1.5x   -> off
 *   R3  frequency > 3 and CTR down > 30% vs first 3 days   -> refresh
 *       (never "off" while the CPA is fine)
 *   R4  CPA < 0.8x target for the last 3 days and
 *       >= 50 results/week, out of learning, budget known  -> up (+20%,
 *       at most every 3 days)
 *   R5  in learning -> keep (only R1 can still fire)
 *   CLONE  the ad with the lowest CPA and enough results   -> clone
 *
 * Precedence per object: R1 > R5 > R2 > R3 > R4. Children of an object that
 * is already recommended off are not listed separately.
 */

import type { AdsAction, AdsResultType } from '../../_lib/fb-types.js';
import { fmtMoney, fmtNum, fmtPct, fmtRatio } from './format.js';
import {
  addDays,
  cpaOf,
  ctrChangePct,
  ctrOf,
  hookRateOf,
  inRange,
  RESULT_LABELS,
  sumDays,
  weightedFrequency,
  type DayStats,
} from './metrics.js';

export type RuleLevel = 'campaign' | 'adset' | 'ad';

export const THRESHOLDS = {
  /** R1: spend (x target CPA) with zero results. */
  offNowSpendX: 2,
  /** R2: spend (x target CPA) and CPA (x target) before an object is cut. */
  offSpendX: 3,
  offCpaX: 1.5,
  /** R3 */
  refreshFrequency: 3,
  refreshCtrDropPct: -30,
  /** R4 */
  upCpaX: 0.8,
  upMinResults7d: 50,
  upStep: 0.2,
  upCooldownSec: 3 * 86400,
  /** R5: Meta's own rule of thumb for leaving the learning phase. */
  learningResults7d: 50,
  /** Clone: results in 7 days an ad needs before it can be called the best. */
  cloneMinResults7d: 10,
  /** A recommendation the owner marked done is not repeated for this long. */
  doneCooldownSec: 24 * 3600,
  snoozeSec: 24 * 3600,
  /** Open recommendations nobody re-confirmed for this long expire. */
  staleSec: 48 * 3600,
} as const;

export interface RuleObject {
  level: RuleLevel;
  id: string;
  name: string;
  /** Ad set for an ad, campaign for an ad set, '' for a campaign. */
  parentId: string;
  /** Meta effective_status ('' when unknown). */
  status: string;
  /** Meta learning_stage_info.status ('' when unknown). */
  learning: string;
  dailyBudget: number | null;
  /** Ascending by day. */
  days: DayStats[];
  /** 7-day frequency from Meta; null falls back to the weighted daily mean. */
  windowFrequency: number | null;
}

export interface RuleContext {
  /** Account-local today, YYYY-MM-DD. */
  today: string;
  targetCpa: number | null;
  resultType: AdsResultType;
  currency: string;
  /** When the owner last marked an 'up' for this object as done (unix seconds). */
  lastUpAt?: (level: RuleLevel, objectId: string) => number | null;
  nowSec: number;
}

export interface EvalMetrics {
  spend7: number;
  results7: number;
  cpa7: number | null;
  ratio: number | null;
  ctr7: number | null;
  frequency: number | null;
  ctrChangePct: number | null;
  hookRate: number | null;
  spendPerDay: number;
  resultsPerDay: number;
  dailyBudget: number | null;
  activeDays: number;
}

export interface Evaluation {
  level: RuleLevel;
  objectId: string;
  objectName: string;
  parentId: string;
  action: AdsAction;
  /** 'R1'..'R5', 'CLONE', or 'OK' / 'WATCH' / 'OFF' / 'NO_TARGET' for advice that does not go to the queue. */
  rule: string;
  reason: string;
  /** True when this belongs in the queue (stored as a recommendation). */
  actionable: boolean;
  /** Set when a parent is already recommended off; not listed in the queue. */
  suppressedBy: string | null;
  metrics: EvalMetrics;
}

const INACTIVE = new Set([
  'PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'ARCHIVED', 'DELETED', 'DISAPPROVED',
  'PENDING_REVIEW', 'PREAPPROVED', 'PENDING_BILLING_INFO',
]);

const OFF_ACTIONS = new Set<AdsAction>(['off', 'off_now']);

export const ACTION_ORDER: Record<AdsAction, number> = {
  off_now: 0, off: 1, down: 2, up: 3, refresh: 4, clone: 5, watch: 6, keep: 7,
};

function metricsOf(obj: RuleObject, ctx: RuleContext): EvalMetrics {
  const week = inRange(obj.days, addDays(ctx.today, -6), ctx.today);
  const t = sumDays(week);
  const cpa = cpaOf(t);
  return {
    spend7: t.spend,
    results7: t.results,
    cpa7: cpa,
    ratio: cpa !== null && ctx.targetCpa ? cpa / ctx.targetCpa : null,
    ctr7: ctrOf(t),
    frequency: obj.windowFrequency ?? weightedFrequency(week),
    ctrChangePct: ctrChangePct(obj.days),
    hookRate: hookRateOf(t),
    spendPerDay: t.spend / 7,
    resultsPerDay: t.results / 7,
    dailyBudget: obj.dailyBudget,
    activeDays: week.filter((d) => d.spend > 0).length,
  };
}

function isActive(obj: RuleObject, ctx: RuleContext): boolean {
  const status = obj.status.toUpperCase();
  if (INACTIVE.has(status)) return false;
  if (status) return true;
  // Status unknown: trust recent delivery.
  const recent = inRange(obj.days, addDays(ctx.today, -1), ctx.today);
  return recent.some((d) => d.spend > 0);
}

function isLearning(obj: RuleObject, m: EvalMetrics): boolean {
  const learning = obj.learning.toUpperCase();
  if (learning === 'LEARNING') return true;
  // SUCCESS, FAIL, LEARNING_LIMITED, NOT_APPLICABLE ...: Meta has already decided.
  if (learning) return false;
  // Unknown: a young object that has not collected enough results yet.
  return m.activeDays < 4 && m.results7 < THRESHOLDS.learningResults7d;
}

/** The three full days before today (oldest first); missing days are undefined. */
function lastThreeFullDays(obj: RuleObject, today: string): (DayStats | undefined)[] {
  return [3, 2, 1].map((back) => obj.days.find((d) => d.day === addDays(today, -back)));
}

function base(obj: RuleObject, m: EvalMetrics): Pick<Evaluation, 'level' | 'objectId' | 'objectName' | 'parentId' | 'metrics' | 'suppressedBy'> {
  return { level: obj.level, objectId: obj.id, objectName: obj.name, parentId: obj.parentId, metrics: m, suppressedBy: null };
}

/** One object against R1–R5. Always returns advice; `actionable` says whether it is queue-worthy. */
export function evaluateObject(obj: RuleObject, ctx: RuleContext): Evaluation {
  const m = metricsOf(obj, ctx);
  const b = base(obj, m);
  const target = ctx.targetCpa;
  const label = RESULT_LABELS[ctx.resultType];
  const money = (n: number) => fmtMoney(n, ctx.currency);
  const advice = (action: AdsAction, rule: string, reason: string, actionable = false): Evaluation => ({ ...b, action, rule, reason, actionable });

  if (!isActive(obj, ctx)) return advice('keep', 'OFF', 'Đang tạm dừng: không cần xử lý.');
  if (!target || target <= 0) {
    return advice('keep', 'NO_TARGET', `Chưa đặt ${label.cpa} mục tiêu cho tài khoản nên chưa có gợi ý.`);
  }

  // R1 — money gone, nothing back. Applies even in learning.
  if (m.results7 === 0 && m.spend7 >= THRESHOLDS.offNowSpendX * target) {
    return advice('off_now', 'R1',
      `Chi ${money(m.spend7)} (${fmtRatio(m.spend7 / target)} ${label.cpa} mục tiêu) trong 7 ngày mà chưa có ${label.unit} nào.`
      + (m.hookRate !== null && m.hookRate < 20 ? ` Hook ${fmtPct(m.hookRate, 0)}: người xem bỏ đi trong 3 giây đầu.` : ''),
      true);
  }

  // R5 — learning: leave it alone.
  if (isLearning(obj, m)) {
    return advice('keep', 'R5',
      `Đang trong giai đoạn học (${m.results7}/${THRESHOLDS.learningResults7d} ${label.unit} trong 7 ngày): chưa thay đổi gì.`);
  }

  // R2 — spent enough to judge, and too expensive.
  if (m.cpa7 !== null && m.spend7 >= THRESHOLDS.offSpendX * target && m.cpa7 > THRESHOLDS.offCpaX * target) {
    const tail: string[] = [];
    if (m.ctr7 !== null && m.ctr7 < 1) tail.push(`CTR ${fmtPct(m.ctr7)} thấp`);
    if (m.frequency !== null && m.frequency >= 2.5) tail.push(`tần suất ${fmtNum(m.frequency)}`);
    return advice('off', 'R2',
      `${label.cpa} ${money(m.cpa7)} = ${fmtRatio(m.cpa7 / target)} mục tiêu sau ${money(m.spend7)} chi (≥ ${THRESHOLDS.offSpendX}× ${label.cpa} mục tiêu).`
      + (tail.length ? ` ${tail.join(', ')}.` : ''),
      true);
  }

  // R3 — tired audience or creative. Refresh, do not cut while the CPA is fine.
  if (m.frequency !== null && m.frequency > THRESHOLDS.refreshFrequency
    && m.ctrChangePct !== null && m.ctrChangePct < THRESHOLDS.refreshCtrDropPct) {
    const fine = m.cpa7 !== null && m.cpa7 <= target;
    return advice('refresh', 'R3',
      `Tần suất ${fmtNum(m.frequency)}; CTR giảm ${fmtNum(Math.abs(m.ctrChangePct), 0)}% so với 3 ngày đầu. `
      + (fine && m.cpa7 !== null
        ? `${label.cpa} ${money(m.cpa7)} vẫn trong mục tiêu nên đừng tắt, hãy thay creative.`
        : 'Hãy thay creative trước khi tính chuyện tắt.'),
      true);
  }

  // R4 — cheap, proven and has room to grow. Budget lives on this object.
  if (obj.level !== 'ad' && obj.dailyBudget !== null && m.results7 >= THRESHOLDS.upMinResults7d) {
    const lastUp = ctx.lastUpAt?.(obj.level, obj.id) ?? null;
    const cooled = lastUp === null || ctx.nowSec - lastUp >= THRESHOLDS.upCooldownSec;
    const days3 = lastThreeFullDays(obj, ctx.today);
    const cheap3 = days3.every((d) => d && d.results > 0 && d.spend / d.results < THRESHOLDS.upCpaX * target);
    if (cooled && cheap3) {
      const t3 = sumDays(days3 as DayStats[]);
      const cpa3 = cpaOf(t3) as number;
      return advice('up', 'R4',
        `${label.cpa} ${money(cpa3)} = ${fmtRatio(cpa3 / target)} mục tiêu 3 ngày liền, ${m.results7} ${label.unit}/tuần, đã qua giai đoạn học. `
        + `Tăng ngân sách từ ${fmtMoney(obj.dailyBudget, ctx.currency, 2)} lên ${fmtMoney(obj.dailyBudget * (1 + THRESHOLDS.upStep), ctx.currency, 2)}/ngày.`,
        true);
    }
  }

  // Nothing to do — say why, so the tree is never silent.
  if (m.cpa7 === null) {
    return advice('watch', 'WATCH',
      `Chưa có ${label.unit} nào, mới chi ${money(m.spend7)} (dưới ${THRESHOLDS.offNowSpendX}× ${label.cpa} mục tiêu). Chờ thêm.`);
  }
  if (m.cpa7 > target) {
    const days3 = lastThreeFullDays(obj, ctx.today);
    const cpas = days3.map((d) => (d && d.results > 0 ? d.spend / d.results : null));
    const falling = cpas.every((c): c is number => c !== null) && cpas[0]! > cpas[1]! && cpas[1]! > cpas[2]!;
    return advice('watch', 'WATCH',
      `${label.cpa} ${money(m.cpa7)} = ${fmtRatio(m.cpa7 / target)} mục tiêu`
      + (falling
        ? `, nhưng giảm 3 ngày liền (${money(cpas[0]!)} → ${money(cpas[2]!)}). Chờ thêm.`
        : `; chưa đủ chi (${money(m.spend7)}/${money(THRESHOLDS.offSpendX * target)}) hoặc chưa tệ tới mức phải cắt. Theo dõi.`));
  }
  return advice('keep', 'OK', `${label.cpa} ${money(m.cpa7)} = ${fmtRatio(m.cpa7 / target)} mục tiêu: trong mức cho phép.`);
}

/**
 * Evaluates every object of an account, hides children of objects that are
 * already recommended off, and picks the one ad worth cloning.
 */
export function evaluateAccount(objects: RuleObject[], ctx: RuleContext): Evaluation[] {
  const evals = objects.map((o) => evaluateObject(o, ctx));
  const byKey = new Map(evals.map((e) => [`${e.level}:${e.objectId}`, e]));
  const parentLevel: Record<RuleLevel, RuleLevel | null> = { campaign: null, adset: 'campaign', ad: 'adset' };

  const offAncestor = (e: Evaluation): string | null => {
    let level = parentLevel[e.level];
    let parentId = e.parentId;
    while (level && parentId) {
      const parent = byKey.get(`${level}:${parentId}`);
      if (parent && OFF_ACTIONS.has(parent.action)) return parent.objectId;
      parentId = parent?.parentId ?? '';
      level = parentLevel[level];
    }
    return null;
  };

  for (const e of evals) {
    const by = e.actionable ? offAncestor(e) : null;
    if (by) {
      e.suppressedBy = by;
      e.actionable = false;
    }
  }

  const clone = pickClone(objects, evals, ctx);
  if (clone) {
    clone.action = 'clone';
    clone.rule = 'CLONE';
    clone.actionable = true;
    clone.reason = cloneReason(clone, ctx);
  }
  return evals;
}

/** The best ad: lowest CPA with enough results, cheaper than the target (or than 85% of the account average without one). */
function pickClone(objects: RuleObject[], evals: Evaluation[], ctx: RuleContext): Evaluation | null {
  const ads = evals.filter((e) => e.level === 'ad' && (e.action === 'keep' || e.action === 'watch') && e.rule !== 'OFF');
  const adObjects = objects.filter((o) => o.level === 'ad');
  const all = sumDays(adObjects.flatMap((o) => inRange(o.days, addDays(ctx.today, -6), ctx.today)));
  const avgCpa = cpaOf(all);
  const ceiling = ctx.targetCpa && ctx.targetCpa > 0 ? ctx.targetCpa : avgCpa !== null ? avgCpa * 0.85 : null;
  if (ceiling === null) return null;
  let best: Evaluation | null = null;
  for (const e of ads) {
    const { cpa7, results7 } = e.metrics;
    if (cpa7 === null || results7 < THRESHOLDS.cloneMinResults7d || cpa7 >= ceiling) continue;
    if (!best || cpa7 < (best.metrics.cpa7 as number)) best = e;
  }
  return best;
}

function cloneReason(e: Evaluation, ctx: RuleContext): string {
  const label = RESULT_LABELS[ctx.resultType];
  const m = e.metrics;
  const cpa = m.cpa7 as number;
  const vsTarget = ctx.targetCpa ? ` = ${fmtRatio(cpa / ctx.targetCpa)} mục tiêu` : '';
  return `${label.cpa} ${fmtMoney(cpa, ctx.currency)}${vsTarget}, thấp nhất tài khoản với ${m.results7} ${label.unit}/7 ngày.`
    + (m.hookRate !== null ? ` Hook ${fmtPct(m.hookRate, 0)}.` : '')
    + ' Nhân bản sang nhóm đối tượng khác.';
}

// ── Queue reconciliation ──────────────────────────────────────────────

export interface ExistingRec {
  id: number;
  level: string;
  objectId: string;
  action: string;
  state: string;
  snoozedUntil: number | null;
  createdAt: number;
  updatedAt: number;
}

export type RecOp =
  | { type: 'create'; ev: Evaluation }
  | { type: 'refresh'; id: number; ev: Evaluation }
  | { type: 'reopen'; id: number; ev: Evaluation }
  | { type: 'expire'; id: number };

/**
 * Turns this hour's actionable evaluations into database operations while
 * keeping exactly one open recommendation per object:
 *   - same object, open        -> refresh in place (new numbers, maybe a new action)
 *   - snoozed and still snoozed -> leave alone; snooze elapsed -> reopen
 *   - done recently             -> do not repeat (24 h; 3 days for 'up')
 *   - no longer firing          -> expire the open / snoozed one
 */
export function reconcile(existing: ExistingRec[], fresh: Evaluation[], nowSec: number): RecOp[] {
  const ops: RecOp[] = [];
  const freshByKey = new Map(fresh.map((e) => [`${e.level}:${e.objectId}`, e]));
  const existingByKey = new Map<string, ExistingRec[]>();
  for (const r of existing) {
    const key = `${r.level}:${r.objectId}`;
    (existingByKey.get(key) ?? existingByKey.set(key, []).get(key)!).push(r);
  }

  for (const [key, recs] of existingByKey) {
    if (freshByKey.has(key)) continue;
    for (const r of recs) if (r.state === 'open' || r.state === 'snoozed') ops.push({ type: 'expire', id: r.id });
  }

  for (const [key, ev] of freshByKey) {
    const recs = (existingByKey.get(key) ?? []).slice().sort((a, b) => b.id - a.id);
    const open = recs.filter((r) => r.state === 'open');
    const snoozed = recs.find((r) => r.state === 'snoozed');
    const done = recs.find((r) => r.state === 'done');

    // A second open one should not exist; keep the newest.
    for (const extra of open.slice(1)) ops.push({ type: 'expire', id: extra.id });

    if (open[0]) {
      ops.push({ type: 'refresh', id: open[0].id, ev });
      continue;
    }
    if (snoozed) {
      if ((snoozed.snoozedUntil ?? 0) <= nowSec) ops.push({ type: 'reopen', id: snoozed.id, ev });
      continue;
    }
    if (done) {
      const cooldown = done.action === 'up' || ev.action === 'up' ? THRESHOLDS.upCooldownSec : THRESHOLDS.doneCooldownSec;
      if (nowSec - done.updatedAt < cooldown) continue;
    }
    ops.push({ type: 'create', ev });
  }
  return ops;
}

// ── Impact ────────────────────────────────────────────────────────────

export interface ImpactInput {
  action: string;
  metrics: Partial<EvalMetrics>;
}

/**
 * What following the open queue is worth per day. Savings are the average
 * daily spend of everything recommended off; extra results assume that money
 * would have bought results at the target CPA, minus the results those
 * objects were bringing, plus the results of the +20% on 'up' budgets.
 * Null when there is nothing in the queue or no target to price it with.
 */
export function estimateImpact(open: ImpactInput[], targetCpa: number | null): { savingsPerDay: number | null; extraResultsPerDay: number | null } {
  if (!targetCpa || targetCpa <= 0) return { savingsPerDay: null, extraResultsPerDay: null };
  let savings = 0;
  let extra = 0;
  let any = false;
  for (const r of open) {
    const m = r.metrics;
    if (r.action === 'off' || r.action === 'off_now') {
      const spend = m.spendPerDay ?? 0;
      if (spend <= 0) continue;
      any = true;
      savings += spend;
      extra += Math.max(0, spend / targetCpa - (m.resultsPerDay ?? 0));
    } else if (r.action === 'up') {
      const budget = m.dailyBudget ?? 0;
      const cpa = m.cpa7 ?? 0;
      if (budget <= 0 || cpa <= 0) continue;
      any = true;
      extra += (budget * THRESHOLDS.upStep) / cpa;
    }
  }
  if (!any) return { savingsPerDay: null, extraResultsPerDay: null };
  return { savingsPerDay: savings > 0 ? savings : null, extraResultsPerDay: extra > 0 ? extra : null };
}
