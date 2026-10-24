/**
 * /api/m/zalo/group-broadcasts — scheduled group broadcasts (Marketing page).
 *
 * The dashboard only writes rows; the daemon's worker (group-broadcast.ts)
 * picks them up within a minute. Validation here is what keeps a campaign
 * inside the anti-ban limits: delay floors, group/time caps and the daily
 * send budget.
 *
 * Mounted by dashboard-routes.ts on the module's /api/m/zalo sub-app.
 */

import type { Context, Hono } from 'hono';

import {
  createZaloBroadcast,
  deleteZaloBroadcast,
  getLatestZaloBroadcastRun,
  getZaloAccount,
  getZaloBroadcast,
  getZaloTemplate,
  getZaloThread,
  hasActiveZaloBroadcastRun,
  listZaloBroadcastRuns,
  listZaloBroadcastTargets,
  listZaloBroadcasts,
  setZaloBroadcastState,
  updateZaloBroadcast,
  type ZaloBroadcastInput,
  type ZaloBroadcastRow,
  type ZaloBroadcastRunRow,
  type ZaloBroadcastTargetRow,
} from './store.js';
import {
  DEFAULT_MAX_DELAY_SEC,
  DEFAULT_MIN_DELAY_SEC,
  evaluateBroadcastPlan,
  getBroadcastBudgetInputs,
  MAX_DELAY_CAP_SEC,
  MAX_GROUPS_PER_BROADCAST,
  MIN_DELAY_FLOOR_SEC,
  type BroadcastIssue,
  type BroadcastPlan,
} from './broadcast-cost.js';
import { materializeBroadcastRun, scheduleSpecOf } from './group-broadcast.js';
import { DEFAULT_TIMEZONE } from './marketing-deps.js';
import {
  nextRunAt,
  normalizeSchedule,
  SCHEDULE_ERROR_MESSAGE,
  SCHEDULE_KINDS,
  validateSchedule,
  type ScheduleKind,
} from './schedule.js';

const BASE = '/group-broadcasts';
const MAX_NAME_LENGTH = 120;
/** A target that already failed this many times is left out of "gửi lại nhóm lỗi". */
const MAX_TARGET_ATTEMPTS = 3;
/** Runs listed on the detail page, and how many of them carry per-group results. */
const DETAIL_RUNS = 20;
const DETAIL_RUNS_WITH_TARGETS = 5;

type FailStatus = 400 | 404 | 409 | 422;
interface Failure {
  ok: false;
  status: FailStatus;
  error: string;
  code: string;
  extra?: Record<string, unknown>;
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

function fail(status: FailStatus, code: string, error: string, extra?: Record<string, unknown>): Failure {
  return { ok: false, status, error, code, extra };
}

function respondFailure(c: Context, f: Failure) {
  return c.json({ error: f.error, code: f.code, ...(f.extra ?? {}) }, f.status);
}

function intParam(raw: string | undefined): number {
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) ? n : 0;
}

function toIntArray(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((n) => Number(n)).filter((n) => Number.isInteger(n));
}

function toStringArray(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string').map((s) => s.trim()).filter(Boolean) : [];
}

/** '' / null → null, otherwise the trimmed string (validated later by validateSchedule). */
function toDateString(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().slice(0, 10);
  return s === '' ? null : s;
}

interface BroadcastBody {
  name?: unknown;
  accountId?: unknown;
  templateId?: unknown;
  targetThreadIds?: unknown;
  scheduleKind?: unknown;
  timesOfDay?: unknown;
  daysOfWeek?: unknown;
  daysOfMonth?: unknown;
  timezone?: unknown;
  startDate?: unknown;
  endDate?: unknown;
  minDelaySec?: unknown;
  maxDelaySec?: unknown;
}

function inputOf(b: ZaloBroadcastRow): ZaloBroadcastInput {
  return {
    name: b.name,
    accountId: b.account_id,
    templateId: b.template_id,
    targetThreadIds: b.target_thread_ids,
    scheduleKind: b.schedule_kind,
    timesOfDay: b.times_of_day,
    daysOfWeek: b.days_of_week,
    daysOfMonth: b.days_of_month,
    timezone: b.timezone,
    startDate: b.start_date,
    endDate: b.end_date,
    minDelaySec: b.min_delay_sec,
    maxDelaySec: b.max_delay_sec,
  };
}

