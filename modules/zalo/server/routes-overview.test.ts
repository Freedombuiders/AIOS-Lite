import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';

import { getDb } from './compat.js';
import { registerZaloOverviewRoute, type ZaloOverview } from './routes-overview.js';
import { _initTestDatabase } from './test-db.js';

const H = 3600_000;
const D = 24 * H;
// 2026-10-10 00:00 Vietnam time
const D10 = Date.parse('2026-10-09T17:00:00Z');
// current period 2026-10-10..10-11 (2 days), previous 2026-10-08..10-09
const Q = 'from=2026-10-10&to=2026-10-11&prevFrom=2026-10-08&prevTo=2026-10-09';

function app(): Hono {
  const a = new Hono();
  registerZaloOverviewRoute(a);
  return a;
}

let seq = 0;
function thread(type: 'user' | 'group', name: string, last: { at: number; sender: string }, optedOut = 0, account = 'a1'): number {
  const r = getDb().prepare(
    `INSERT INTO zalo_threads (account_id, thread_type, external_id, name, last_message_at, last_sender_type, opted_out, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(account, type, `e${++seq}`, name, last.at, last.sender, optedOut);
  return Number(r.lastInsertRowid);
}
function msg(threadId: number, type: string, at: number, deleted = 0) {
  getDb().prepare(
    `INSERT INTO zalo_messages (thread_id, zalo_msg_id, sender_type, body, sent_at, created_at, is_deleted) VALUES (?, ?, ?, 'x', ?, 0, ?)`,
  ).run(threadId, `m${++seq}`, type, at, deleted);
}

async function get(qs: string) {
  const res = await app().request(`/overview?${qs}`);
  return { status: res.status, body: (await res.json()) as ZaloOverview & { error?: string } };
}

describe('zalo overview route', () => {
  beforeEach(() => {
    _initTestDatabase();
    seq = 0;
    getDb().prepare(`INSERT INTO zalo_accounts (id, label, created_at, updated_at) VALUES ('a1', 'Nick 1', 0, 0)`).run();
  });

  it('is empty (nulls, not zeros) without messages', async () => {
    const { body } = await get(Q);
    expect(body.hasAccount).toBe(true);
    expect(body.current.customerMessages).toBe(0);
    expect(body.current.answeredRate).toBeNull();
    expect(body.current.medianResponseMin).toBeNull();
    expect(body.current.aiShare).toBeNull();
    expect(body.waiting.count).toBe(0);
    expect(body.series).toHaveLength(2);
  });

  it('computes reply rate, median response, new customers, AI share, series and the previous period', async () => {
    const a = thread('user', 'An', { at: D10, sender: 'self' });
    msg(a, 'customer', D10 + H);
    msg(a, 'agent', D10 + H + 10 * 60_000); // answered after 10 min by the AI
    const b = thread('user', 'Bình', { at: D10, sender: 'self' });
    msg(b, 'customer', D10 + 3 * H);
    msg(b, 'customer', D10 + 3 * H + 60_000); // same turn, no extra response sample
    msg(b, 'operator', D10 + 3 * H + 30 * 60_000);
    const c = thread('user', 'Chi', { at: D10, sender: 'self' });
    msg(c, 'customer', D10 + 6 * H); // never answered
    const d = thread('user', 'Dũng', { at: D10, sender: 'self' });
    msg(d, 'customer', D10 - D + H); // first ever message: previous period
    msg(d, 'customer', D10 + 8 * H);
    const e = thread('user', 'Em', { at: D10, sender: 'self' });
    msg(e, 'customer', D10 + 9 * H);
    msg(e, 'self', D10 + 9 * H + 30 * H); // reply after more than 24 h: not "answered"
    msg(a, 'broadcast', D10 + 10 * H); // marketing send is not a reply
    msg(c, 'customer', D10 + 11 * H, 1); // deleted: ignored
    const g = thread('group', 'Nhóm cộng đồng', { at: D10, sender: 'self' });
    msg(g, 'customer', D10 + 2 * H);

    const { body } = await get(Q);
    const cur = body.current;
    expect(cur.customers).toBe(5);
    expect(cur.customerMessages).toBe(6);
    expect(cur.newCustomers).toBe(4); // Dũng wrote first the day before
    expect(cur.replies).toBe(3);
    expect(cur.aiShare).toBeCloseTo(1 / 3);
    expect(cur.answeredRate).toBeCloseTo(0.5); // An, Bình x2 of 6
    expect(cur.medianResponseMin).toBe(20); // [10, 30]
    expect(body.series.map((s) => [s.date, s.customerMessages, s.replies, s.newCustomers])).toEqual([
      ['2026-10-10', 6, 2, 4],
      ['2026-10-11', 0, 1, 0],
    ]);
    expect(body.previous).toMatchObject({ customers: 1, customerMessages: 1, newCustomers: 1, replies: 0, aiShare: null, answeredRate: 0, medianResponseMin: null });
    expect(body.accounts[0]).toMatchObject({ accountId: 'a1', name: 'Nick 1', customers: 5, customerMessages: 6, replies: 3 });

    const withGroups = (await get(`${Q}&groups=1`)).body;
    expect(withGroups.current.customers).toBe(6);
    expect(withGroups.range.groups).toBe(true);
  });

  it('lists customers waiting for a reply, oldest first, skipping opted-out and replied threads', async () => {
    const now = Date.now();
    const old = thread('user', 'Cũ', { at: now - 90 * 60_000, sender: 'customer' });
    thread('user', 'Mới', { at: now - 10 * 60_000, sender: 'customer' });
    thread('user', 'Đã hủy', { at: now - 5 * 60_000, sender: 'customer' }, 1);
    thread('user', 'Đã trả lời', { at: now - 60 * 60_000, sender: 'self' });
    thread('user', 'Quá cũ', { at: now - 90 * D, sender: 'customer' });
    thread('group', 'Nhóm', { at: now - 120 * 60_000, sender: 'customer' });
    msg(old, 'customer', now - 90 * 60_000);

    const { body } = await get(Q);
    expect(body.waiting.count).toBe(2);
    expect(body.waiting.over30m).toBe(1);
    expect(body.waiting.top.map((w) => w.name)).toEqual(['Cũ', 'Mới']);
    expect(body.waiting.top[0]).toMatchObject({ accountName: 'Nick 1', minutes: 90 });
    expect((await get(`${Q}&groups=1`)).body.waiting.count).toBe(3);
  });

  it('rejects bad or oversized ranges', async () => {
    expect((await get('from=nope&to=2026-10-11&prevFrom=2026-10-08&prevTo=2026-10-09')).status).toBe(400);
    expect((await get('from=2026-10-11&to=2026-10-10&prevFrom=2026-10-08&prevTo=2026-10-09')).status).toBe(400);
    expect((await get('from=2025-01-01&to=2026-10-11&prevFrom=2024-01-01&prevTo=2024-12-30')).status).toBe(400);
  });
});
