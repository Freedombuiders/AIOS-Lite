/**
 * GET /api/m/zalo/overview — the "Bán hàng qua Zalo" section of Tổng quan.
 *
 * Counts and timings only: message bodies are never read. Timestamps in zalo_messages / zalo_threads
 * are milliseconds. Days are Vietnam calendar days (UTC+7, no DST), `from`/`to` inclusive.
 * By default only 1-1 threads ('user') count as customers; `groups=1` adds community groups.
 *
 * Metric definitions (per period; the previous period uses the same rules):
 *  - customers        distinct threads with at least one customer message in the period.
 *  - newCustomers     threads whose first-ever customer message falls in the period.
 *  - customerMessages customer messages in the period.
 *  - replies          replies (sender self | agent | operator) sent in the period. Broadcast/marketing
 *                     sends are not replies and are ignored everywhere.
 *  - answeredRate     among customer messages old enough to judge (sent at least 24 h ago): the share
 *                     followed by a reply in the same thread within 24 h. null when none is old enough.
 *  - medianResponseMin a "customer turn" is a customer message whose previous message in the thread is
 *                     not from the customer. Median minutes from the turn to the next reply, over turns
 *                     answered within 24 h. null when there is none.
 *  - aiShare          replies sent by the AI agent / all replies in the period. null with no replies.
 *  - series           per day: customerMessages, replies, newCustomers.
 *  - waiting*         right now, independent of the period: threads whose last message is from the
 *                     customer, not opted out, active within the last 30 days. Oldest wait first.
 *  - accounts         per Zalo account: customers, customerMessages, replies, waiting.
 * Unknown values are null, never 0.
 */

import type { Hono } from 'hono';

import { getDb } from './compat.js';

const VN_OFFSET_MS = 7 * 3600_000;
const DAY_MS = 86_400_000;
const ANSWER_WINDOW_MS = DAY_MS;
const WAITING_HORIZON_MS = 30 * DAY_MS;
const MAX_DAYS = 366;
const REPLY_TYPES = new Set(['self', 'agent', 'operator']);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 'YYYY-MM-DD' → ms of 00:00 Vietnam time; null when not a real date. */
function dayStartMs(d: string | undefined): number | null {
  if (!d || !DATE_RE.test(d)) return null;
  const t = Date.parse(`${d}T00:00:00Z`);
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== d) return null;
  return t - VN_OFFSET_MS;
}

