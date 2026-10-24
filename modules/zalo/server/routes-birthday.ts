/**
 * /api/m/zalo/birthday/* and PATCH /api/m/zalo/threads/:id/birth-date — dashboard
 * side of the birthday greetings feature. Mounted by dashboard-routes.ts behind
 * the module's /api/m/zalo sub-app. The dashboard only
 * writes rows; the daemon's birthday worker picks them up within a minute.
 */

import type { Context, Hono } from 'hono';

import {
  getZaloBirthdayConfig,
  getZaloBirthdayGreeting,
  getZaloBirthdayStats,
  getZaloBirthdayThread,
  getZaloProtectionSettings,
  getZaloTemplate,
  insertZaloBirthdayGreeting,
  listZaloAccounts,
  listZaloBirthdayGreetings,
  listZaloBirthdayGreetingsByBirthday,
  saveZaloBirthdayConfig,
  setZaloThreadBirthDate,
  updateZaloBirthdayGreeting,
  type ZaloBirthdayConfig,
  type ZaloBirthdayGreetingListRow,
  type ZaloBirthdayGreetingRow,
  type ZaloBirthdayOccasion,
  type ZaloBirthdayState,
} from './store.js';
import { celebratedOnFor, listUpcomingBirthdays, safeTimezone, templateIdFor } from './birthday.js';
import {
  addDays,
  BIRTHDAY_OCCASIONS,
  calendarDateUtc,
  isOccasionEnabled,
  minutesOfDay,
  normalizeBirthDateInput,
  occasionOffsetDays,
  validateBirthdayConfig,
  zonedDateParts,
  zonedWallClockToUtc,
} from './birthday-schedule.js';

const STATES: ZaloBirthdayState[] = ['pending', 'sent', 'failed', 'skipped'];

