/**
 * /api/m/zalo/* — endpoints for the Zalo pages (accounts, threads, anti-ban settings).
 *
 * Reads and simple writes (operator sends) go straight to SQLite; the daemon's outbox worker picks
 * queued sends up within a couple of seconds and a best-effort kick makes it immediate. Anything that
 * needs the live zca-js session is proxied to the daemon over loopback. The AI never answers from
 * here: replies to customers go through the care module.
 *
 * Mounted by the module's `routes(app, ctx)` on the sub-app served at /api/m/zalo.
 */

import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import {
  countZaloThreads,
  createZaloAccount,
  deleteZaloAccount,
  enqueueZaloOutbox,
  getZaloAccount,
  getZaloMessages,
  getZaloProtectionSettings,
  getZaloThread,
  listZaloAccounts,
  listZaloOutbox,
  listZaloThreads,
  markZaloThreadRead,
  saveZaloProtectionSettings,
  sanitizeZaloLimitOverrides,
  searchZaloMessages,
  setZaloThreadOptedOut,
  setZaloThreadPause,
  updateZaloAccountSettings,
  type ZaloMessageRow,
} from './store.js';
import { logger } from './compat.js';
import { mediaUrl, renderText } from './content.js';
import { callZaloDaemon, ZaloDaemonUnavailableError } from './control.js';
import {
  DEFAULT_LIMITS,
  effectiveLimit,
  effectiveMessageCap,
  isQuietHours,
  parseNickOverrides,
  warmupWeek,
  ZALO_OP_CATEGORIES,
  ZaloLimiter,
} from './limits.js';
import { registerZaloBirthdayRoutes } from './routes-birthday.js';
import { registerZaloGroupBroadcastRoutes } from './routes-group-broadcast.js';
import { registerZaloListBroadcastRoutes } from './routes-list-broadcast.js';
import { registerZaloOverviewRoute } from './routes-overview.js';
import { registerZaloTemplateRoutes, type TemplateRouteEnv } from './routes-templates.js';
import type { ZaloSupervisor } from './supervisor.js';

const ACCOUNT_ACTIONS = new Set(['login-qr', 'cancel-qr', 'reconnect', 'disconnect', 'sync-history', 'sync-groups']);

// Reads usage straight from SQLite, so a limiter of its own in the dashboard
// process sees exactly what the daemon's limiter has counted.
const usageLimiter = new ZaloLimiter();

function presentProtection() {
  return {
    settings: getZaloProtectionSettings(),
    defaults: DEFAULT_LIMITS,
    categories: ZALO_OP_CATEGORIES,
    quietNow: isQuietHours(),
  };
}

function intParam(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === 'number' ? n : parseInt(String(n ?? ''), 10);
  return Number.isFinite(v) ? Math.min(Math.max(Math.round(v), min), max) : fallback;
}

function daemonError(c: Context, err: unknown) {
  if (err instanceof ZaloDaemonUnavailableError) return c.json({ error: err.message }, 503);
  logger.warn({ err: String(err) }, 'zalo daemon call failed');
  return c.json({ error: String((err as Error)?.message ?? err) }, 502);
}

function presentMessage(m: ZaloMessageRow) {
  let quote: { text: string; senderName: string } | null = null;
  if (m.quote_json) {
    try {
      const q = JSON.parse(m.quote_json) as { text?: string; senderName?: string };
      quote = { text: q.text ?? '', senderName: q.senderName ?? '' };
    } catch { /* ignore */ }
  }
  return {
    id: m.id,
    senderType: m.sender_type,
    senderName: m.sender_name,
    senderUid: m.sender_uid,
    contentType: m.content_type,
    text: renderText(m.content_type, m.body),
    mediaUrl: m.content_type === 'text' ? null : mediaUrl(m.body),
    quote,
    origin: m.origin,
    isDeleted: m.is_deleted === 1,
    sentAt: m.sent_at,
  };
}

async function liveStates(): Promise<Record<string, unknown> | null> {
  try {
    const res = await callZaloDaemon<{ accounts?: Record<string, unknown> }>('GET', '/status', { timeoutMs: 3_000 });
    return res.data.accounts ?? null;
  } catch {
    return null;
  }
}

function kickOutbox(): void {
  void callZaloDaemon('POST', '/outbox/kick', { timeoutMs: 3_000 }).catch(() => {});
}

export interface ZaloRouteDeps extends TemplateRouteEnv {
  supervisor: Pick<ZaloSupervisor, 'pid' | 'restart'>;
}