function dayKey(ms: number): string {
  return new Date(ms + VN_OFFSET_MS).toISOString().slice(0, 10);
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

interface Msg { thread: number; type: string; at: number }

export interface PeriodStats {
  customers: number;
  newCustomers: number;
  customerMessages: number;
  replies: number;
  answeredRate: number | null;
  medianResponseMin: number | null;
  aiShare: number | null;
}

interface AccountStats { customerSet: Set<number>; customerMessages: number; replies: number }

function computePeriod(
  msgs: Msg[],
  startMs: number,
  endMs: number,
  firstCustomerAt: Map<number, number>,
  threadAccount: Map<number, string>,
  nowMs: number,
) {
  const customerSet = new Set<number>();
  const days = new Map<string, { customerMessages: number; replies: number; newCustomers: number }>();
  const accounts = new Map<string, AccountStats>();
  const day = (k: string) => {
    let d = days.get(k);
    if (!d) days.set(k, (d = { customerMessages: 0, replies: 0, newCustomers: 0 }));
    return d;
  };
  const acc = (thread: number) => {
    const id = threadAccount.get(thread) ?? '';
    let a = accounts.get(id);
    if (!a) accounts.set(id, (a = { customerSet: new Set(), customerMessages: 0, replies: 0 }));
    return a;
  };

  let customerMessages = 0, replies = 0, aiReplies = 0, judged = 0, answered = 0;
  const responses: number[] = [];

  // msgs is sorted by (thread, at); walk each thread, looking ahead for the next reply.
  let i = 0;
  while (i < msgs.length) {
    let j = i;
    while (j < msgs.length && msgs[j]!.thread === msgs[i]!.thread) j++;
    for (let k = i; k < j; k++) {
      const m = msgs[k]!;
      const inPeriod = m.at >= startMs && m.at < endMs;
      if (REPLY_TYPES.has(m.type)) {
        if (inPeriod) {
          replies++;
          if (m.type === 'agent') aiReplies++;
          day(dayKey(m.at)).replies++;
          acc(m.thread).replies++;
        }
        continue;
      }
      if (m.type !== 'customer' || !inPeriod) continue;
      customerMessages++;
      customerSet.add(m.thread);
      day(dayKey(m.at)).customerMessages++;
      const a = acc(m.thread);
      a.customerMessages++;
      a.customerSet.add(m.thread);

      let next: Msg | undefined;
      for (let n = k + 1; n < j; n++) if (REPLY_TYPES.has(msgs[n]!.type)) { next = msgs[n]; break; }
      const wait = next ? next.at - m.at : null;
      if (nowMs - m.at >= ANSWER_WINDOW_MS) {
        judged++;
        if (wait !== null && wait <= ANSWER_WINDOW_MS) answered++;
      }
      const prevType = k > i ? msgs[k - 1]!.type : null;
      if (prevType !== 'customer' && wait !== null && wait <= ANSWER_WINDOW_MS) responses.push(wait / 60_000);
    }
    i = j;
  }

  let newCustomers = 0;
  for (const at of firstCustomerAt.values()) {
    if (at >= startMs && at < endMs) {
      newCustomers++;
      day(dayKey(at)).newCustomers++;
    }
  }

  const stats: PeriodStats = {
    customers: customerSet.size,
    newCustomers,
    customerMessages,
    replies,
    answeredRate: judged > 0 ? answered / judged : null,
    medianResponseMin: median(responses),
    aiShare: replies > 0 ? aiReplies / replies : null,
  };
  return { stats, days, accounts };
}

export interface ZaloOverview {
  range: { from: string; to: string; prevFrom: string; prevTo: string; groups: boolean };
  hasAccount: boolean;
  current: PeriodStats;
  previous: PeriodStats;
  series: Array<{ date: string; customerMessages: number; replies: number; newCustomers: number }>;
  waiting: {
    count: number | null;
    over30m: number | null;
    top: Array<{ threadId: number; name: string; accountId: string; accountName: string; minutes: number }>;
  };
  accounts: Array<{ accountId: string; name: string; customers: number; customerMessages: number; replies: number; waiting: number }>;
}

export function buildZaloOverview(opts: { from: number; to: number; prevFrom: number; prevTo: number; groups: boolean; nowMs?: number }): ZaloOverview {
  const db = getDb();
  const nowMs = opts.nowMs ?? Date.now();
  const types = opts.groups ? ['user', 'group'] : ['user'];
  const typeSql = types.map(() => '?').join(',');

  const accountRows = db.prepare(`SELECT id, label, display_name FROM zalo_accounts`).all() as Array<{ id: string; label: string; display_name: string }>;
  const accountName = new Map(accountRows.map((a) => [a.id, a.label || a.display_name || a.id]));

  const threadRows = db.prepare(`SELECT id, account_id FROM zalo_threads WHERE thread_type IN (${typeSql})`).all(...types) as Array<{ id: number; account_id: string }>;
  const threadAccount = new Map(threadRows.map((t) => [t.id, t.account_id]));

  const lo = Math.min(opts.from, opts.prevFrom);
  const hi = Math.max(opts.to, opts.prevTo);
  // messages from the earliest period start to 24 h past the latest end (to find the next reply)
  const rows = db.prepare(
    `SELECT m.thread_id AS thread, m.sender_type AS type, m.sent_at AS at
       FROM zalo_messages m JOIN zalo_threads t ON t.id = m.thread_id
      WHERE t.thread_type IN (${typeSql}) AND m.is_deleted = 0
        AND m.sender_type IN ('customer','self','agent','operator')
        AND m.sent_at >= ? AND m.sent_at < ?
      ORDER BY m.thread_id, m.sent_at, m.id`,
  ).all(...types, lo - ANSWER_WINDOW_MS, hi + ANSWER_WINDOW_MS) as Msg[];

  const firstRows = db.prepare(
    `SELECT m.thread_id AS thread, MIN(m.sent_at) AS at
       FROM zalo_messages m JOIN zalo_threads t ON t.id = m.thread_id
      WHERE t.thread_type IN (${typeSql}) AND m.is_deleted = 0 AND m.sender_type = 'customer'
      GROUP BY m.thread_id`,
  ).all(...types) as Array<{ thread: number; at: number }>;
  const firstCustomerAt = new Map(firstRows.map((r) => [r.thread, r.at]));

  const cur = computePeriod(rows, opts.from, opts.to, firstCustomerAt, threadAccount, nowMs);
  const prev = computePeriod(rows, opts.prevFrom, opts.prevTo, firstCustomerAt, threadAccount, nowMs);

  const series: ZaloOverview['series'] = [];
  for (let t = opts.from; t < opts.to; t += DAY_MS) {
    const k = dayKey(t);
    series.push({ date: k, ...(cur.days.get(k) ?? { customerMessages: 0, replies: 0, newCustomers: 0 }) });
  }

  const waitRows = db.prepare(
    `SELECT id, account_id, name, last_message_at FROM zalo_threads
      WHERE thread_type IN (${typeSql}) AND last_sender_type = 'customer' AND opted_out = 0
        AND last_message_at > 0 AND last_message_at >= ?
      ORDER BY last_message_at ASC, id ASC`,
  ).all(...types, nowMs - WAITING_HORIZON_MS) as Array<{ id: number; account_id: string; name: string; last_message_at: number }>;
  const waitingByAccount = new Map<string, number>();
  for (const w of waitRows) waitingByAccount.set(w.account_id, (waitingByAccount.get(w.account_id) ?? 0) + 1);

  const ids = new Set<string>([...cur.accounts.keys(), ...waitingByAccount.keys()]);
  const accounts = [...ids].map((id) => ({
    accountId: id,
    name: accountName.get(id) ?? id,
    customers: cur.accounts.get(id)?.customerSet.size ?? 0,
    customerMessages: cur.accounts.get(id)?.customerMessages ?? 0,
    replies: cur.accounts.get(id)?.replies ?? 0,
    waiting: waitingByAccount.get(id) ?? 0,
  })).sort((a, b) => b.customerMessages - a.customerMessages);

  return {
    range: {
      from: dayKey(opts.from), to: dayKey(opts.to - 1), prevFrom: dayKey(opts.prevFrom), prevTo: dayKey(opts.prevTo - 1), groups: opts.groups,
    },
    hasAccount: accountRows.length > 0,
    current: cur.stats,
    previous: prev.stats,
    series,
    waiting: {
      count: waitRows.length,
      over30m: waitRows.filter((w) => nowMs - w.last_message_at > 30 * 60_000).length,
      top: waitRows.slice(0, 5).map((w) => ({
        threadId: w.id,
        name: w.name,
        accountId: w.account_id,
        accountName: accountName.get(w.account_id) ?? w.account_id,
        minutes: Math.max(0, Math.round((nowMs - w.last_message_at) / 60_000)),
      })),
    },
    accounts,
  };
}

export function registerZaloOverviewRoute(app: Hono): void {
  app.get('/overview', (c) => {
    const from = dayStartMs(c.req.query('from'));
    const toDay = dayStartMs(c.req.query('to'));
    const prevFrom = dayStartMs(c.req.query('prevFrom'));
    const prevToDay = dayStartMs(c.req.query('prevTo'));
    if (from === null || toDay === null || prevFrom === null || prevToDay === null) {
      return c.json({ error: 'from, to, prevFrom, prevTo phải là ngày YYYY-MM-DD' }, 400);
    }
    const to = toDay + DAY_MS;
    const prevTo = prevToDay + DAY_MS;
    if (to <= from || prevTo <= prevFrom) return c.json({ error: 'Khoảng ngày không hợp lệ' }, 400);
    if ((to - from) / DAY_MS > MAX_DAYS || (prevTo - prevFrom) / DAY_MS > MAX_DAYS) {
      return c.json({ error: `Tối đa ${MAX_DAYS} ngày` }, 400);
    }
    const groups = c.req.query('groups') === '1';
    return c.json(buildZaloOverview({ from, to, prevFrom, prevTo, groups }));
  });
}
