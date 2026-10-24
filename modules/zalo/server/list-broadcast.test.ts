import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { countZaloListRecipients,
  createZaloAccount,
  createZaloListBroadcast,
  createZaloTemplate,
  getZaloListBroadcast,
  insertZaloMedia,
  listZaloListBatches,
  listZaloListRecipients,
  recordZaloThreadActivity,
  requeueFailedZaloListRecipients,
  setZaloListBroadcastState,
  setZaloThreadOptedOut,
  setZaloThreadPause,
  updateZaloListRecipient,
  upsertZaloThread,
  type ZaloListBroadcastInput,
} from './store.js';
import { _initTestDatabase } from './test-db.js';
import {
  AUTO_PAUSE_AFTER_BATCHES,
  estimateListBroadcast,
  runListBroadcastBatch,
  selectListCandidates,
  syncListRecipients,
  tickListBroadcasts,
  type ListBatchContext,
} from './list-broadcast.js';
import type { MarketingDeps } from './marketing-deps.js';
import { ZALO_MEDIA_DIR } from './media.js';
import { zonedWallClockToUtc } from './send-window.js';

const VN = 'Asia/Ho_Chi_Minh';
/** Wednesday 2026-10-07 10:00 in Vietnam: inside the default 08:00-17:00 window. */
const NOON = zonedWallClockToUtc(2026, 10, 7, 10, 0, VN);

interface SendCall {
  threadId: number;
  text?: string;
  attachments?: unknown[];
  bulk?: boolean;
  senderType: string;
}

function makeDeps(opts: { failThreads?: Map<number, string>; offline?: Set<string>; budget?: number } = {}) {
  const calls: SendCall[] = [];
  const sender = {
    sendRich: vi.fn(async (input: SendCall) => {
      const code = opts.failThreads?.get(input.threadId);
      if (code) throw Object.assign(new Error(`boom ${code}`), { code });
      calls.push(input);
      return { messageIds: [calls.length] };
    }),
    bulkBudgetRemaining: vi.fn(() => opts.budget ?? 1000),
  };
  const pool = { getApi: vi.fn((id: string) => (opts.offline?.has(id) ? null : {})) };
  const notify = vi.fn(async (_text: string) => {});
  return { deps: { pool, sender, notify } as unknown as MarketingDeps, calls, sender, notify };
}

function makeCtx(over: Partial<ListBatchContext> = {}): ListBatchContext & { sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    sleep: async (ms) => { sleeps.push(ms); },
    rng: () => 0.5,
    now: () => NOON,
    isStopped: () => false,
    sleeps,
    ...over,
  };
}

function makeThread(accountId: string, ext: string, name: string, over: { type?: 'user' | 'group'; lastMs?: number } = {}) {
  const t = upsertZaloThread({ accountId, threadType: over.type ?? 'user', externalId: ext, name });
  if (over.lastMs !== undefined) {
    recordZaloThreadActivity(t.id, { sentAtMs: over.lastMs, preview: 'hi', senderType: 'customer', live: false });
  }
  return t;
}

function broadcastInput(over: Partial<ZaloListBroadcastInput>): ZaloListBroadcastInput {
  return {
    name: 'Test', templateId: 0, accountIds: [], filter: {}, windowStart: '08:00', windowEnd: '17:00',
    daysOfWeek: [], timezone: VN, startDate: null, endDate: null, dailyQuota: 100, perNickDailyQuota: 40,
    minDelaySec: 45, maxDelaySec: 90, ...over,
  };
}

