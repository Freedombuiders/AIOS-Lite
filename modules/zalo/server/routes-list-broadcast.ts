/**
 * /api/m/zalo/list-broadcasts — dashboard endpoints for 1-1 list broadcasts.
 * Mounted by dashboard-routes.ts. The dashboard only writes rows; the daemon's
 * list-broadcast worker picks active campaigns up within a minute.
 */

import type { Context, Hono } from 'hono';

import {
  countZaloListRecipients,
  countZaloListSent,
  createZaloListBroadcast,
  deleteZaloListBroadcast,
  getZaloAccount,
  getZaloProtectionSettings,
  getZaloListBroadcast,
  getZaloTemplate,
  listZaloListBatches,
  listZaloListBroadcasts,
  listZaloListRecipients,
  requeueFailedZaloListRecipients,
  setZaloListBroadcastState,
  skipZaloListRecipient,
  skipZaloListRecipientsOutsideAccounts,
  updateZaloListBroadcast,
  getZaloListRecipient,
  type ZaloListBroadcast,
  type ZaloListBroadcastInput,
  type ZaloListFilter,
  type ZaloListRecipientState,
} from './store.js';
import { effectiveMessageCap } from './limits.js';
import { DEFAULT_TIMEZONE } from './marketing-deps.js';
import {
  estimateListBroadcast,
  MAX_DAILY_QUOTA,
  MAX_DELAY_CAP_SEC,
  MAX_NICKS_PER_BROADCAST,
  MAX_RECIPIENT_ATTEMPTS,
  MIN_DELAY_FLOOR_SEC,
  selectListCandidates,
  syncListRecipients,
  windowSpecOf,
} from './list-broadcast.js';
import { dayBounds, isWithinWindow, nextWindowOpen, validateWindow } from './send-window.js';

const RECIPIENT_STATES = new Set<ZaloListRecipientState>(['pending', 'sent', 'failed', 'skipped']);
const EDITABLE_STATES = new Set(['draft', 'paused']);

class BadRequest extends Error {}

function bad(message: string): never {
  throw new BadRequest(message);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function intIn(v: unknown, min: number, max: number, label: string): number {
  const n = typeof v === 'number' ? v : Number.NaN;
  if (!Number.isInteger(n) || n < min || n > max) bad(`${label} phải là số nguyên từ ${min} đến ${max}`);
  return n;
}

function idList(v: unknown, label: string): number[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 5000 || v.some((x) => !Number.isInteger(x) || x <= 0)) bad(`${label} không hợp lệ`);
  return [...new Set(v as number[])];
}

function parseFilter(raw: unknown): ZaloListFilter {
  if (raw === undefined || raw === null) return { excludePaused: true };
  if (!isObj(raw)) bad('Bộ lọc người nhận không hợp lệ');
  const filter: ZaloListFilter = { excludePaused: raw.excludePaused !== false };
  if (raw.activeWithinDays !== undefined && raw.activeWithinDays !== null && raw.activeWithinDays !== '') {
    filter.activeWithinDays = intIn(raw.activeWithinDays, 1, 3650, 'Số ngày hoạt động');
  }
  if (typeof raw.nameContains === 'string' && raw.nameContains.trim()) {
    if (raw.nameContains.length > 100) bad('Từ khoá tên quá dài');
    filter.nameContains = raw.nameContains.trim();
  }
  const exclude = idList(raw.excludeThreadIds, 'Danh sách loại trừ');
  if (exclude.length > 0) filter.excludeThreadIds = exclude;
  const include = idList(raw.includeThreadIds, 'Danh sách thêm thủ công');
  if (include.length > 0) filter.includeThreadIds = include;
  return filter;
}

function parseAccountIds(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) bad('Chọn ít nhất một nick Zalo');
  const ids = [...new Set(raw.map((x) => String(x)))];
  if (ids.length > MAX_NICKS_PER_BROADCAST) bad(`Tối đa ${MAX_NICKS_PER_BROADCAST} nick mỗi chiến dịch`);
  for (const id of ids) if (!getZaloAccount(id)) bad('Có nick Zalo không tồn tại');
  return ids;
}

function dateOrNull(v: unknown, label: string): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) bad(`${label} không hợp lệ`);
  return v;
}