export function registerZaloRoutes(app: Hono, deps: ZaloRouteDeps): void {
  // Marketing feature routes (each in its own file).
  registerZaloTemplateRoutes(app, deps);
  registerZaloGroupBroadcastRoutes(app);
  registerZaloListBroadcastRoutes(app);
  registerZaloBirthdayRoutes(app);
  registerZaloOverviewRoute(app);

  // ── Service ─────────────────────────────────────────────────────────
  app.get('/status', (c) => {
    const pid = deps.supervisor.pid();
    return c.json({ enabled: true, daemon: { running: pid !== null, pid } });
  });

  app.post('/daemon/restart', async (c) => {
    await deps.supervisor.restart();
    return c.json({ ok: true, pid: deps.supervisor.pid() });
  });

  // ── Anti-ban protection settings ────────────────────────────────────
  app.get('/settings', (c) => c.json(presentProtection()));

  app.put('/settings', async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const clock = /^([01]\d|2[0-3]):[0-5]\d$/;
    const q = body.quietHours as { start?: unknown; end?: unknown } | undefined;
    for (const v of [q?.start, q?.end]) {
      if (v !== undefined && !(typeof v === 'string' && clock.test(v))) return c.json({ error: 'Giờ không hợp lệ (định dạng HH:MM)' }, 400);
    }
    if (body.timezone !== undefined) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: String(body.timezone) });
      } catch {
        return c.json({ error: 'Múi giờ không hợp lệ' }, 400);
      }
    }
    saveZaloProtectionSettings(body);
    return c.json(presentProtection());
  });

  // ── Accounts ────────────────────────────────────────────────────────
  app.get('/accounts', async (c) => {
    const live = await liveStates();
    const now = new Date();
    const protection = getZaloProtectionSettings();
    const accounts = listZaloAccounts().map((a) => {
      const week = warmupWeek(a, now, protection.warmupSchedule);
      return {
      id: a.id,
      label: a.label,
      zaloUid: a.zalo_uid,
      displayName: a.display_name,
      avatarUrl: a.avatar_url,
      status: a.status,
      chatEnabled: a.chat_enabled === 1,
      dailyMessageCap: a.daily_message_cap,
      manualDisconnect: a.manual_disconnect === 1,
      hasSession: a.has_session === 1,
      lastError: a.last_error,
      lastConnectedAt: a.last_connected_at,
      threadCount: countZaloThreads(a.id),
      live: live?.[a.id] ?? null,
      sendLockReason: a.send_lock_reason,
      effectiveMessageCap: effectiveMessageCap(a, now, protection),
      warmup: {
        enabled: a.warmup_enabled === 1,
        startedAt: a.warmup_started_at,
        week,
        cap: week > 0 ? protection.warmupSchedule[week - 1] : null,
      },
      // Per-nick overrides as saved, plus what each category resolves to now.
      limits: parseNickOverrides(a),
      effectiveLimits: Object.fromEntries(ZALO_OP_CATEGORIES.map((cat) => {
        const l = effectiveLimit(a, cat, now, protection);
        return [cat, { daily: l.daily, burst: l.burst, windowSec: Math.round(l.windowMs / 1000) }];
      })),
      usage: usageLimiter.usage(a.id, now.getTime()),
      };
    });
    return c.json({ accounts, daemonReachable: live !== null });
  });

  app.post('/accounts', async (c) => {
    const body = await c.req.json<{ label?: string; warmup?: boolean }>().catch(() => ({} as { label?: string; warmup?: boolean }));
    const label = (body.label ?? '').trim().slice(0, 80);
    // A nick added through the dashboard is assumed new unless told otherwise.
    const account = createZaloAccount(label || `Nick ${listZaloAccounts().length + 1}`, { warmup: body.warmup !== false });
    return c.json({ account: { id: account.id, label: account.label } });
  });

  app.patch('/accounts/:id', async (c) => {
    const id = c.req.param('id');
    if (!getZaloAccount(id)) return c.json({ error: 'Không tìm thấy tài khoản' }, 404);
    type Patch = { label?: string; chatEnabled?: boolean; dailyMessageCap?: number; warmupEnabled?: boolean; limits?: Record<string, unknown> | null };
    const body = await c.req.json<Patch>().catch(() => ({} as Patch));
    const account = getZaloAccount(id)!;
    updateZaloAccountSettings(id, {
      ...(typeof body.label === 'string' ? { label: body.label.trim().slice(0, 80) } : {}),
      // Turning sending back on is how the operator clears an automatic lock.
      ...(typeof body.chatEnabled === 'boolean'
        ? { chat_enabled: body.chatEnabled ? 1 : 0, ...(body.chatEnabled ? { send_lock_reason: '' } : {}) }
        : {}),
      ...(body.dailyMessageCap !== undefined ? { daily_message_cap: clamp(body.dailyMessageCap, 1, 2000, 1000) } : {}),
      ...(typeof body.warmupEnabled === 'boolean'
        ? {
          warmup_enabled: body.warmupEnabled ? 1 : 0,
          // Enabling starts the schedule now for a nick that has already connected
          // (otherwise the first connect starts it); disabling forgets the start.
          ...(!body.warmupEnabled ? { warmup_started_at: null } : {}),
          ...(body.warmupEnabled && !account.warmup_enabled
            ? { warmup_started_at: account.zalo_uid ? Math.floor(Date.now() / 1000) : null }
            : {}),
        }
        : {}),
      ...(body.limits !== undefined
        ? { limits_json: JSON.stringify(body.limits === null ? {} : sanitizeZaloLimitOverrides(body.limits)) }
        : {}),
    });
    return c.json({ ok: true });
  });

  app.delete('/accounts/:id', async (c) => {
    const id = c.req.param('id');
    if (!getZaloAccount(id)) return c.json({ error: 'Không tìm thấy tài khoản' }, 404);
    // Close the live socket first so the daemon can't write to a deleted
    // account; if the daemon is down there is no socket to close.
    await callZaloDaemon('POST', `/accounts/${encodeURIComponent(id)}/forget`, { timeoutMs: 5_000 }).catch(() => {});
    deleteZaloAccount(id);
    return c.json({ ok: true });
  });

  app.get('/accounts/:id/state', async (c) => {
    try {
      const res = await callZaloDaemon('GET', `/accounts/${encodeURIComponent(c.req.param('id'))}/state`, { timeoutMs: 3_000 });
      return c.json(res.data as Record<string, unknown>, res.status as 200);
    } catch (err) {
      return daemonError(c, err);
    }
  });

  app.post('/accounts/:id/:action', async (c) => {
    const id = c.req.param('id');
    const action = c.req.param('action');
    if (!ACCOUNT_ACTIONS.has(action)) return c.json({ error: 'unknown action' }, 404);
    if (!getZaloAccount(id)) return c.json({ error: 'Không tìm thấy tài khoản' }, 404);
    try {
      const res = await callZaloDaemon('POST', `/accounts/${encodeURIComponent(id)}/${action}`, { body: {}, timeoutMs: 60_000 });
      return c.json(res.data as Record<string, unknown>, res.status as 200);
    } catch (err) {
      return daemonError(c, err);
    }
  });

  app.get('/messages/:id/sticker', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isSafeInteger(id) || id <= 0) return c.json({ error: 'ID tin nhắn không hợp lệ' }, 400);
    try {
      const res = await callZaloDaemon('GET', `/messages/${id}/sticker`, { timeoutMs: 30_000 });
      return c.json(res.data, res.status as ContentfulStatusCode);
    } catch (err) { return daemonError(c, err); }
  });

  // ── Threads & messages ──────────────────────────────────────────────
  app.get('/threads', (c) => {
    const type = c.req.query('type');
    const { threads, total } = listZaloThreads({
      accountId: c.req.query('accountId') || undefined,
      threadType: type === 'group' || type === 'user' ? type : undefined,
      search: c.req.query('search') || undefined,
      unreadOnly: c.req.query('unanswered') === '1',
      limit: intParam(c.req.query('limit'), 100),
      offset: intParam(c.req.query('offset'), 0),
    });
    const now = Date.now() / 1000;
    const rows = threads.map((t) => {
      return {
        id: t.id,
        accountId: t.account_id,
        accountLabel: t.account_display_name || t.account_label,
        threadType: t.thread_type,
        externalId: t.external_id,
        name: t.name,
        avatarUrl: t.avatar_url,
        membersCount: t.members_count,
        lastMessageAt: t.last_message_at,
        lastPreview: t.last_preview,
        lastSenderType: t.last_sender_type,
        unreadCount: t.unread_count,
        paused: !!t.paused_until && t.paused_until > now,
        pauseReason: t.pause_reason,
        optedOut: t.opted_out === 1,
      };
    });
    return c.json({ threads: rows, total });
  });

  app.get('/threads/:id', (c) => {
    const thread = getZaloThread(intParam(c.req.param('id'), 0));
    if (!thread) return c.json({ error: 'Không tìm thấy hội thoại' }, 404);
    const account = getZaloAccount(thread.account_id);
    const failed = listZaloOutbox({ threadId: thread.id, statuses: ['failed', 'pending', 'sending'], limit: 10 });
    return c.json({
      thread: {
        id: thread.id,
        accountId: thread.account_id,
        accountLabel: account?.display_name || account?.label || '',
        threadType: thread.thread_type,
        externalId: thread.external_id,
        name: thread.name,
        avatarUrl: thread.avatar_url,
        membersCount: thread.members_count,
        pausedUntil: thread.paused_until && thread.paused_until > Date.now() / 1000 ? thread.paused_until : null,
        pauseReason: thread.pause_reason,
        optedOut: thread.opted_out === 1,
      },
      account: account
        ? { status: account.status, chatEnabled: account.chat_enabled === 1, zaloUid: account.zalo_uid, sendLockReason: account.send_lock_reason }
        : null,
      outbox: failed.map((o) => ({ id: o.id, text: o.body, status: o.status, error: o.error, createdAt: o.created_at })),
    });
  });

  app.get('/threads/:id/profiles', async (c) => {
    const id = intParam(c.req.param('id'), 0);
    if (!getZaloThread(id)) return c.json({ error: 'Không tìm thấy hội thoại' }, 404);
    try {
      const res = await callZaloDaemon('GET', `/threads/${id}/profiles`, { timeoutMs: 30_000 });
      return c.json(res.data as Record<string, unknown>, res.status as 200);
    } catch (err) { return daemonError(c, err); }
  });

  app.get('/threads/:id/messages', (c) => {
    const threadId = intParam(c.req.param('id'), 0);
    if (!getZaloThread(threadId)) return c.json({ error: 'Không tìm thấy hội thoại' }, 404);
    const before = intParam(c.req.query('before'), 0);
    const messages = getZaloMessages(threadId, {
      beforeMs: before > 0 ? before : undefined,
      limit: intParam(c.req.query('limit'), 60),
    });
    return c.json({ messages: messages.map(presentMessage) });
  });

  app.post('/threads/:id/read', (c) => {
    markZaloThreadRead(intParam(c.req.param('id'), 0));
    return c.json({ ok: true });
  });

  app.post('/threads/:id/send', async (c) => {
    const threadId = intParam(c.req.param('id'), 0);
    const thread = getZaloThread(threadId);
    if (!thread) return c.json({ error: 'Không tìm thấy hội thoại' }, 404);
    const body = await c.req.json<{ text?: string }>().catch(() => ({} as { text?: string }));
    const text = (body.text ?? '').trim();
    if (!text) return c.json({ error: 'Tin nhắn trống' }, 400);
    if (text.length > 2000) return c.json({ error: 'Tin nhắn quá dài (tối đa 2000 ký tự)' }, 400);
    const id = enqueueZaloOutbox({ threadId, body: text, origin: 'operator' });
    kickOutbox();
    return c.json({ ok: true, outboxId: id });
  });

  app.post('/threads/:id/opt-out', async (c) => {
    const threadId = intParam(c.req.param('id'), 0);
    if (!getZaloThread(threadId)) return c.json({ error: 'Không tìm thấy hội thoại' }, 404);
    const body = await c.req.json<{ optedOut?: unknown }>().catch(() => ({} as { optedOut?: unknown }));
    if (typeof body.optedOut !== 'boolean') return c.json({ error: 'Thiếu trạng thái từ chối nhận tin' }, 400);
    setZaloThreadOptedOut(threadId, body.optedOut);
    return c.json({ ok: true });
  });

  app.post('/threads/:id/pause', async (c) => {
    const threadId = intParam(c.req.param('id'), 0);
    if (!getZaloThread(threadId)) return c.json({ error: 'Không tìm thấy hội thoại' }, 404);
    const body = await c.req.json<{ minutes?: number | null }>().catch(() => ({} as { minutes?: number | null }));
    if (body.minutes === null || body.minutes === 0) {
      setZaloThreadPause(threadId, null, '');
    } else {
      const minutes = clamp(body.minutes, 1, 60 * 24 * 365, 60);
      setZaloThreadPause(threadId, Math.floor(Date.now() / 1000) + minutes * 60, 'manual');
    }
    return c.json({ ok: true });
  });

  app.get('/search', (c) => {
    const q = (c.req.query('q') ?? '').trim();
    if (q.length < 2) return c.json({ hits: [] });
    const threadId = intParam(c.req.query('threadId'), 0);
    const hits = searchZaloMessages({
      query: q,
      accountId: c.req.query('accountId') || undefined,
      threadId: threadId > 0 ? threadId : undefined,
      limit: 100,
    });
    return c.json({
      hits: hits.map((h) => ({ ...presentMessage(h), threadId: h.thread_id, threadName: h.thread_name, threadType: h.thread_type })),
    });
  });
}