describe('list broadcast', () => {
  let nick1: string;
  let nick2: string;
  let templateId: number;

  beforeEach(() => {
    _initTestDatabase();
    nick1 = createZaloAccount('Nick 1').id;
    nick2 = createZaloAccount('Nick 2').id;
    templateId = createZaloTemplate({ name: 'Chào', text: 'Chào {name}', styles: [], attachmentIds: [] }).id;
  });

  function newCampaign(over: Partial<ZaloListBroadcastInput> = {}, state: 'draft' | 'active' = 'active') {
    const b = createZaloListBroadcast(broadcastInput({ templateId, accountIds: [nick1], ...over }));
    if (state === 'active') setZaloListBroadcastState(b.id, 'active');
    return b;
  }

  describe('recipient selection', () => {
    it('takes only 1-1 chats of the chosen nicks and skips opted-out customers', () => {
      const a = makeThread(nick1, 'u1', 'An');
      makeThread(nick1, 'g1', 'Nhóm', { type: 'group' });
      makeThread(nick2, 'u2', 'Bình');
      const out = makeThread(nick1, 'u3', 'Cường');
      setZaloThreadOptedOut(out.id, true);

      const ids = selectListCandidates([nick1], {}).map((c) => c.threadId);
      expect(ids).toEqual([a.id]);
    });

    it('filters by recent activity, folded name and handoff pause, and honours manual lists', () => {
      const now = Date.now();
      const fresh = makeThread(nick1, 'u1', 'Nguyễn Thị Lan', { lastMs: now - 86_400_000 });
      const stale = makeThread(nick1, 'u2', 'Trần Văn Hùng', { lastMs: now - 40 * 86_400_000 });
      const paused = makeThread(nick1, 'u3', 'Lan Anh', { lastMs: now });
      setZaloThreadPause(paused.id, Math.floor(now / 1000) + 3600, 'human');

      expect(selectListCandidates([nick1], { activeWithinDays: 7 }).map((c) => c.threadId)).toEqual([fresh.id]);
      expect(selectListCandidates([nick1], { nameContains: 'lan' }).map((c) => c.threadId)).toEqual([fresh.id]);
      expect(selectListCandidates([nick1], { nameContains: 'LAN', excludePaused: false }).map((c) => c.threadId).sort())
        .toEqual([fresh.id, paused.id].sort());
      expect(selectListCandidates([nick1], { excludeThreadIds: [fresh.id] }).map((c) => c.threadId)).not.toContain(fresh.id);
      // A manual include rescues a stale chat but never an opted-out one.
      setZaloThreadOptedOut(stale.id, true);
      expect(selectListCandidates([nick1], { activeWithinDays: 7, includeThreadIds: [stale.id] }).map((c) => c.threadId)).toEqual([fresh.id]);
    });

    it('syncs without duplicating or resetting existing recipients', () => {
      const t1 = makeThread(nick1, 'u1', 'An');
      const b = newCampaign({}, 'draft');
      expect(syncListRecipients(b)).toMatchObject({ added: 1, total: 1 });
      const [r] = listZaloListRecipients(b.id).recipients;
      updateZaloListRecipient(r.id, { state: 'sent', sent_at: 1 });

      makeThread(nick1, 'u2', 'Bình');
      expect(syncListRecipients(b)).toMatchObject({ added: 1, total: 2 });
      expect(listZaloListRecipients(b.id, { state: 'sent' }).recipients.map((x) => x.thread_id)).toEqual([t1.id]);
    });
  });

  describe('worker', () => {
    it('sends a rendered message to every recipient, one batch, then completes', async () => {
      makeThread(nick1, 'u1', 'Nguyễn Lan');
      makeThread(nick2, 'u2', 'Trần Bình');
      makeThread(nick1, 'u3', 'Lê Cường');
      const b = newCampaign({ accountIds: [nick1, nick2] });
      syncListRecipients(b);
      const { deps, calls } = makeDeps();
      const ctx = makeCtx();

      const summary = await runListBroadcastBatch(deps, b.id, ctx);

      expect(summary).toMatchObject({ sent: 3, failed: 0, skipped: 0 });
      expect(calls.map((c) => c.text).sort()).toEqual(['Chào Bình', 'Chào Cường', 'Chào Lan']);
      expect(calls.every((c) => c.bulk === true && c.senderType === 'broadcast')).toBe(true);
      expect(countZaloListRecipients(b.id)).toMatchObject({ sent: 3, pending: 0 });
      expect(getZaloListBroadcast(b.id)!.state).toBe('completed');
      expect(listZaloListBatches(b.id)[0]).toMatchObject({ sent: 3, stop_reason: '' });
      // A gap between customers, none before the first: 2 gaps within [45, 90] s.
      expect(ctx.sleeps).toHaveLength(2);
      expect(ctx.sleeps.every((ms) => ms >= 45_000 && ms <= 90_000)).toBe(true);
    });

    it('interleaves nicks so neither bursts', async () => {
      for (let i = 0; i < 3; i++) makeThread(nick1, `a${i}`, `A${i}`);
      for (let i = 0; i < 3; i++) makeThread(nick2, `b${i}`, `B${i}`);
      const b = newCampaign({ accountIds: [nick1, nick2] });
      syncListRecipients(b);
      const { deps, calls } = makeDeps();
      await runListBroadcastBatch(deps, b.id, makeCtx());
      const order = calls.map((c) => c.text!.slice(-2)[0]);
      expect(order).toEqual(['A', 'B', 'A', 'B', 'A', 'B']);
    });

    it('does nothing outside the window', async () => {
      makeThread(nick1, 'u1', 'An');
      const b = newCampaign();
      syncListRecipients(b);
      const { deps, calls } = makeDeps();
      const night = zonedWallClockToUtc(2026, 10, 7, 21, 0, VN);
      expect(await runListBroadcastBatch(deps, b.id, makeCtx({ now: () => night }))).toBeNull();
      expect(calls).toHaveLength(0);
    });

    it('stops at the campaign daily quota and resumes the next day', async () => {
      for (let i = 0; i < 5; i++) makeThread(nick1, `u${i}`, `K${i}`);
      const b = newCampaign({ dailyQuota: 2 });
      syncListRecipients(b);
      const { deps, calls } = makeDeps();

      expect(await runListBroadcastBatch(deps, b.id, makeCtx())).toMatchObject({ sent: 2 });
      expect(await runListBroadcastBatch(deps, b.id, makeCtx({ now: () => new Date(NOON.getTime() + 3_600_000) }))).toBeNull();
      expect(calls).toHaveLength(2);

      const tomorrow = new Date(NOON.getTime() + 86_400_000);
      expect(await runListBroadcastBatch(deps, b.id, makeCtx({ now: () => tomorrow }))).toMatchObject({ sent: 2 });
      expect(getZaloListBroadcast(b.id)!.state).toBe('active');
    });

    it('counts the per-nick quota across ALL list campaigns', async () => {
      for (let i = 0; i < 4; i++) makeThread(nick1, `u${i}`, `K${i}`);
      const first = newCampaign({ name: 'A', perNickDailyQuota: 3 });
      const second = newCampaign({ name: 'B', perNickDailyQuota: 3 });
      syncListRecipients(first);
      const { deps, calls } = makeDeps();
      await runListBroadcastBatch(deps, first.id, makeCtx());
      expect(calls).toHaveLength(3); // nick quota 3 of 4 chats

      syncListRecipients(second);
      const summary = await runListBroadcastBatch(deps, second.id, makeCtx());
      // The nick already sent 3 today for campaign A, so campaign B gets nothing.
      expect(summary).toMatchObject({ sent: 0, stopReason: 'NICK_BLOCKED' });
      expect(calls).toHaveLength(3);
    });

    it('leaves recipients pending when a nick hits a nick-level error, and keeps using other nicks', async () => {
      const a1 = makeThread(nick1, 'a1', 'A1');
      const a2 = makeThread(nick1, 'a2', 'A2');
      makeThread(nick2, 'b1', 'B1');
      const b = newCampaign({ accountIds: [nick1, nick2] });
      syncListRecipients(b);
      // Whichever nick-1 chat goes first hits the limit; the nick is then off for the batch.
      const { deps, calls } = makeDeps({ failThreads: new Map([[a1.id, 'RATE_LIMITED'], [a2.id, 'RATE_LIMITED']]) });

      const summary = await runListBroadcastBatch(deps, b.id, makeCtx());

      expect(summary).toMatchObject({ sent: 1, failed: 0, stopReason: 'NICK_RATE_LIMITED' });
      expect(calls.map((c) => c.text)).toEqual(['Chào B1']);
      expect(countZaloListRecipients(b.id)).toMatchObject({ pending: 2, failed: 0, sent: 1 });
      expect(getZaloListBroadcast(b.id)!.state).toBe('active');
    });

    it('skips offline nicks and nicks without bulk budget without failing anyone', async () => {
      makeThread(nick1, 'a1', 'A1');
      makeThread(nick2, 'b1', 'B1');
      const b = newCampaign({ accountIds: [nick1, nick2] });
      syncListRecipients(b);
      const offline = makeDeps({ offline: new Set([nick1]) });
      expect(await runListBroadcastBatch(offline.deps, b.id, makeCtx())).toMatchObject({ sent: 1, stopReason: 'NICK_BLOCKED' });
      expect(countZaloListRecipients(b.id)).toMatchObject({ pending: 1, failed: 0 });

      const noBudget = makeDeps({ budget: 0 });
      // Past the 5 min cooldown that follows a batch which sent less than expected.
      const later = new Date(NOON.getTime() + 10 * 60_000);
      expect(await runListBroadcastBatch(noBudget.deps, b.id, makeCtx({ now: () => later }))).toMatchObject({ sent: 0 });
      expect(noBudget.calls).toHaveLength(0);
    });

    it('skips customers who opted out after the list was built', async () => {
      const t = makeThread(nick1, 'u1', 'An');
      makeThread(nick1, 'u2', 'Bình');
      const b = newCampaign();
      syncListRecipients(b);
      setZaloThreadOptedOut(t.id, true);
      const { deps, calls } = makeDeps();

      const summary = await runListBroadcastBatch(deps, b.id, makeCtx());

      expect(summary).toMatchObject({ sent: 1, skipped: 1 });
      expect(calls).toHaveLength(1);
      expect(listZaloListRecipients(b.id, { state: 'skipped' }).recipients[0]).toMatchObject({ thread_id: t.id, error_code: 'OPTED_OUT' });
    });

    it('persists sent_steps so a retry never resends the text', async () => {
      const file = path.join(os.tmpdir(), `zalo-list-test-${process.pid}.jpg`);
      fs.writeFileSync(file, 'x');
      try {
        const media = insertZaloMedia({ file_name: 'a.jpg', mime: 'image/jpeg', kind: 'image', size: 1, rel_path: path.relative(ZALO_MEDIA_DIR, file) });
        const tpl = createZaloTemplate({ name: 'Có ảnh', text: 'Chào {name}', styles: [], attachmentIds: [media.id] }).id;
        const t = makeThread(nick1, 'u1', 'An');
        const b = newCampaign({ templateId: tpl });
        syncListRecipients(b);

        // First run: text goes out, the album fails.
        const flaky = makeDeps();
        const original = flaky.sender.sendRich.getMockImplementation()!;
        flaky.sender.sendRich.mockImplementation(async (input: SendCall) => {
          if (input.attachments) throw Object.assign(new Error('api'), { code: 'API_ERROR' });
          return original(input);
        });
        expect(await runListBroadcastBatch(flaky.deps, b.id, makeCtx())).toMatchObject({ sent: 0, failed: 1 });
        const [failed] = listZaloListRecipients(b.id, { state: 'failed' }).recipients;
        expect(failed).toMatchObject({ thread_id: t.id, sent_steps: 1, attempts: 1 });
        expect(flaky.calls.map((c) => c.text)).toEqual(['Chào An']);

        // Operator retries: only the missing album step is sent.
        // The campaign finished (nothing pending); retrying reopens it, as the route does.
        expect(getZaloListBroadcast(b.id)!.state).toBe('completed');
        expect(requeueFailedZaloListRecipients(b.id, 3)).toBe(1);
        setZaloListBroadcastState(b.id, 'active');
        const healthy = makeDeps();
        const later = new Date(NOON.getTime() + 10 * 60_000);
        expect(await runListBroadcastBatch(healthy.deps, b.id, makeCtx({ now: () => later }))).toMatchObject({ sent: 1 });
        expect(healthy.calls).toHaveLength(1);
        expect(healthy.calls[0].text).toBeUndefined();
        expect(healthy.calls[0].attachments).toHaveLength(1);
        expect(listZaloListRecipients(b.id, { state: 'sent' }).recipients[0]).toMatchObject({ sent_steps: 2, attempts: 2 });
      } finally {
        fs.rmSync(file, { force: true });
      }
    });

    it('does not retry recipients past the attempt limit', () => {
      makeThread(nick1, 'u1', 'An');
      const b = newCampaign({}, 'draft');
      syncListRecipients(b);
      const [r] = listZaloListRecipients(b.id).recipients;
      updateZaloListRecipient(r.id, { state: 'failed', attempts: 3 });
      expect(requeueFailedZaloListRecipients(b.id, 3)).toBe(0);
    });

    it('auto-pauses after 3 consecutive batches that sent nothing, and notifies', async () => {
      for (let i = 0; i < 80; i++) makeThread(nick1, `u${i}`, `K${i}`);
      const b = newCampaign();
      syncListRecipients(b);
      const fail = new Map<number, string>();
      for (const r of listZaloListRecipients(b.id, { limit: 500 }).recipients) fail.set(r.thread_id, 'API_ERROR');
      const { deps, notify } = makeDeps({ failThreads: fail });

      for (let i = 0; i < AUTO_PAUSE_AFTER_BATCHES; i++) {
        const t = new Date(NOON.getTime() + i * 10 * 60_000);
        const summary = await runListBroadcastBatch(deps, b.id, makeCtx({ now: () => t }));
        expect(summary).toMatchObject({ sent: 0, failed: 25 });
      }

      const after = getZaloListBroadcast(b.id)!;
      expect(after).toMatchObject({ state: 'paused', pausedReason: 'CONSECUTIVE_FAILURES' });
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0][0]).toMatch(/tạm dừng/);
    });

    it('a batch with at least one send resets the failure streak', async () => {
      for (let i = 0; i < 60; i++) makeThread(nick1, `u${i}`, `K${i}`);
      const b = newCampaign();
      syncListRecipients(b);
      const all = listZaloListRecipients(b.id, { limit: 500 }).recipients;
      // Recipients are processed in id order: batches 1 and 2 (50 chats) fail, batch 3 (10) succeeds.
      const { deps } = makeDeps({ failThreads: new Map(all.slice(0, 50).map((r) => [r.thread_id, 'API_ERROR'])) });
      const t = (i: number) => new Date(NOON.getTime() + i * 10 * 60_000);
      await runListBroadcastBatch(deps, b.id, makeCtx({ now: () => t(0) }));
      expect(getZaloListBroadcast(b.id)!.consecutiveFailedBatches).toBe(1);
      await runListBroadcastBatch(deps, b.id, makeCtx({ now: () => t(1) }));
      expect(getZaloListBroadcast(b.id)!.consecutiveFailedBatches).toBe(2);
      await runListBroadcastBatch(deps, b.id, makeCtx({ now: () => t(2) })); // the remaining 10 succeed
      expect(getZaloListBroadcast(b.id)!.consecutiveFailedBatches).toBe(0);
    });

    it('waits 5 minutes after a batch that sent nothing', async () => {
      makeThread(nick1, 'u1', 'An');
      const b = newCampaign();
      syncListRecipients(b);
      const down = makeDeps({ offline: new Set([nick1]) });
      expect(await runListBroadcastBatch(down.deps, b.id, makeCtx())).toMatchObject({ sent: 0 });
      const soon = new Date(NOON.getTime() + 2 * 60_000);
      expect(await runListBroadcastBatch(down.deps, b.id, makeCtx({ now: () => soon }))).toBeNull();
      const up = makeDeps();
      const later = new Date(NOON.getTime() + 6 * 60_000);
      expect(await runListBroadcastBatch(up.deps, b.id, makeCtx({ now: () => later }))).toMatchObject({ sent: 1 });
    });

    it('stops between recipients when asked, and when the operator pauses mid-batch', async () => {
      for (let i = 0; i < 4; i++) makeThread(nick1, `u${i}`, `K${i}`);
      const b = newCampaign();
      syncListRecipients(b);
      const { deps, calls } = makeDeps();
      let stopped = false;
      const ctx = makeCtx({
        isStopped: () => stopped,
        sleep: async () => { stopped = true; },
      });
      const summary = await runListBroadcastBatch(deps, b.id, ctx);
      expect(summary).toMatchObject({ sent: 1, stopReason: 'STOPPED' });
      expect(calls).toHaveLength(1);

      const b2 = newCampaign({ name: 'B2', accountIds: [nick2] });
      makeThread(nick2, 'p1', 'P1');
      makeThread(nick2, 'p2', 'P2');
      syncListRecipients(b2);
      const pauser = makeDeps();
      const summary2 = await runListBroadcastBatch(pauser.deps, b2.id, makeCtx({
        sleep: async () => { setZaloListBroadcastState(b2.id, 'paused', 'MANUAL'); },
      }));
      expect(summary2).toMatchObject({ sent: 1, stopReason: 'NOT_ACTIVE' });
      expect(countZaloListRecipients(b2.id).pending).toBe(1);
    });

    it('pauses the campaign when its template is gone', async () => {
      makeThread(nick1, 'u1', 'An');
      const b = newCampaign({ templateId: 9999 });
      syncListRecipients(b);
      const { deps, notify } = makeDeps();
      expect(await runListBroadcastBatch(deps, b.id, makeCtx())).toBeNull();
      expect(getZaloListBroadcast(b.id)).toMatchObject({ state: 'paused', pausedReason: 'TEMPLATE_MISSING' });
      expect(notify).toHaveBeenCalled();
    });

    it('does not start a second batch for a campaign that is still running one', async () => {
      makeThread(nick1, 'u1', 'An');
      const b = newCampaign();
      syncListRecipients(b);
      const { deps } = makeDeps();
      const running = new Set<number>([b.id]);
      expect(await tickListBroadcasts(deps, makeCtx(), running)).toHaveLength(0);
      running.clear();
      const started = await tickListBroadcasts(deps, makeCtx(), running);
      expect(started).toHaveLength(1);
      await Promise.all(started);
      expect(countZaloListRecipients(b.id).sent).toBe(1);
    });
  });

  describe('estimate', () => {
    const base = {
      pending: 1000, nickCount: 2, dailyQuota: 100, perNickDailyQuota: 40, minDelaySec: 45, maxDelaySec: 90,
      hasText: true, attachmentCount: 1, window: { windowStart: '08:00', windowEnd: '17:00', daysOfWeek: [1, 2, 3, 4, 5] },
    };

    it('limits the daily rate by the per-nick quotas and counts closed weekdays', () => {
      const e = estimateListBroadcast(base);
      expect(e.opsPerRecipient).toBe(2);
      expect(e.effectiveDailyQuota).toBe(80);
      expect(e.sendingDays).toBe(13);
      expect(e.calendarDays).toBe(Math.ceil((13 * 7) / 5));
      expect(e.warnings.some((w) => /Hạn mức mỗi nick/.test(w))).toBe(true);
    });

    it('warns when the window is too short for the daily quota', () => {
      const e = estimateListBroadcast({ ...base, nickCount: 5, window: { windowStart: '09:00', windowEnd: '10:00', daysOfWeek: [] } });
      expect(e.fitsPerDay).toBeLessThan(e.effectiveDailyQuota);
      expect(e.warnings.some((w) => /Khung giờ/.test(w))).toBe(true);
    });

    it('warns when the per-nick quota exceeds the nick marketing budget', () => {
      const over = estimateListBroadcast({ ...base, perNickDailyQuota: 40, minNickBulkBudget: 18 });
      expect(over.warnings.some((w) => w.includes('18 tin/ngày'))).toBe(true);
      const fine = estimateListBroadcast({ ...base, perNickDailyQuota: 10, minNickBulkBudget: 120 });
      expect(fine.warnings.some((w) => w.includes('marketing'))).toBe(false);
    });
  });
});
