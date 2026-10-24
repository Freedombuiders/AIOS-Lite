import { beforeEach, describe, expect, it, vi } from 'vitest';

import { claimNextZaloBroadcastRun,
  createZaloAccount,
  createZaloBroadcast,
  createZaloTemplate,
  getZaloBroadcast,
  getZaloBroadcastRun,
  insertZaloMedia,
  listZaloBroadcastRuns,
  listZaloBroadcastTargets,
  setZaloBroadcastState,
  updateZaloAccountSettings,
  upsertZaloThread,
  type ZaloBroadcastInput,
} from './store.js';
import { _initTestDatabase } from './test-db.js';
import {
  CATCH_UP_MS,
  createGroupBroadcastEngine,
  materializeBroadcastRun,
  MAX_RUNS_PER_TICK,
  type GroupBroadcastEngine,
  type GroupBroadcastWorkerOptions,
} from './group-broadcast.js';
import { classifyZaloError } from './limits.js';
import type { MarketingDeps } from './marketing-deps.js';
import { ZaloSendError } from './sender.js';

type SendInput = Parameters<MarketingDeps['sender']['sendRich']>[0];

interface Harness {
  engine: GroupBroadcastEngine;
  sent: SendInput[];
  sleeps: number[];
  notify: ReturnType<typeof vi.fn>;
  state: { online: boolean; budget: number; quiet: boolean };
  /** Decide per call: return normally to succeed, throw to fail. */
  behave: { fn: (input: SendInput, call: number) => void };
}

const MONDAY_0805_HCM = new Date('2026-08-03T01:05:00Z');

function harness(over: GroupBroadcastWorkerOptions = {}): Harness {
  const sent: SendInput[] = [];
  const sleeps: number[] = [];
  const state = { online: true, budget: 1000, quiet: false };
  const behave: Harness['behave'] = { fn: () => {} };
  let calls = 0;
  let nextMessageId = 1;
  const notify = vi.fn(async () => {});
  const deps = {
    pool: { getApi: () => (state.online ? {} : null) },
    sender: {
      sendRich: async (input: SendInput) => {
        calls++;
        behave.fn(input, calls);
        sent.push(input);
        return { messageIds: [nextMessageId++] };
      },
      bulkBudgetRemaining: () => state.budget,
    },
    notify,
  } as unknown as MarketingDeps;
  const engine = createGroupBroadcastEngine(deps, {
    now: () => MONDAY_0805_HCM,
    rng: () => 0.5,
    sleep: async (ms) => { sleeps.push(ms); },
    isQuietHours: () => state.quiet,
    ...over,
  });
  return { engine, sent, sleeps, notify, state, behave };
}