/** Merge a (partial) request body over the current row so PATCH can send only what changed. */
function mergeBody(body: BroadcastBody, current?: ZaloBroadcastRow): BroadcastBody {
  if (!current) return body;
  const base = inputOf(current);
  return {
    name: body.name ?? base.name,
    accountId: body.accountId ?? base.accountId,
    templateId: body.templateId ?? base.templateId,
    targetThreadIds: body.targetThreadIds ?? base.targetThreadIds,
    scheduleKind: body.scheduleKind ?? base.scheduleKind,
    timesOfDay: body.timesOfDay ?? base.timesOfDay,
    daysOfWeek: body.daysOfWeek ?? base.daysOfWeek,
    daysOfMonth: body.daysOfMonth ?? base.daysOfMonth,
    timezone: body.timezone ?? base.timezone,
    startDate: body.startDate === undefined ? base.startDate : body.startDate,
    endDate: body.endDate === undefined ? base.endDate : body.endDate,
    minDelaySec: body.minDelaySec ?? base.minDelaySec,
    maxDelaySec: body.maxDelaySec ?? base.maxDelaySec,
  };
}

type Validated =
  | { ok: true; input: ZaloBroadcastInput; plan: BroadcastPlan }
  | Failure;

/** Validate a full campaign definition; budget errors are reported through `plan.errors`. */
function validateInput(body: BroadcastBody): Validated {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return fail(422, 'NAME_REQUIRED', 'Tên lịch gửi là bắt buộc');
  if (name.length > MAX_NAME_LENGTH) return fail(422, 'NAME_TOO_LONG', `Tên lịch gửi tối đa ${MAX_NAME_LENGTH} ký tự`);

  const accountId = typeof body.accountId === 'string' ? body.accountId : '';
  const account = accountId ? getZaloAccount(accountId) : undefined;
  if (!account) return fail(422, 'ACCOUNT_NOT_FOUND', 'Không tìm thấy nick Zalo');
  if (!account.chat_enabled) {
    return fail(409, 'NICK_CHAT_DISABLED', 'Nick đang ở chế độ chỉ nhận tin, hãy bật gửi tin cho nick trước');
  }

  const templateId = Number(body.templateId);
  const template = Number.isInteger(templateId) && templateId > 0 ? getZaloTemplate(templateId) : undefined;
  if (!template) return fail(422, 'TEMPLATE_NOT_FOUND', 'Không tìm thấy mẫu tin');
  const hasText = template.text.trim().length > 0;
  if (!hasText && template.attachments.length === 0) {
    return fail(422, 'TEMPLATE_EMPTY', 'Mẫu tin rỗng, không có gì để gửi');
  }

  const targetThreadIds = [...new Set(toIntArray(body.targetThreadIds))];
  if (targetThreadIds.length === 0) return fail(422, 'GROUPS_REQUIRED', 'Chọn ít nhất 1 nhóm');
  if (targetThreadIds.length > MAX_GROUPS_PER_BROADCAST) {
    return fail(422, 'TOO_MANY_GROUPS', `Tối đa ${MAX_GROUPS_PER_BROADCAST} nhóm mỗi lịch gửi`);
  }
  const foreign = targetThreadIds.filter((id) => {
    const t = getZaloThread(id);
    return !t || t.thread_type !== 'group' || t.account_id !== accountId;
  });
  if (foreign.length > 0) {
    return fail(422, 'GROUP_NOT_OF_ACCOUNT', 'Một số nhóm đã chọn không thuộc nick này', { threadIds: foreign });
  }

  const rawKind = typeof body.scheduleKind === 'string' ? body.scheduleKind : 'now';
  if (!SCHEDULE_KINDS.includes(rawKind as ScheduleKind)) return fail(422, 'INVALID_SCHEDULE', 'Kiểu lịch không hợp lệ');
  const scheduleKind = rawKind as ScheduleKind;
  const normalized = normalizeSchedule({
    timesOfDay: toStringArray(body.timesOfDay),
    daysOfWeek: toIntArray(body.daysOfWeek),
    daysOfMonth: toIntArray(body.daysOfMonth),
  });
  const timezone = typeof body.timezone === 'string' && body.timezone.trim() ? body.timezone.trim() : DEFAULT_TIMEZONE;
  const startDate = toDateString(body.startDate);
  const endDate = toDateString(body.endDate);
  const scheduleCheck = validateSchedule({ scheduleKind, ...normalized, timezone, startDate, endDate });
  if (!scheduleCheck.ok) {
    return fail(422, 'INVALID_SCHEDULE', scheduleCheck.errors.map((e) => SCHEDULE_ERROR_MESSAGE[e]).join('. '), {
      errors: scheduleCheck.errors,
    });
  }

  const minDelaySec = Math.round(Number(body.minDelaySec ?? DEFAULT_MIN_DELAY_SEC));
  const maxDelaySec = Math.round(Number(body.maxDelaySec ?? DEFAULT_MAX_DELAY_SEC));
  if (!Number.isFinite(minDelaySec) || minDelaySec < MIN_DELAY_FLOOR_SEC) {
    return fail(422, 'DELAY_TOO_SHORT', `Giãn cách giữa 2 nhóm tối thiểu ${MIN_DELAY_FLOOR_SEC} giây để nick không bị Zalo khoá`);
  }
  if (!Number.isFinite(maxDelaySec) || maxDelaySec < minDelaySec || maxDelaySec > MAX_DELAY_CAP_SEC) {
    return fail(422, 'INVALID_DELAY_RANGE', `Giãn cách tối đa phải nằm giữa ${minDelaySec} và ${MAX_DELAY_CAP_SEC} giây`);
  }

  const plan = evaluateBroadcastPlan({
    groupCount: targetThreadIds.length,
    hasText,
    attachments: template.attachments,
    timesPerDay: scheduleKind === 'now' ? 1 : normalized.timesOfDay.length,
    timesOfDay: normalized.timesOfDay,
    minDelaySec,
    maxDelaySec,
    ...getBroadcastBudgetInputs(account),
  });

  return {
    ok: true,
    plan,
    input: {
      name, accountId, templateId, targetThreadIds, scheduleKind, timezone, startDate, endDate, minDelaySec, maxDelaySec,
      timesOfDay: normalized.timesOfDay,
      daysOfWeek: normalized.daysOfWeek,
      daysOfMonth: normalized.daysOfMonth,
    },
  };
}