function intParam(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function num(v: unknown, fallback: number): number {
  if (v === undefined || v === null || v === '') return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function templateIdOrNull(v: unknown, fallback: number | null): number | null {
  if (v === undefined) return fallback;
  if (v === null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : NaN;
}

/** The send time as the protection quiet-hours clock sees it (the two timezones may differ). */
function sendTimeInQuietHours(cfg: ZaloBirthdayConfig, now: Date): boolean {
  const { quietHours, timezone: quietTz } = getZaloProtectionSettings();
  if (!quietHours.enabled) return false;
  const minutes = minutesOfDay(cfg.sendTime);
  if (minutes === null) return false;
  const tz = safeTimezone(cfg.timezone);
  const day = zonedDateParts(now, tz);
  const at = zonedWallClockToUtc(day.year, day.month, day.day, Math.floor(minutes / 60), minutes % 60, tz);
  let local: string;
  try {
    local = new Intl.DateTimeFormat('en-GB', { timeZone: quietTz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
  } catch {
    local = cfg.sendTime;
  }
  const t = minutesOfDay(local);
  const s = minutesOfDay(quietHours.start);
  const e = minutesOfDay(quietHours.end);
  if (t === null || s === null || e === null || s === e) return false;
  return s < e ? t >= s && t < e : t >= s || t < e;
}

function presentConfig(cfg: ZaloBirthdayConfig) {
  const settings = getZaloProtectionSettings();
  return {
    config: cfg,
    quietHours: settings.quietHours,
    sendTimeInQuietHours: sendTimeInQuietHours(cfg, new Date()),
  };
}

function presentGreeting(g: ZaloBirthdayGreetingListRow) {
  return {
    id: g.id,
    threadId: g.thread_id,
    name: g.thread_name,
    accountId: g.account_id,
    accountLabel: g.account_label,
    occasion: g.occasion,
    birthdayOn: g.birthday_on,
    dueAt: g.due_at,
    state: g.state,
    skipReason: g.skip_reason,
    errorCode: g.error_code,
    sentSteps: g.sent_steps,
    sentAt: g.sent_at,
  };
}

function presentBare(g: ZaloBirthdayGreetingRow) {
  return {
    id: g.id, threadId: g.thread_id, occasion: g.occasion, birthdayOn: g.birthday_on,
    dueAt: g.due_at, state: g.state, skipReason: g.skip_reason,
  };
}

/** Merge a request body over the stored config; returns Vietnamese errors instead of a config when invalid. */
function parseConfigBody(body: Record<string, unknown>, current: ZaloBirthdayConfig): { cfg?: Omit<ZaloBirthdayConfig, 'updatedAt'>; errors: string[] } {
  const errors: string[] = [];
  let accountIds = current.accountIds;
  if (body.accountIds !== undefined) {
    if (!Array.isArray(body.accountIds)) errors.push('Danh sách nick không hợp lệ');
    else {
      const known = new Set(listZaloAccounts().map((a) => a.id));
      accountIds = [...new Set(body.accountIds.map(String))];
      if (accountIds.some((id) => !known.has(id))) errors.push('Có nick không tồn tại');
    }
  }
  const sendTime = body.sendTime === undefined ? current.sendTime : String(body.sendTime).trim();
  const timezone = body.timezone === undefined ? current.timezone : String(body.timezone).trim();
  const cfg = {
    enabled: bool(body.enabled, current.enabled),
    sendTime,
    timezone,
    lateToleranceMinutes: num(body.lateToleranceMinutes, current.lateToleranceMinutes),
    beforeEnabled: bool(body.beforeEnabled, current.beforeEnabled),
    beforeDays: num(body.beforeDays, current.beforeDays),
    beforeTemplateId: templateIdOrNull(body.beforeTemplateId, current.beforeTemplateId),
    onDayEnabled: bool(body.onDayEnabled, current.onDayEnabled),
    onDayTemplateId: templateIdOrNull(body.onDayTemplateId, current.onDayTemplateId),
    afterEnabled: bool(body.afterEnabled, current.afterEnabled),
    afterDays: num(body.afterDays, current.afterDays),
    afterTemplateId: templateIdOrNull(body.afterTemplateId, current.afterTemplateId),
    perNickDailyQuota: num(body.perNickDailyQuota, current.perNickDailyQuota),
    minDelaySec: num(body.minDelaySec, current.minDelaySec),
    maxDelaySec: num(body.maxDelaySec, current.maxDelaySec),
    accountIds,
  };
  errors.push(...validateBirthdayConfig(cfg));
  const occasionTemplates: Array<[string, boolean, number | null]> = [
    ['trước sinh nhật', cfg.beforeEnabled, cfg.beforeTemplateId],
    ['đúng ngày sinh nhật', cfg.onDayEnabled, cfg.onDayTemplateId],
    ['sau sinh nhật', cfg.afterEnabled, cfg.afterTemplateId],
  ];
  for (const [label, enabled, id] of occasionTemplates) {
    if (id !== null && (!Number.isInteger(id) || !getZaloTemplate(id))) errors.push(`Mẫu tin dịp ${label} không tồn tại`);
    else if (cfg.enabled && enabled && id === null) errors.push(`Hãy chọn mẫu tin cho dịp ${label}`);
  }
  if (cfg.enabled && !cfg.beforeEnabled && !cfg.onDayEnabled && !cfg.afterEnabled) errors.push('Hãy bật ít nhất một dịp chúc');
  return errors.length > 0 ? { errors: [...new Set(errors)] } : { cfg, errors };
}

/** Send-now / skip, shared by the by-id and by-key routes. */
function applyAction(c: Context, action: 'send-now' | 'skip', g: ZaloBirthdayGreetingRow) {
  if (action === 'skip') {
    if (g.state !== 'pending') return c.json({ error: 'Chỉ bỏ qua được lời chúc đang chờ gửi' }, 409);
    updateZaloBirthdayGreeting(g.id, { state: 'skipped', skipReason: 'MANUAL' });
  } else {
    if (g.state === 'sent') return c.json({ error: 'Lời chúc này đã được gửi' }, 409);
    if (!getZaloBirthdayConfig().enabled) return c.json({ error: 'Chúc mừng sinh nhật đang tắt — hãy bật trước khi gửi' }, 409);
    const thread = getZaloBirthdayThread(g.thread_id);
    if (!thread) return c.json({ error: 'Không tìm thấy hội thoại của khách' }, 404);
    if (thread.opted_out === 1) return c.json({ error: 'Khách đã từ chối nhận tin' }, 409);
    // Re-queued with its delivered steps kept, so a retry never repeats a message.
    updateZaloBirthdayGreeting(g.id, {
      state: 'pending', skipReason: '', errorCode: '', dueAt: Math.floor(Date.now() / 1000), forced: true,
    });
  }
  return c.json({ greeting: presentBare(getZaloBirthdayGreeting(g.id)!) });
}

export function registerZaloBirthdayRoutes(app: Hono): void {
  app.get('/birthday/config', (c) => c.json(presentConfig(getZaloBirthdayConfig())));

  app.put('/birthday/config', async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body || typeof body !== 'object') return c.json({ error: 'Dữ liệu không hợp lệ' }, 400);
    const { cfg, errors } = parseConfigBody(body, getZaloBirthdayConfig());
    if (!cfg) return c.json({ error: errors.join('. ') }, 400);
    return c.json(presentConfig(saveZaloBirthdayConfig(cfg)));
  });

  app.get('/birthday/stats', (c) => {
    const nicks = getZaloBirthdayStats();
    const threads = nicks.reduce((n, s) => n + s.threads, 0);
    const withBirthDate = nicks.reduce((n, s) => n + s.withBirthDate, 0);
    return c.json({ threads, withBirthDate, nicks });
  });

  app.get('/birthday/upcoming', (c) => {
    const days = Math.min(Math.max(intParam(c.req.query('days'), 14), 1), 60);
    const items = listUpcomingBirthdays(new Date(), days);
    const labels = new Map(listZaloAccounts().map((a) => [a.id, a.display_name || a.label]));
    return c.json({
      upcoming: items.map((u) => ({ ...u, accountLabel: labels.get(u.accountId) ?? '' })),
    });
  });

  app.get('/birthday/greetings', (c) => {
    const states = (c.req.query('state') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (states.some((s) => !STATES.includes(s as ZaloBirthdayState))) return c.json({ error: 'Trạng thái không hợp lệ' }, 400);
    const { greetings, total } = listZaloBirthdayGreetings({
      states: states as ZaloBirthdayState[],
      limit: intParam(c.req.query('limit'), 50),
      offset: intParam(c.req.query('offset'), 0),
    });
    return c.json({ greetings: greetings.map(presentGreeting), total });
  });

  // Registered before the :id routes: '/greetings/by-key/skip' would match '/greetings/:id/skip'.
  // A greeting that is not queued yet (a birthday later in the 14-day view)
  // can be sent now or skipped too: create its row first, then apply.
  app.post('/birthday/greetings/by-key/:action', async (c) => {
    const action = c.req.param('action');
    if (action !== 'send-now' && action !== 'skip') return c.json({ error: 'Thao tác không hợp lệ' }, 400);
    const body = await c.req.json<{ threadId?: unknown; occasion?: unknown; birthdayOn?: unknown }>().catch(() => ({} as Record<string, unknown>));
    const threadId = Number(body.threadId);
    const occasion = String(body.occasion) as ZaloBirthdayOccasion;
    const birthdayOn = String(body.birthdayOn ?? '');
    if (!Number.isInteger(threadId) || !BIRTHDAY_OCCASIONS.includes(occasion) || !/^\d{4}-\d{2}-\d{2}$/.test(birthdayOn)) {
      return c.json({ error: 'Dữ liệu không hợp lệ' }, 400);
    }
    const thread = getZaloBirthdayThread(threadId);
    if (!thread || thread.thread_type !== 'user') return c.json({ error: 'Không tìm thấy hội thoại 1-1' }, 404);
    if (!thread.birth_date || !celebratedOnFor(thread.birth_date, birthdayOn)) {
      return c.json({ error: 'Ngày sinh nhật không khớp với ngày sinh của khách' }, 400);
    }
    const cfg = getZaloBirthdayConfig();
    const spec = {
      timezone: safeTimezone(cfg.timezone), sendTime: cfg.sendTime, lateToleranceMinutes: cfg.lateToleranceMinutes,
      beforeEnabled: cfg.beforeEnabled, beforeDays: cfg.beforeDays, onDayEnabled: cfg.onDayEnabled,
      afterEnabled: cfg.afterEnabled, afterDays: cfg.afterDays,
    };
    if (!isOccasionEnabled(spec, occasion)) return c.json({ error: 'Dịp chúc này đang tắt' }, 409);
    if (templateIdFor(cfg, occasion) === null) return c.json({ error: 'Dịp chúc này chưa chọn mẫu tin' }, 409);

    const [y, m, d] = birthdayOn.split('-').map(Number);
    const sendDay = addDays(calendarDateUtc({ year: y, month: m, day: d }), -occasionOffsetDays(spec, occasion));
    const minutes = minutesOfDay(cfg.sendTime) ?? 540;
    const dueAt = Math.floor(zonedWallClockToUtc(
      sendDay.getUTCFullYear(), sendDay.getUTCMonth() + 1, sendDay.getUTCDate(),
      Math.floor(minutes / 60), minutes % 60, spec.timezone,
    ).getTime() / 1000);
    insertZaloBirthdayGreeting({ threadId, accountId: thread.account_id, occasion, birthdayOn, dueAt });
    const g = listZaloBirthdayGreetingsByBirthday(birthdayOn, birthdayOn).find((r) => r.thread_id === threadId && r.occasion === occasion);
    if (!g) return c.json({ error: 'Không tạo được lời chúc' }, 500);
    return applyAction(c, action, g);
  });

  app.post('/birthday/greetings/:id/send-now', (c) => {
    const g = getZaloBirthdayGreeting(intParam(c.req.param('id'), 0));
    if (!g) return c.json({ error: 'Không tìm thấy lời chúc' }, 404);
    return applyAction(c, 'send-now', g);
  });

  app.post('/birthday/greetings/:id/skip', (c) => {
    const g = getZaloBirthdayGreeting(intParam(c.req.param('id'), 0));
    if (!g) return c.json({ error: 'Không tìm thấy lời chúc' }, 404);
    return applyAction(c, 'skip', g);
  });

  app.get('/threads/:id/birth-date', (c) => {
    const thread = getZaloBirthdayThread(intParam(c.req.param('id'), 0));
    if (!thread) return c.json({ error: 'Không tìm thấy hội thoại' }, 404);
    return c.json({ birthDate: thread.birth_date });
  });

  app.patch('/threads/:id/birth-date', async (c) => {
    const thread = getZaloBirthdayThread(intParam(c.req.param('id'), 0));
    if (!thread) return c.json({ error: 'Không tìm thấy hội thoại' }, 404);
    if (thread.thread_type !== 'user') return c.json({ error: 'Chỉ đặt được ngày sinh cho hội thoại 1-1' }, 400);
    const body = await c.req.json<{ birthDate?: unknown }>().catch(() => ({} as { birthDate?: unknown }));
    if (!('birthDate' in body)) return c.json({ error: 'Thiếu birthDate' }, 400);
    let birthDate: string | null = null;
    if (body.birthDate !== null) {
      birthDate = normalizeBirthDateInput(body.birthDate);
      if (!birthDate) return c.json({ error: 'Ngày sinh không hợp lệ (dùng YYYY-MM-DD hoặc MM-DD)' }, 400);
    }
    setZaloThreadBirthDate(thread.id, birthDate);
    return c.json({ birthDate });
  });
}