describe('group broadcast worker', () => {
  let accountId: string;
  let threads: number[];
  let templateId: number;

  function newBroadcast(over: Partial<ZaloBroadcastInput> = {}, state: 'draft' | 'active' = 'active') {
    const b = createZaloBroadcast({
      name: 'Khuyến mãi',
      accountId,
      templateId,
      targetThreadIds: threads,
      scheduleKind: 'daily',
      timesOfDay: ['08:00'],
      daysOfWeek: [],
      daysOfMonth: [],
      timezone: 'Asia/Ho_Chi_Minh',
      startDate: null,
      endDate: null,
      minDelaySec: 20,
      maxDelaySec: 40,
      ...over,
    });
    if (state === 'active') setZaloBroadcastState(b.id, 'active', { activatedAt: 1 });
    return getZaloBroadcast(b.id)!;
  }

  /** Unique scheduled_for per call so several manual runs of one campaign can coexist. */
  let seq = 0;
  function manualRun(broadcastId: number, trigger: 'manual' | 'retry' = 'manual') {
    const b = getZaloBroadcast(broadcastId)!;
    return materializeBroadcastRun(b, 1_000_000 + seq++, trigger)!;
  }

  beforeEach(() => {
    _initTestDatabase();
    seq = 0;
    accountId = createZaloAccount('Nick test').id;
    threads = ['g1', 'g2', 'g3'].map((ext, i) =>
      upsertZaloThread({ accountId, threadType: 'group', externalId: ext, name: `Nhóm ${i + 1}` }).id);
    templateId = createZaloTemplate({ name: 'Chào nhóm', text: 'Chào {group}', styles: [], attachmentIds: [] }).id;
  });

  it('sends one group at a time with a bulk broadcast send and a random gap between groups', async () => {
    const h = harness();
    const b = newBroadcast();
    const run = manualRun(b.id);
    await h.engine.drain();

    expect(h.sent).toHaveLength(3);
    expect(h.sent.every((s) => s.senderType === 'broadcast' && s.bulk === true)).toBe(true);
    // Rendered per group, so the {group} variable differs.
    expect(h.sent.map((s) => s.text)).toEqual(['Chào Nhóm 1', 'Chào Nhóm 2', 'Chào Nhóm 3']);
    // rng = 0.5 -> middle of the 20..40 s range, once between each pair of groups.
    expect(h.sleeps).toEqual([30_000, 30_000]);
    expect(latestRun(b.id)).toMatchObject({ id: run.id, state: 'completed', sent_count: 3, failed_count: 0 });
    expect(listZaloBroadcastTargets(run.id).every((t) => t.state === 'sent' && t.sent_steps.includes('text'))).toBe(true);
  });

  it('keeps picking up new runs after drains that found nothing (daemon polls every 10 s)', async () => {
    const h = harness();
    // Boot and idle polls: nothing to claim, the body never awaits.
    await h.engine.drain();
    await h.engine.drain();
    const b = newBroadcast();
    const run = manualRun(b.id);
    await h.engine.drain();
    expect(latestRun(b.id)).toMatchObject({ id: run.id, state: 'completed', sent_count: 3 });
    // And after a skip-only drain (nick offline: no await either).
    h.state.online = false;
    const skipped = manualRun(b.id);
    await h.engine.drain();
    h.state.online = true;
    const third = manualRun(b.id);
    await h.engine.drain();
    expect(latestRunById(skipped.id)?.state).toBe('skipped');
    expect(latestRunById(third.id)?.state).toBe('completed');
  });

  it('keeps the gap between groups inside the floor and cap even for a hand-edited campaign', async () => {
    const h = harness();
    const b = newBroadcast({ minDelaySec: 1, maxDelaySec: 5000 });
    manualRun(b.id);
    await h.engine.drain();
    expect(Math.min(...h.sleeps)).toBeGreaterThanOrEqual(10_000);
    expect(Math.max(...h.sleeps)).toBeLessThanOrEqual(600_000);
  });

  it('sends text, then the image album, then each file as separate steps with a pause between steps', async () => {
    const img1 = insertZaloMedia({ file_name: 'a.jpg', mime: 'image/jpeg', kind: 'image', size: 1, rel_path: 'a.jpg' });
    const img2 = insertZaloMedia({ file_name: 'b.jpg', mime: 'image/jpeg', kind: 'image', size: 1, rel_path: 'b.jpg' });
    const pdf = insertZaloMedia({ file_name: 'c.pdf', mime: 'application/pdf', kind: 'file', size: 1, rel_path: 'c.pdf' });
    const tpl = createZaloTemplate({ name: 'Đủ bộ', text: 'Xin chào', styles: [], attachmentIds: [img1.id, img2.id, pdf.id] });
    const h = harness();
    const b = newBroadcast({ templateId: tpl.id, targetThreadIds: [threads[0]] });
    const run = manualRun(b.id);
    await h.engine.drain();

    expect(h.sent.map((s) => (s.attachments ? s.attachments.map((a) => a.kind).join('+') : 'text'))).toEqual([
      'text', 'image+image', 'file',
    ]);
    expect(h.sleeps).toHaveLength(2); // pause before album and before file, none after the last
    expect(h.sleeps.every((ms) => ms >= 800 && ms <= 2500)).toBe(true);
    expect(listZaloBroadcastTargets(run.id)[0].sent_steps).toEqual(['text', 'album', `file:${pdf.id}`]);
  });

  it('never resends a delivered step: a failed second step keeps the first, and the retry sends only the rest', async () => {
    const img = insertZaloMedia({ file_name: 'a.jpg', mime: 'image/jpeg', kind: 'image', size: 1, rel_path: 'a.jpg' });
    const tpl = createZaloTemplate({ name: 'Chữ + ảnh', text: 'Xin chào', styles: [], attachmentIds: [img.id] });
    const h = harness();
    const b = newBroadcast({ templateId: tpl.id, targetThreadIds: [threads[0]] });
    const run = manualRun(b.id);
    h.behave.fn = (input) => {
      if (input.attachments) throw new ZaloSendError('Zalo từ chối ảnh [zalo:114]', 'API_ERROR');
    };
    await h.engine.drain();

    const [failed] = listZaloBroadcastTargets(run.id);
    expect(failed).toMatchObject({ state: 'failed', attempts: 1, sent_steps: ['text'] });
    expect(failed.error_code).toBe(classifyZaloError(new ZaloSendError('x [zalo:114]', 'API_ERROR')));
    expect(h.sent).toHaveLength(1); // only the text went out

    // "Gửi lại nhóm lỗi": a retry run carrying the delivered steps.
    h.behave.fn = () => {};
    const retry = materializeBroadcastRun(getZaloBroadcast(b.id)!, 2_000_000, 'retry', [{
      threadId: failed.thread_id, attempts: failed.attempts, sentSteps: failed.sent_steps, messageIds: failed.message_ids,
    }])!;
    await h.engine.drain();

    expect(h.sent).toHaveLength(2);
    expect(h.sent[1].text).toBeUndefined(); // album only, text not repeated
    expect(h.sent[1].attachments?.[0].kind).toBe('image');
    expect(listZaloBroadcastTargets(retry.id)[0]).toMatchObject({ state: 'sent', attempts: 2, sent_steps: ['text', 'album'] });
  });

  it('marks a group failed on a normal API error and carries on with the rest', async () => {
    const h = harness();
    const b = newBroadcast();
    const run = manualRun(b.id);
    h.behave.fn = (input) => {
      if (input.threadId === threads[1]) throw new ZaloSendError('Bạn không còn trong nhóm [zalo:171]', 'API_ERROR');
    };
    await h.engine.drain();

    const targets = listZaloBroadcastTargets(run.id);
    expect(targets.map((t) => t.state)).toEqual(['sent', 'failed', 'sent']);
    expect(targets[1].error_message).toContain('không còn trong nhóm');
    expect(latestRun(b.id)).toMatchObject({ state: 'partial', sent_count: 2, failed_count: 1 });
  });

  it.each(['QUIET_HOURS', 'BULK_BUDGET', 'RATE_LIMITED', 'NOT_CONNECTED', 'CHAT_DISABLED', 'LOCKED'] as const)(
    'stops the run on %s and leaves the remaining groups pending, not failed',
    async (code) => {
      const h = harness();
      const b = newBroadcast();
      const run = manualRun(b.id);
      h.behave.fn = (input) => {
        if (input.threadId === threads[1]) throw new ZaloSendError('dừng', code);
      };
      await h.engine.drain();

      expect(listZaloBroadcastTargets(run.id).map((t) => t.state)).toEqual(['sent', 'pending', 'pending']);
      const finished = latestRun(b.id);
      expect(finished.state).toBe('partial');
      expect(finished.failed_count).toBe(0);
      expect(finished.skip_reason).not.toBe('');
      // It did send something, so the failure counter is reset rather than advanced.
      expect(getZaloBroadcast(b.id)!.consecutive_failed_runs).toBe(0);
    },
  );

  it('a run stopped before sending anything is skipped and does not count as a failure', async () => {
    const h = harness();
    const b = newBroadcast();
    manualRun(b.id);
    h.behave.fn = () => { throw new ZaloSendError('quá hạn mức', 'RATE_LIMITED'); };
    await h.engine.drain();

    expect(latestRun(b.id)).toMatchObject({ state: 'skipped', skip_reason: 'RATE_LIMITED' });
    expect(getZaloBroadcast(b.id)!.consecutive_failed_runs).toBe(0);
  });

  it('auto-pauses after 3 consecutive runs that sent nothing while failing, and notifies in Vietnamese', async () => {
    const h = harness();
    const b = newBroadcast();
    h.behave.fn = () => { throw new ZaloSendError('Zalo từ chối [zalo:114]', 'API_ERROR'); };

    manualRun(b.id);
    await h.engine.drain();
    manualRun(b.id);
    await h.engine.drain();
    expect(getZaloBroadcast(b.id)).toMatchObject({ state: 'active', consecutive_failed_runs: 2 });
    expect(h.notify).not.toHaveBeenCalled();

    manualRun(b.id);
    await h.engine.drain();
    expect(getZaloBroadcast(b.id)).toMatchObject({
      state: 'paused', paused_reason: 'CONSECUTIVE_FAILURES', consecutive_failed_runs: 3, next_run_at: null,
    });
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0][0]).toContain('tự tạm dừng');
  });

  it('a successful run resets the failure counter, and skipped runs never advance it', async () => {
    const h = harness();
    const b = newBroadcast();
    h.behave.fn = () => { throw new ZaloSendError('lỗi', 'API_ERROR'); };
    manualRun(b.id);
    await h.engine.drain();
    expect(getZaloBroadcast(b.id)!.consecutive_failed_runs).toBe(1);

    h.state.online = false;
    manualRun(b.id);
    await h.engine.drain();
    expect(latestRun(b.id)).toMatchObject({ state: 'skipped', skip_reason: 'NICK_OFFLINE' });
    expect(getZaloBroadcast(b.id)!.consecutive_failed_runs).toBe(1);

    h.state.online = true;
    h.behave.fn = () => {};
    manualRun(b.id);
    await h.engine.drain();
    expect(getZaloBroadcast(b.id)!.consecutive_failed_runs).toBe(0);
  });

  describe('skip reasons', () => {
    it.each([
      ['NICK_OFFLINE', (h: Harness) => { h.state.online = false; }],
      ['QUIET_HOURS', (h: Harness) => { h.state.quiet = true; }],
      ['BULK_BUDGET', (h: Harness) => { h.state.budget = 0; }],
    ] as const)('skips the run with %s and sends nothing', async (reason, arrange) => {
      const h = harness();
      arrange(h);
      const b = newBroadcast();
      manualRun(b.id);
      await h.engine.drain();
      expect(h.sent).toHaveLength(0);
      expect(latestRun(b.id)).toMatchObject({ state: 'skipped', skip_reason: reason });
    });

    it('skips when chat is disabled on the nick', async () => {
      updateZaloAccountSettings(accountId, { chat_enabled: 0 });
      const h = harness();
      const b = newBroadcast();
      manualRun(b.id);
      await h.engine.drain();
      expect(latestRun(b.id)).toMatchObject({ state: 'skipped', skip_reason: 'NICK_CHAT_DISABLED' });
    });

    it('skips scheduled runs of a paused campaign but lets a manual run through', async () => {
      const h = harness();
      const b = newBroadcast();
      setZaloBroadcastState(b.id, 'paused', { pausedReason: 'MANUAL' });
      materializeBroadcastRun(getZaloBroadcast(b.id)!, 1_000_000, 'schedule');
      await h.engine.drain();
      expect(latestRun(b.id)).toMatchObject({ state: 'skipped', skip_reason: 'BROADCAST_INACTIVE' });

      manualRun(b.id);
      await h.engine.drain();
      expect(latestRun(b.id).state).toBe('completed');
    });

    it('skips a cancelled campaign even for a manual run', async () => {
      const h = harness();
      const b = newBroadcast();
      setZaloBroadcastState(b.id, 'cancelled');
      manualRun(b.id);
      await h.engine.drain();
      expect(latestRun(b.id)).toMatchObject({ state: 'skipped', skip_reason: 'BROADCAST_INACTIVE' });
    });

    it('skips PREVIOUS_RUN_ACTIVE while another run of the campaign is running', async () => {
      const h = harness();
      const b = newBroadcast();
      const first = manualRun(b.id);
      expect(claimNextZaloBroadcastRun()?.id).toBe(first.id); // left 'running'
      const second = manualRun(b.id);
      await h.engine.drain();
      expect(listZaloBroadcastRuns(b.id).find((r) => r.id === second.id)).toMatchObject({
        state: 'skipped', skip_reason: 'PREVIOUS_RUN_ACTIVE',
      });
    });

    it('skips a scheduled run that starts within the estimated duration of a run that just started (RECENT_RUN)', async () => {
      const h = harness();
      const b = newBroadcast();
      manualRun(b.id);
      await h.engine.drain(); // starts "now" in real time
      const nowSec = Math.floor(Date.now() / 1000);
      const scheduled = materializeBroadcastRun(getZaloBroadcast(b.id)!, nowSec, 'schedule')!;
      await h.engine.drain();
      expect(listZaloBroadcastRuns(b.id).find((r) => r.id === scheduled.id)).toMatchObject({
        state: 'skipped', skip_reason: 'RECENT_RUN',
      });
    });

    it('fails the run when the template was deleted or is empty', async () => {
      const h = harness();
      const b = newBroadcast({ templateId: 9999 });
      manualRun(b.id);
      await h.engine.drain();
      expect(latestRun(b.id)).toMatchObject({ state: 'failed', skip_reason: 'TEMPLATE_MISSING' });
    });
  });

  it('skips a group that is no longer a group of the nick instead of sending', async () => {
    const h = harness();
    const other = createZaloAccount('Nick khác').id;
    const foreign = upsertZaloThread({ accountId: other, threadType: 'group', externalId: 'gx', name: 'Nhóm lạ' }).id;
    const b = newBroadcast({ targetThreadIds: [threads[0], foreign] });
    const run = manualRun(b.id);
    await h.engine.drain();
    const targets = listZaloBroadcastTargets(run.id);
    expect(targets[1]).toMatchObject({ state: 'skipped', error_code: 'GROUP_REMOVED' });
    expect(h.sent).toHaveLength(1);
  });

  it('stops cleanly mid-run when the worker is stopped, leaving the rest pending', async () => {
    let engineRef: GroupBroadcastEngine | null = null;
    const h = harness({
      // Stopping during the first gap between groups.
      sleep: async () => { engineRef?.stop(); },
    });
    engineRef = h.engine;
    const b = newBroadcast();
    const run = manualRun(b.id);
    await h.engine.drain();

    expect(h.sent).toHaveLength(1);
    expect(listZaloBroadcastTargets(run.id).map((t) => t.state)).toEqual(['sent', 'pending', 'pending']);
    expect(latestRun(b.id)).toMatchObject({ state: 'partial', skip_reason: 'WORKER_STOPPED' });
  });

  it('stops between groups when the campaign is cancelled while the run is in flight', async () => {
    const h = harness({
      sleep: async () => { setZaloBroadcastState(b.id, 'cancelled'); },
    });
    const b = newBroadcast();
    manualRun(b.id);
    await h.engine.drain();
    expect(h.sent).toHaveLength(1);
    expect(latestRun(b.id)).toMatchObject({ state: 'partial', skip_reason: 'BROADCAST_INACTIVE' });
  });

  it("closes a one-shot ('now') campaign after its run", async () => {
    const h = harness();
    const b = newBroadcast({ scheduleKind: 'now', timesOfDay: [] });
    manualRun(b.id);
    await h.engine.drain();
    expect(getZaloBroadcast(b.id)).toMatchObject({ state: 'completed', next_run_at: null });
  });

  describe('scheduler tick', () => {
    it('creates a run for a time that fell due within the catch-up window, once', () => {
      const h = harness(); // now = 08:05 local, the 08:00 time is 5 minutes old
      const b = newBroadcast();
      expect(h.engine.scheduleTick(MONDAY_0805_HCM)).toBe(1);
      expect(h.engine.scheduleTick(MONDAY_0805_HCM)).toBe(0); // unique key makes it idempotent
      const [run] = listZaloBroadcastRuns(b.id);
      expect(run).toMatchObject({ triggered_by: 'schedule', state: 'pending', total_targets: 3 });
      expect(run.scheduled_for).toBe(Date.parse('2026-08-03T01:00:00Z') / 1000);
    });

    it('drops times older than the catch-up window instead of flooding after a restart', () => {
      const h = harness();
      const b = newBroadcast();
      const late = new Date(Date.parse('2026-08-03T01:00:00Z') + CATCH_UP_MS + 60_000);
      expect(h.engine.scheduleTick(late)).toBe(0);
      expect(listZaloBroadcastRuns(b.id)).toHaveLength(0);
    });

    it('does not catch up times from before the campaign was activated', () => {
      const h = harness();
      const b = newBroadcast();
      setZaloBroadcastState(b.id, 'active', { activatedAt: Date.parse('2026-08-03T01:03:00Z') / 1000 });
      expect(h.engine.scheduleTick(MONDAY_0805_HCM)).toBe(0);
    });

    it('ignores draft, paused and "now" campaigns', () => {
      const h = harness();
      newBroadcast({}, 'draft');
      const paused = newBroadcast();
      setZaloBroadcastState(paused.id, 'paused');
      newBroadcast({ scheduleKind: 'now', timesOfDay: [] });
      expect(h.engine.scheduleTick(MONDAY_0805_HCM)).toBe(0);
    });

    it('stores the next run time, and completes a campaign whose schedule has ended', () => {
      const h = harness();
      const open = newBroadcast();
      const ended = newBroadcast({ startDate: '2026-08-01', endDate: '2026-08-03' });
      h.engine.scheduleTick(MONDAY_0805_HCM);
      expect(getZaloBroadcast(open.id)!.next_run_at).toBe(Date.parse('2026-08-04T01:00:00Z') / 1000);
      expect(getZaloBroadcast(ended.id)).toMatchObject({ state: 'completed', next_run_at: null });
      // The final occurrence's run still exists and is still allowed to send.
      expect(listZaloBroadcastRuns(ended.id)).toHaveLength(1);
    });

    it('caps the runs created per tick', () => {
      const h = harness();
      for (let i = 0; i < MAX_RUNS_PER_TICK + 5; i++) newBroadcast();
      expect(h.engine.scheduleTick(MONDAY_0805_HCM)).toBe(MAX_RUNS_PER_TICK);
    });

    it('runs the whole path: tick, drain, next time stored', async () => {
      const h = harness();
      const b = newBroadcast();
      h.engine.scheduleTick(MONDAY_0805_HCM);
      await h.engine.drain();
      expect(h.sent).toHaveLength(3);
      expect(latestRun(b.id).state).toBe('completed');
      expect(getZaloBroadcast(b.id)!.next_run_at).toBe(Date.parse('2026-08-04T01:00:00Z') / 1000);
    });
  });

  describe('sweeper', () => {
    it('skips runs nobody picked up for 30 minutes and fails runs running for over 2 hours', () => {
      const h = harness();
      const b = newBroadcast();
      const runA = manualRun(b.id);
      const runB = manualRun(b.id);
      // Both runs get claimed, i.e. left 'running'.
      claimNextZaloBroadcastRun();
      claimNextZaloBroadcastRun();

      expect(h.engine.sweep(new Date(Date.now() + 10 * 60_000))).toEqual({ stale: 0, stuck: 0 });
      const res = h.engine.sweep(new Date(Date.now() + 3 * 3600_000));
      expect(res.stuck).toBe(2);

      const pending = manualRun(b.id);
      expect(h.engine.sweep(new Date(Date.now() + 31 * 60_000)).stale).toBe(1);
      const runs = listZaloBroadcastRuns(b.id);
      expect(runs.find((r) => r.id === runA.id)).toMatchObject({ state: 'failed', skip_reason: 'STUCK' });
      expect(runs.find((r) => r.id === runB.id)).toMatchObject({ state: 'failed', skip_reason: 'STUCK' });
      expect(runs.find((r) => r.id === pending.id)).toMatchObject({ state: 'skipped', skip_reason: 'STALE' });
    });
  });
});

/** The latest run of a campaign, which every test here has at least one of. */
function latestRun(broadcastId: number) {
  return listZaloBroadcastRuns(broadcastId, 1)[0]!;
}

function latestRunById(runId: number) {
  return getZaloBroadcastRun(runId);
}