/** The first blocking plan error as a response, or null when the plan is fine. */
function planBlocker(plan: BroadcastPlan): Failure | null {
  const err: BroadcastIssue | undefined = plan.errors[0];
  return err ? fail(422, err.code, err.message, { plan }) : null;
}

// ── Presenters ───────────────────────────────────────────────────────

function presentRun(r: ZaloBroadcastRunRow) {
  return {
    id: r.id,
    scheduledFor: r.scheduled_for,
    triggeredBy: r.triggered_by,
    state: r.state,
    skipReason: r.skip_reason,
    totalTargets: r.total_targets,
    sentCount: r.sent_count,
    failedCount: r.failed_count,
    skippedCount: r.skipped_count,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

function presentTarget(t: ZaloBroadcastTargetRow) {
  const thread = getZaloThread(t.thread_id);
  return {
    id: t.id,
    threadId: t.thread_id,
    groupName: thread?.name || `Nhóm #${t.thread_id}`,
    state: t.state,
    attempts: t.attempts,
    sentSteps: t.sent_steps,
    errorCode: t.error_code,
    errorMessage: t.error_message,
    sentAt: t.sent_at,
  };
}

function presentBroadcast(b: ZaloBroadcastRow) {
  const account = getZaloAccount(b.account_id);
  const lastRun = getLatestZaloBroadcastRun(b.id);
  return {
    id: b.id,
    name: b.name,
    accountId: b.account_id,
    accountName: account ? account.display_name || account.label : '',
    templateId: b.template_id,
    templateName: getZaloTemplate(b.template_id)?.name ?? null,
    targetThreadIds: b.target_thread_ids,
    scheduleKind: b.schedule_kind,
    timesOfDay: b.times_of_day,
    daysOfWeek: b.days_of_week,
    daysOfMonth: b.days_of_month,
    timezone: b.timezone,
    startDate: b.start_date,
    endDate: b.end_date,
    minDelaySec: b.min_delay_sec,
    maxDelaySec: b.max_delay_sec,
    state: b.state,
    pausedReason: b.paused_reason,
    consecutiveFailedRuns: b.consecutive_failed_runs,
    nextRunAt: b.next_run_at,
    createdAt: b.created_at,
    updatedAt: b.updated_at,
    lastRun: lastRun ? presentRun(lastRun) : null,
  };
}

function nextRunSec(b: ZaloBroadcastRow): number | null {
  if (b.schedule_kind === 'now') return null;
  const next = nextRunAt(scheduleSpecOf(b), new Date());
  return next ? Math.floor(next.getTime() / 1000) : null;
}

// ── Routes ───────────────────────────────────────────────────────────

export function registerZaloGroupBroadcastRoutes(app: Hono): void {
  app.get(BASE, (c) => c.json({ broadcasts: listZaloBroadcasts().map(presentBroadcast) }));

  // Live cost panel of the editor. Never a 4xx for plan problems: it reports them.
  app.post(`${BASE}/preview-cost`, async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const account = typeof body.accountId === 'string' ? getZaloAccount(body.accountId) : undefined;
    if (!account) return c.json({ error: 'Chọn nick Zalo để tính ngân sách', code: 'ACCOUNT_NOT_FOUND' }, 422);
    const templateId = Number(body.templateId);
    const template = Number.isInteger(templateId) && templateId > 0 ? getZaloTemplate(templateId) : undefined;
    const kind = typeof body.scheduleKind === 'string' && SCHEDULE_KINDS.includes(body.scheduleKind as ScheduleKind)
      ? (body.scheduleKind as ScheduleKind) : 'now';
    const timesOfDay = [...new Set(toStringArray(body.timesOfDay))];
    const groupCount = Array.isArray(body.targetThreadIds)
      ? new Set(toIntArray(body.targetThreadIds)).size
      : Math.max(0, Math.round(Number(body.groupCount) || 0));
    const minDelay = Number(body.minDelaySec ?? DEFAULT_MIN_DELAY_SEC);
    const maxDelay = Number(body.maxDelaySec ?? DEFAULT_MAX_DELAY_SEC);

    const plan = evaluateBroadcastPlan({
      groupCount,
      hasText: (template?.text.trim().length ?? 0) > 0,
      attachments: template?.attachments ?? [],
      timesPerDay: kind === 'now' ? 1 : timesOfDay.length,
      timesOfDay: kind === 'now' ? [] : timesOfDay,
      minDelaySec: Number.isFinite(minDelay) ? minDelay : DEFAULT_MIN_DELAY_SEC,
      maxDelaySec: Number.isFinite(maxDelay) ? maxDelay : DEFAULT_MAX_DELAY_SEC,
      ...getBroadcastBudgetInputs(account),
    });
    // Without a template there is nothing to cost yet; don't scold before the operator picked one.
    if (!template) plan.errors = plan.errors.filter((e) => e.code !== 'TEMPLATE_EMPTY');
    return c.json(plan);
  });

  app.get(`${BASE}/:id`, (c) => {
    const b = getZaloBroadcast(intParam(c.req.param('id')));
    if (!b) return c.json({ error: 'Không tìm thấy lịch gửi' }, 404);
    const runs = listZaloBroadcastRuns(b.id, DETAIL_RUNS).map((r, i) => ({
      ...presentRun(r),
      targets: i < DETAIL_RUNS_WITH_TARGETS ? listZaloBroadcastTargets(r.id).map(presentTarget) : undefined,
    }));
    return c.json({
      broadcast: presentBroadcast(b),
      groups: b.target_thread_ids.map((id) => ({ threadId: id, name: getZaloThread(id)?.name || `Nhóm #${id}` })),
      runs,
    });
  });

  app.post(BASE, async (c) => {
    const body = await c.req.json<BroadcastBody>().catch(() => ({} as BroadcastBody));
    const v = validateInput(body);
    if (!v.ok) return respondFailure(c, v);
    // Hard caps always apply; the budget is enforced when the campaign goes active.
    const hard = v.plan.errors.find((e) => e.code === 'TOO_MANY_GROUPS' || e.code === 'TOO_MANY_TIMES');
    if (hard) return respondFailure(c, fail(422, hard.code, hard.message));
    const created = createZaloBroadcast(v.input);
    return c.json({ broadcast: presentBroadcast(created), plan: v.plan }, 201);
  });

  const update = async (c: Context) => {
    const current = getZaloBroadcast(intParam(c.req.param('id')));
    if (!current) return c.json({ error: 'Không tìm thấy lịch gửi' }, 404);
    if (current.state === 'completed' || current.state === 'cancelled') {
      return c.json({ error: 'Lịch đã kết thúc, không sửa được. Hãy tạo lịch mới.', code: 'BROADCAST_CLOSED' }, 409);
    }
    const body = await c.req.json<BroadcastBody>().catch(() => ({} as BroadcastBody));
    const v = validateInput(mergeBody(body, current));
    if (!v.ok) return respondFailure(c, v);
    // An active campaign must stay inside the budget, otherwise editing would bypass the activate check.
    const blocker = current.state === 'active' ? planBlocker(v.plan) : null;
    if (blocker) return respondFailure(c, blocker);

    updateZaloBroadcast(current.id, v.input);
    if (current.state === 'active') {
      // Times that match the new schedule but lie in the past must not be caught up.
      const fresh = getZaloBroadcast(current.id)!;
      setZaloBroadcastState(fresh.id, 'active', { activatedAt: nowSec(), nextRunAt: nextRunSec(fresh) });
    }
    return c.json({ broadcast: presentBroadcast(getZaloBroadcast(current.id)!), plan: v.plan });
  };
  app.patch(`${BASE}/:id`, update);
  app.put(`${BASE}/:id`, update);

  app.post(`${BASE}/:id/activate`, (c) => {
    const b = getZaloBroadcast(intParam(c.req.param('id')));
    if (!b) return c.json({ error: 'Không tìm thấy lịch gửi' }, 404);
    if (b.state !== 'draft' && b.state !== 'paused') {
      return c.json({ error: 'Chỉ kích hoạt được lịch đang ở trạng thái nháp hoặc tạm dừng', code: 'INVALID_STATE' }, 409);
    }
    const v = validateInput(inputOf(b));
    if (!v.ok) return respondFailure(c, v);
    const blocker = planBlocker(v.plan);
    if (blocker) return respondFailure(c, blocker);

    const now = nowSec();
    setZaloBroadcastState(b.id, 'active', { activatedAt: now, nextRunAt: nextRunSec(b), consecutiveFailedRuns: 0 });
    // A "send now" campaign has no times: activating it is the trigger.
    if (b.schedule_kind === 'now' && !materializeBroadcastRun(b, now, 'manual')) {
      return c.json({ error: 'Vừa có lượt gửi được tạo, thử lại sau vài giây', code: 'RUN_EXISTS' }, 409);
    }
    return c.json({ broadcast: presentBroadcast(getZaloBroadcast(b.id)!), plan: v.plan });
  });

  app.post(`${BASE}/:id/pause`, (c) => {
    const b = getZaloBroadcast(intParam(c.req.param('id')));
    if (!b) return c.json({ error: 'Không tìm thấy lịch gửi' }, 404);
    if (b.state !== 'active') return c.json({ error: 'Chỉ tạm dừng được lịch đang chạy', code: 'INVALID_STATE' }, 409);
    setZaloBroadcastState(b.id, 'paused', { pausedReason: 'MANUAL', nextRunAt: null });
    return c.json({ broadcast: presentBroadcast(getZaloBroadcast(b.id)!) });
  });

  app.post(`${BASE}/:id/resume`, (c) => {
    const b = getZaloBroadcast(intParam(c.req.param('id')));
    if (!b) return c.json({ error: 'Không tìm thấy lịch gửi' }, 404);
    if (b.state !== 'paused') return c.json({ error: 'Chỉ tiếp tục được lịch đang tạm dừng', code: 'INVALID_STATE' }, 409);
    const v = validateInput(inputOf(b));
    if (!v.ok) return respondFailure(c, v);
    const blocker = planBlocker(v.plan);
    if (blocker) return respondFailure(c, blocker);
    // Resuming restarts the clock: the times missed while paused are not sent.
    setZaloBroadcastState(b.id, 'active', { activatedAt: nowSec(), nextRunAt: nextRunSec(b), consecutiveFailedRuns: 0 });
    return c.json({ broadcast: presentBroadcast(getZaloBroadcast(b.id)!) });
  });

  app.post(`${BASE}/:id/cancel`, (c) => {
    const b = getZaloBroadcast(intParam(c.req.param('id')));
    if (!b) return c.json({ error: 'Không tìm thấy lịch gửi' }, 404);
    if (b.state === 'cancelled' || b.state === 'completed') {
      return c.json({ error: 'Lịch đã kết thúc', code: 'INVALID_STATE' }, 409);
    }
    setZaloBroadcastState(b.id, 'cancelled', { nextRunAt: null });
    return c.json({ broadcast: presentBroadcast(getZaloBroadcast(b.id)!) });
  });

  app.post(`${BASE}/:id/run-now`, (c) => {
    const b = getZaloBroadcast(intParam(c.req.param('id')));
    if (!b) return c.json({ error: 'Không tìm thấy lịch gửi' }, 404);
    if (b.state === 'cancelled') return c.json({ error: 'Lịch đã bị huỷ', code: 'INVALID_STATE' }, 409);
    if (hasActiveZaloBroadcastRun(b.id)) {
      return c.json({ error: 'Đang có một lượt gửi chạy hoặc chờ chạy, hãy đợi lượt đó xong', code: 'RUN_ACTIVE' }, 409);
    }
    const run = materializeBroadcastRun(b, nowSec(), 'manual');
    if (!run) return c.json({ error: 'Vừa có lượt gửi được tạo, thử lại sau vài giây', code: 'RUN_EXISTS' }, 409);
    return c.json({ run: presentRun(run) }, 201);
  });

  app.post(`${BASE}/:id/retry-failed`, (c) => {
    const b = getZaloBroadcast(intParam(c.req.param('id')));
    if (!b) return c.json({ error: 'Không tìm thấy lịch gửi' }, 404);
    if (b.state === 'cancelled') return c.json({ error: 'Lịch đã bị huỷ', code: 'INVALID_STATE' }, 409);
    if (hasActiveZaloBroadcastRun(b.id)) {
      return c.json({ error: 'Đang có một lượt gửi chạy hoặc chờ chạy, hãy đợi lượt đó xong', code: 'RUN_ACTIVE' }, 409);
    }
    const latest = getLatestZaloBroadcastRun(b.id);
    if (!latest) return c.json({ error: 'Chưa có lượt gửi nào', code: 'NO_RUN' }, 409);

    // Failed groups plus groups left pending when the run stopped (quiet hours, budget...).
    const retryable = listZaloBroadcastTargets(latest.id).filter(
      (t) => (t.state === 'failed' || t.state === 'pending') && t.attempts < MAX_TARGET_ATTEMPTS,
    );
    if (retryable.length === 0) return c.json({ error: 'Không có nhóm lỗi cần gửi lại', code: 'NOTHING_TO_RETRY' }, 409);

    // Carry over delivered steps and attempts so a retry never repeats a message the group already got.
    const run = materializeBroadcastRun(b, nowSec(), 'retry', retryable.map((t) => ({
      threadId: t.thread_id, attempts: t.attempts, sentSteps: t.sent_steps, messageIds: t.message_ids,
    })));
    if (!run) return c.json({ error: 'Vừa có lượt gửi được tạo, thử lại sau vài giây', code: 'RUN_EXISTS' }, 409);
    return c.json({ run: presentRun(run), retrying: retryable.length }, 201);
  });

  app.delete(`${BASE}/:id`, (c) => {
    const b = getZaloBroadcast(intParam(c.req.param('id')));
    if (!b) return c.json({ error: 'Không tìm thấy lịch gửi' }, 404);
    if (b.state === 'active' || b.state === 'paused') {
      return c.json({ error: 'Hãy huỷ lịch trước khi xoá', code: 'INVALID_STATE' }, 409);
    }
    if (hasActiveZaloBroadcastRun(b.id)) {
      return c.json({ error: 'Đang có một lượt gửi chạy hoặc chờ chạy, chưa xoá được', code: 'RUN_ACTIVE' }, 409);
    }
    deleteZaloBroadcast(b.id);
    return c.json({ ok: true });
  });
}