/** Validate a full campaign body (create or edit). Throws BadRequest with a Vietnamese message. */
function parseBroadcastBody(body: unknown): ZaloListBroadcastInput {
  if (!isObj(body)) bad('Dữ liệu không hợp lệ');
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) bad('Tên chiến dịch không được trống');
  if (name.length > 120) bad('Tên chiến dịch quá dài');

  const templateId = intIn(body.templateId, 1, Number.MAX_SAFE_INTEGER, 'Mẫu tin');
  if (!getZaloTemplate(templateId)) bad('Mẫu tin không tồn tại');

  const daysRaw = body.daysOfWeek ?? [];
  if (!Array.isArray(daysRaw)) bad('Ngày trong tuần không hợp lệ');
  const input: ZaloListBroadcastInput = {
    name,
    templateId,
    accountIds: parseAccountIds(body.accountIds),
    filter: parseFilter(body.filter),
    windowStart: typeof body.windowStart === 'string' ? body.windowStart : '08:00',
    windowEnd: typeof body.windowEnd === 'string' ? body.windowEnd : '17:00',
    daysOfWeek: [...new Set(daysRaw as number[])].sort(),
    timezone: typeof body.timezone === 'string' && body.timezone ? body.timezone : DEFAULT_TIMEZONE,
    startDate: dateOrNull(body.startDate, 'Ngày bắt đầu'),
    endDate: dateOrNull(body.endDate, 'Ngày kết thúc'),
    dailyQuota: intIn(body.dailyQuota ?? 100, 1, MAX_DAILY_QUOTA, 'Hạn mức mỗi ngày'),
    perNickDailyQuota: intIn(body.perNickDailyQuota ?? 40, 1, MAX_DAILY_QUOTA, 'Hạn mức mỗi nick'),
    minDelaySec: intIn(body.minDelaySec ?? 45, MIN_DELAY_FLOOR_SEC, MAX_DELAY_CAP_SEC, 'Giãn cách tối thiểu (giây)'),
    maxDelaySec: intIn(body.maxDelaySec ?? 90, MIN_DELAY_FLOOR_SEC, MAX_DELAY_CAP_SEC, 'Giãn cách tối đa (giây)'),
  };
  if (input.maxDelaySec < input.minDelaySec) bad('Giãn cách tối đa phải lớn hơn hoặc bằng tối thiểu');
  const windowErrors = validateWindow(input);
  if (windowErrors.length > 0) bad(windowErrors[0]);
  return input;
}

function presentBroadcast(b: ZaloListBroadcast) {
  const counts = countZaloListRecipients(b.id);
  const day = dayBounds(b.timezone, new Date());
  const template = getZaloTemplate(b.templateId);
  return {
    id: b.id,
    name: b.name,
    templateId: b.templateId,
    templateName: template?.name ?? null,
    accounts: b.accountIds.map((id) => {
      const a = getZaloAccount(id);
      return { id, label: a ? (a.display_name || a.label) : id, exists: !!a };
    }),
    accountIds: b.accountIds,
    filter: b.filter,
    windowStart: b.windowStart,
    windowEnd: b.windowEnd,
    daysOfWeek: b.daysOfWeek,
    timezone: b.timezone,
    startDate: b.startDate,
    endDate: b.endDate,
    dailyQuota: b.dailyQuota,
    perNickDailyQuota: b.perNickDailyQuota,
    minDelaySec: b.minDelaySec,
    maxDelaySec: b.maxDelaySec,
    state: b.state,
    pausedReason: b.pausedReason,
    consecutiveFailedBatches: b.consecutiveFailedBatches,
    recipientsSyncedAt: b.recipientsSyncedAt,
    counts,
    sentToday: countZaloListSent({ broadcastId: b.id }, Math.floor(day.startMs / 1000), Math.floor(day.endMs / 1000)),
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
  };
}

function estimateFor(b: Pick<ZaloListBroadcastInput, 'templateId' | 'accountIds' | 'dailyQuota' | 'perNickDailyQuota' | 'minDelaySec' | 'maxDelaySec' | 'windowStart' | 'windowEnd' | 'daysOfWeek'>, pending: number) {
  const template = getZaloTemplate(b.templateId);
  const sharePercent = getZaloProtectionSettings().bulkSharePercent;
  const budgets = b.accountIds
    .map((id) => getZaloAccount(id))
    .filter((a): a is NonNullable<typeof a> => !!a)
    .map((a) => Math.floor((sharePercent / 100) * effectiveMessageCap(a)));
  return estimateListBroadcast({
    ...(budgets.length > 0 ? { minNickBulkBudget: Math.min(...budgets) } : {}),
    pending,
    nickCount: b.accountIds.length,
    dailyQuota: b.dailyQuota,
    perNickDailyQuota: b.perNickDailyQuota,
    minDelaySec: b.minDelaySec,
    maxDelaySec: b.maxDelaySec,
    hasText: !!template && template.text.trim().length > 0,
    attachmentCount: template?.attachments.length ?? 0,
    window: b,
  });
}

function fail(c: Context, err: unknown) {
  if (err instanceof BadRequest) return c.json({ error: err.message }, 400);
  throw err;
}

async function readBody(c: Context): Promise<unknown> {
  try { return await c.req.json(); } catch { return bad('Dữ liệu không hợp lệ'); }
}

function loadBroadcast(c: Context): ZaloListBroadcast | null {
  const id = parseInt(c.req.param('id') ?? '', 10);
  if (!Number.isFinite(id)) return null;
  return getZaloListBroadcast(id) ?? null;
}

const NOT_FOUND = { error: 'Không tìm thấy chiến dịch' };

export function registerZaloListBroadcastRoutes(app: Hono): void {
  app.get('/list-broadcasts', (c) => {
    return c.json({ broadcasts: listZaloListBroadcasts().map(presentBroadcast) });
  });

  // Live preview while editing the filter, before anything is saved.
  app.post('/list-broadcasts/preview-recipients', async (c) => {
    try {
      const body = await readBody(c);
      if (!isObj(body)) bad('Dữ liệu không hợp lệ');
      const accountIds = parseAccountIds(body.accountIds);
      const filter = parseFilter(body.filter);
      const all = selectListCandidates(accountIds, filter);
      const perAccount: Record<string, number> = {};
      for (const r of all) perAccount[r.accountId] = (perAccount[r.accountId] ?? 0) + 1;
      return c.json({
        count: all.length,
        perAccount,
        sample: all.slice(0, 20).map((r) => ({ threadId: r.threadId, accountId: r.accountId, name: r.name, lastMessageAt: r.lastMessageAt })),
      });
    } catch (err) {
      return fail(c, err);
    }
  });

  // ETA / quota warnings for the editor, before saving.
  app.post('/list-broadcasts/estimate', async (c) => {
    try {
      const body = await readBody(c);
      const input = parseBroadcastBody(body);
      const pending = isObj(body) && Number.isInteger(body.recipientCount) ? Math.max(0, body.recipientCount as number) : 0;
      return c.json({ estimate: estimateFor(input, pending) });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post('/list-broadcasts', async (c) => {
    try {
      const input = parseBroadcastBody(await readBody(c));
      return c.json({ broadcast: presentBroadcast(createZaloListBroadcast(input)) }, 201);
    } catch (err) {
      return fail(c, err);
    }
  });

  app.get('/list-broadcasts/:id', (c) => {
    const b = loadBroadcast(c);
    if (!b) return c.json(NOT_FOUND, 404);
    const counts = countZaloListRecipients(b.id);
    const now = new Date();
    const spec = windowSpecOf(b);
    const next = nextWindowOpen(now, spec);
    return c.json({
      broadcast: presentBroadcast(b),
      batches: listZaloListBatches(b.id, 20).map((x) => ({
        id: x.id, startedAt: x.started_at, finishedAt: x.finished_at,
        sent: x.sent, failed: x.failed, skipped: x.skipped, stopReason: x.stop_reason,
      })),
      windowOpenNow: isWithinWindow(now, spec),
      nextWindowOpenAt: next ? Math.floor(next.getTime() / 1000) : null,
      estimate: estimateFor(b, counts.pending),
    });
  });

  app.get('/list-broadcasts/:id/recipients', (c) => {
    const b = loadBroadcast(c);
    if (!b) return c.json(NOT_FOUND, 404);
    const stateParam = c.req.query('state') as ZaloListRecipientState | undefined;
    const state = stateParam && RECIPIENT_STATES.has(stateParam) ? stateParam : undefined;
    const limit = parseInt(c.req.query('limit') ?? '', 10);
    const offset = parseInt(c.req.query('offset') ?? '', 10);
    const { recipients, total } = listZaloListRecipients(b.id, {
      state,
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number.isFinite(offset) ? offset : 0,
    });
    return c.json({
      total,
      recipients: recipients.map((r) => ({
        id: r.id,
        threadId: r.thread_id,
        accountId: r.account_id,
        name: r.name_snapshot,
        state: r.state,
        sentSteps: r.sent_steps,
        attempts: r.attempts,
        errorCode: r.error_code,
        sentAt: r.sent_at,
      })),
    });
  });

  app.patch('/list-broadcasts/:id', async (c) => {
    try {
      const b = loadBroadcast(c);
      if (!b) return c.json(NOT_FOUND, 404);
      if (!EDITABLE_STATES.has(b.state)) bad('Chỉ sửa được chiến dịch đang nháp hoặc tạm dừng');
      const input = parseBroadcastBody(await readBody(c));
      const updated = updateZaloListBroadcast(b.id, input);
      if (!updated) return c.json(NOT_FOUND, 404);
      // Recipients of nicks no longer in the campaign can't be served any more.
      skipZaloListRecipientsOutsideAccounts(b.id, input.accountIds);
      return c.json({ broadcast: presentBroadcast(updated) });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post('/list-broadcasts/:id/sync-recipients', (c) => {
    const b = loadBroadcast(c);
    if (!b) return c.json(NOT_FOUND, 404);
    if (b.state === 'completed' || b.state === 'cancelled') {
      return c.json({ error: 'Chiến dịch đã kết thúc, không đồng bộ được' }, 409);
    }
    return c.json(syncListRecipients(b));
  });

  app.post('/list-broadcasts/:id/activate', (c) => {
    const b = loadBroadcast(c);
    if (!b) return c.json(NOT_FOUND, 404);
    if (b.state !== 'draft') return c.json({ error: 'Chỉ kích hoạt được chiến dịch đang nháp' }, 409);
    if (!getZaloTemplate(b.templateId)) return c.json({ error: 'Mẫu tin không còn tồn tại' }, 400);
    if (b.accountIds.some((id) => !getZaloAccount(id))) return c.json({ error: 'Có nick Zalo không còn tồn tại' }, 400);
    const sync = syncListRecipients(b);
    if (sync.total === 0) {
      return c.json({ error: 'Không có khách nào phù hợp bộ lọc. Chỉ khách đã chat 1-1 với nick và chưa từ chối nhận tin mới được gửi.' }, 400);
    }
    setZaloListBroadcastState(b.id, 'active');
    return c.json({ broadcast: presentBroadcast(getZaloListBroadcast(b.id)!), sync });
  });

  app.post('/list-broadcasts/:id/pause', (c) => {
    const b = loadBroadcast(c);
    if (!b) return c.json(NOT_FOUND, 404);
    if (b.state !== 'active') return c.json({ error: 'Chỉ tạm dừng được chiến dịch đang chạy' }, 409);
    setZaloListBroadcastState(b.id, 'paused', 'MANUAL');
    return c.json({ broadcast: presentBroadcast(getZaloListBroadcast(b.id)!) });
  });

  app.post('/list-broadcasts/:id/resume', (c) => {
    const b = loadBroadcast(c);
    if (!b) return c.json(NOT_FOUND, 404);
    if (b.state !== 'paused') return c.json({ error: 'Chỉ tiếp tục được chiến dịch đang tạm dừng' }, 409);
    if (!getZaloTemplate(b.templateId)) return c.json({ error: 'Mẫu tin không còn tồn tại' }, 400);
    setZaloListBroadcastState(b.id, 'active');
    return c.json({ broadcast: presentBroadcast(getZaloListBroadcast(b.id)!) });
  });

  app.post('/list-broadcasts/:id/cancel', (c) => {
    const b = loadBroadcast(c);
    if (!b) return c.json(NOT_FOUND, 404);
    if (b.state === 'completed' || b.state === 'cancelled') return c.json({ error: 'Chiến dịch đã kết thúc' }, 409);
    setZaloListBroadcastState(b.id, 'cancelled');
    return c.json({ broadcast: presentBroadcast(getZaloListBroadcast(b.id)!) });
  });

  app.post('/list-broadcasts/:id/retry-failed', (c) => {
    const b = loadBroadcast(c);
    if (!b) return c.json(NOT_FOUND, 404);
    if (b.state === 'cancelled' || b.state === 'draft') return c.json({ error: 'Chiến dịch chưa chạy hoặc đã huỷ' }, 409);
    const requeued = requeueFailedZaloListRecipients(b.id, MAX_RECIPIENT_ATTEMPTS);
    // A finished campaign with new pending work runs again.
    if (requeued > 0 && b.state === 'completed') setZaloListBroadcastState(b.id, 'active');
    return c.json({ requeued });
  });

  app.post('/list-broadcasts/:id/recipients/:rid/skip', (c) => {
    const b = loadBroadcast(c);
    if (!b) return c.json(NOT_FOUND, 404);
    const rid = parseInt(c.req.param('rid') ?? '', 10);
    const r = Number.isFinite(rid) ? getZaloListRecipient(rid) : undefined;
    if (!r || r.broadcast_id !== b.id) return c.json({ error: 'Không tìm thấy người nhận' }, 404);
    if (!skipZaloListRecipient(r.id)) return c.json({ error: 'Chỉ bỏ qua được người nhận đang chờ hoặc bị lỗi' }, 409);
    return c.json({ ok: true });
  });

  app.delete('/list-broadcasts/:id', (c) => {
    const b = loadBroadcast(c);
    if (!b) return c.json(NOT_FOUND, 404);
    if (b.state === 'active' || b.state === 'paused') {
      return c.json({ error: 'Huỷ chiến dịch trước khi xoá' }, 409);
    }
    deleteZaloListBroadcast(b.id);
    return c.json({ ok: true });
  });
}
