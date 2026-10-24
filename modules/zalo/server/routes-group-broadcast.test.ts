import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';

import { createZaloAccount,
  createZaloBroadcast,
  createZaloTemplate,
  finishZaloBroadcastRun,
  getZaloBroadcast,
  listZaloBroadcastRuns,
  listZaloBroadcastTargets,
  setZaloBroadcastState,
  updateZaloAccountSettings,
  updateZaloBroadcastTarget,
  upsertZaloThread,
} from './store.js';
import { _initTestDatabase } from './test-db.js';
import { materializeBroadcastRun } from './group-broadcast.js';
import { registerZaloGroupBroadcastRoutes } from './routes-group-broadcast.js';

const BASE = '/group-broadcasts';

function app(): Hono {
  const a = new Hono();
  registerZaloGroupBroadcastRoutes(a);
  return a;
}

async function json<T = Record<string, any>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function send(a: Hono, method: string, url: string, body?: unknown) {
  return a.request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('group broadcast routes', () => {
  let a: Hono;
  let accountId: string;
  let groups: number[];
  let templateId: number;

  function body(over: Record<string, unknown> = {}) {
    return {
      name: 'Khuyến mãi tháng 8',
      accountId,
      templateId,
      targetThreadIds: groups,
      scheduleKind: 'daily',
      timesOfDay: ['08:00', '20:00'],
      minDelaySec: 20,
      maxDelaySec: 45,
      ...over,
    };
  }

  async function create(over: Record<string, unknown> = {}) {
    const res = await send(a, 'POST', BASE, body(over));
    expect(res.status).toBe(201);
    return (await json(res)).broadcast as { id: number };
  }

  beforeEach(() => {
    _initTestDatabase();
    a = app();
    accountId = createZaloAccount('Nick test').id;
    groups = ['g1', 'g2', 'g3'].map((ext, i) =>
      upsertZaloThread({ accountId, threadType: 'group', externalId: ext, name: `Nhóm ${i + 1}` }).id);
    templateId = createZaloTemplate({ name: 'Mẫu', text: 'Chào {group}', styles: [], attachmentIds: [] }).id;
  });

  describe('create / validate', () => {
    it('creates a draft and returns the cost plan', async () => {
      const res = await send(a, 'POST', BASE, body());
      expect(res.status).toBe(201);
      const out = await json(res);
      expect(out.broadcast).toMatchObject({
        name: 'Khuyến mãi tháng 8', state: 'draft', accountId, templateId, timesOfDay: ['08:00', '20:00'],
        timezone: 'Asia/Ho_Chi_Minh', minDelaySec: 20, maxDelaySec: 45, templateName: 'Mẫu',
      });
      expect(out.plan.cost.opsPerDay).toBe(6); // 3 groups x 1 op x 2 times
      expect(out.plan.errors).toEqual([]);
    });

    it('normalizes times to unique ascending values', async () => {
      const b = await create({ timesOfDay: ['20:00', '08:00', '08:00'] });
      expect(getZaloBroadcast(b.id)!.times_of_day).toEqual(['08:00', '20:00']);
    });

    it.each([
      ['empty name', { name: '  ' }, 'NAME_REQUIRED'],
      ['unknown nick', { accountId: 'nope' }, 'ACCOUNT_NOT_FOUND'],
      ['unknown template', { templateId: 9999 }, 'TEMPLATE_NOT_FOUND'],
      ['no groups', { targetThreadIds: [] }, 'GROUPS_REQUIRED'],
      ['bad time', { timesOfDay: ['8am'] }, 'INVALID_SCHEDULE'],
      ['missing times', { timesOfDay: [] }, 'INVALID_SCHEDULE'],
      ['weekly without weekdays', { scheduleKind: 'weekly', daysOfWeek: [] }, 'INVALID_SCHEDULE'],
      ['bad kind', { scheduleKind: 'hourly' }, 'INVALID_SCHEDULE'],
      ['bad timezone', { timezone: 'Mars/Olympus' }, 'INVALID_SCHEDULE'],
      ['end before start', { startDate: '2026-09-10', endDate: '2026-09-01' }, 'INVALID_SCHEDULE'],
      ['delay below the floor', { minDelaySec: 5 }, 'DELAY_TOO_SHORT'],
      ['max below min', { minDelaySec: 30, maxDelaySec: 20 }, 'INVALID_DELAY_RANGE'],
      ['delay above the cap', { maxDelaySec: 601 }, 'INVALID_DELAY_RANGE'],
    ])('rejects %s with 422 and a Vietnamese message', async (_label, over, code) => {
      const res = await send(a, 'POST', BASE, body(over));
      expect(res.status).toBe(422);
      const out = await json(res);
      expect(out.code).toBe(code);
      expect(typeof out.error).toBe('string');
      expect(out.error.length).toBeGreaterThan(5);
    });

    it('rejects groups that belong to another nick or are 1-1 chats', async () => {
      const other = createZaloAccount('Nick khác').id;
      const foreign = upsertZaloThread({ accountId: other, threadType: 'group', externalId: 'gx', name: 'Lạ' }).id;
      const dm = upsertZaloThread({ accountId, threadType: 'user', externalId: 'u1', name: 'Khách' }).id;
      for (const bad of [foreign, dm, 424242]) {
        const res = await send(a, 'POST', BASE, body({ targetThreadIds: [groups[0], bad] }));
        expect(res.status).toBe(422);
        expect((await json(res)).code).toBe('GROUP_NOT_OF_ACCOUNT');
      }
    });

    it('enforces the 50-group and 12-times caps', async () => {
      const many = Array.from({ length: 51 }, (_, i) =>
        upsertZaloThread({ accountId, threadType: 'group', externalId: `m${i}`, name: `M${i}` }).id);
      expect((await json(await send(a, 'POST', BASE, body({ targetThreadIds: many })))).code).toBe('TOO_MANY_GROUPS');
      const times = Array.from({ length: 13 }, (_, i) => `${String(i).padStart(2, '0')}:00`);
      expect((await json(await send(a, 'POST', BASE, body({ timesOfDay: times })))).code).toBe('INVALID_SCHEDULE');
    });

    it('refuses a nick that only receives', async () => {
      updateZaloAccountSettings(accountId, { chat_enabled: 0 });
      const res = await send(a, 'POST', BASE, body());
      expect(res.status).toBe(409);
      expect((await json(res)).code).toBe('NICK_CHAT_DISABLED');
    });

    it('refuses an empty template', async () => {
      const empty = createZaloTemplate({ name: 'Rỗng', text: '  ', styles: [], attachmentIds: [] });
      const res = await send(a, 'POST', BASE, body({ templateId: empty.id }));
      expect(res.status).toBe(422);
      expect((await json(res)).code).toBe('TEMPLATE_EMPTY');
    });
  });

  describe('preview-cost', () => {
    it('reports ops, budget and duration', async () => {
      const res = await send(a, 'POST', `${BASE}/preview-cost`, {
        accountId, templateId, targetThreadIds: groups, scheduleKind: 'daily', timesOfDay: ['08:00'],
        minDelaySec: 20, maxDelaySec: 40,
      });
      expect(res.status).toBe(200);
      const out = await json(res);
      expect(out.cost).toMatchObject({ opsPerGroup: 1, opsPerRun: 3, opsPerDay: 3 });
      expect(out.budget).toBe(600); // 60% of the 1000 default cap
      expect(out.errors).toEqual([]);
    });

    it('returns DAILY_BUDGET_EXCEEDED as data, not as an HTTP error', async () => {
      updateZaloAccountSettings(accountId, { daily_message_cap: 10 }); // budget 6
      const res = await send(a, 'POST', `${BASE}/preview-cost`, {
        accountId, templateId, groupCount: 5, scheduleKind: 'daily', timesOfDay: ['08:00', '12:00'],
      });
      expect(res.status).toBe(200);
      const out = await json(res);
      expect(out.errors.map((e: { code: string }) => e.code)).toContain('DAILY_BUDGET_EXCEEDED');
      expect(out.errors[0].message).toContain('vượt ngưỡng');
    });

    it('warns when two times are too close for one run', async () => {
      const res = await send(a, 'POST', `${BASE}/preview-cost`, {
        accountId, templateId, groupCount: 40, scheduleKind: 'daily', timesOfDay: ['08:00', '08:10'],
        minDelaySec: 20, maxDelaySec: 40,
      });
      const out = await json(res);
      expect(out.warnings.map((w: { code: string }) => w.code)).toContain('SCHEDULE_TOO_TIGHT');
    });

    it('needs a nick', async () => {
      expect((await send(a, 'POST', `${BASE}/preview-cost`, { templateId })).status).toBe(422);
    });
  });

  describe('state machine', () => {
    it('activates a draft: active, clock restarted, next run computed', async () => {
      const b = await create();
      const res = await send(a, 'POST', `${BASE}/${b.id}/activate`);
      expect(res.status).toBe(200);
      const row = getZaloBroadcast(b.id)!;
      expect(row.state).toBe('active');
      expect(row.activated_at).toBeGreaterThan(0);
      expect(row.next_run_at).toBeGreaterThan(Math.floor(Date.now() / 1000) - 1);
      expect(listZaloBroadcastRuns(b.id)).toHaveLength(0); // scheduled kinds wait for their time
    });

    it('blocks activation with DAILY_BUDGET_EXCEEDED', async () => {
      updateZaloAccountSettings(accountId, { daily_message_cap: 10 }); // budget 6
      const b = await create({ timesOfDay: ['06:00', '09:00', '12:00', '15:00'] }); // 12 ops/day
      const res = await send(a, 'POST', `${BASE}/${b.id}/activate`);
      expect(res.status).toBe(422);
      const out = await json(res);
      expect(out.code).toBe('DAILY_BUDGET_EXCEEDED');
      expect(out.plan.budget).toBe(6);
      expect(getZaloBroadcast(b.id)!.state).toBe('draft');
    });

    it("activating a 'now' campaign inserts exactly one manual run", async () => {
      const b = await create({ scheduleKind: 'now', timesOfDay: [] });
      const res = await send(a, 'POST', `${BASE}/${b.id}/activate`);
      expect(res.status).toBe(200);
      const runs = listZaloBroadcastRuns(b.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ triggered_by: 'manual', state: 'pending', total_targets: 3 });
      // Not activatable twice.
      expect((await send(a, 'POST', `${BASE}/${b.id}/activate`)).status).toBe(409);
    });

    it('pauses, resumes and cancels', async () => {
      const b = await create();
      await send(a, 'POST', `${BASE}/${b.id}/activate`);

      expect((await send(a, 'POST', `${BASE}/${b.id}/pause`)).status).toBe(200);
      expect(getZaloBroadcast(b.id)).toMatchObject({ state: 'paused', paused_reason: 'MANUAL', next_run_at: null });
      expect((await send(a, 'POST', `${BASE}/${b.id}/pause`)).status).toBe(409);

      setZaloBroadcastState(b.id, 'paused', { pausedReason: 'CONSECUTIVE_FAILURES', consecutiveFailedRuns: 3 });
      expect((await send(a, 'POST', `${BASE}/${b.id}/resume`)).status).toBe(200);
      expect(getZaloBroadcast(b.id)).toMatchObject({ state: 'active', paused_reason: '', consecutive_failed_runs: 0 });

      expect((await send(a, 'POST', `${BASE}/${b.id}/cancel`)).status).toBe(200);
      expect(getZaloBroadcast(b.id)).toMatchObject({ state: 'cancelled', next_run_at: null });
      expect((await send(a, 'POST', `${BASE}/${b.id}/cancel`)).status).toBe(409);
      expect((await send(a, 'POST', `${BASE}/${b.id}/resume`)).status).toBe(409);
    });

    it('blocks resume when the campaign no longer fits the budget', async () => {
      const b = await create({ timesOfDay: ['06:00', '09:00', '12:00', '15:00'] });
      setZaloBroadcastState(b.id, 'paused', { pausedReason: 'MANUAL' });
      updateZaloAccountSettings(accountId, { daily_message_cap: 10 });
      const res = await send(a, 'POST', `${BASE}/${b.id}/resume`);
      expect(res.status).toBe(422);
      expect((await json(res)).code).toBe('DAILY_BUDGET_EXCEEDED');
    });

    it('returns 404 for unknown campaigns', async () => {
      for (const action of ['activate', 'pause', 'resume', 'cancel', 'run-now', 'retry-failed']) {
        expect((await send(a, 'POST', `${BASE}/999/${action}`)).status).toBe(404);
      }
      expect((await send(a, 'GET', `${BASE}/999`)).status).toBe(404);
      expect((await send(a, 'DELETE', `${BASE}/999`)).status).toBe(404);
    });
  });

  describe('run-now / retry-failed', () => {
    it('queues a manual run, and refuses a second one while it is pending', async () => {
      const b = await create();
      const res = await send(a, 'POST', `${BASE}/${b.id}/run-now`);
      expect(res.status).toBe(201);
      expect(listZaloBroadcastRuns(b.id)[0]).toMatchObject({ triggered_by: 'manual', state: 'pending' });
      const again = await send(a, 'POST', `${BASE}/${b.id}/run-now`);
      expect(again.status).toBe(409);
      expect((await json(again)).code).toBe('RUN_ACTIVE');
    });

    it('does not run a cancelled campaign', async () => {
      const b = await create();
      setZaloBroadcastState(b.id, 'cancelled');
      expect((await send(a, 'POST', `${BASE}/${b.id}/run-now`)).status).toBe(409);
    });

    it('retries failed and left-pending groups with their delivered steps, skipping groups tried 3 times', async () => {
      const b = await create();
      const row = getZaloBroadcast(b.id)!;
      const first = materializeBroadcastRun(row, 1_000_000, 'manual')!;
      const [t1, t2, t3] = listZaloBroadcastTargets(first.id);
      updateZaloBroadcastTarget(t1.id, { state: 'failed', attempts: 1, sentSteps: ['text'], messageIds: [7], errorCode: 'ZALO_114' });
      updateZaloBroadcastTarget(t2.id, { state: 'failed', attempts: 3, errorCode: 'ZALO_114' });
      // t3 stays pending, as if the run stopped on quiet hours.
      finishZaloBroadcastRun(first.id, { state: 'partial', skipReason: 'QUIET_HOURS' });

      const res = await send(a, 'POST', `${BASE}/${b.id}/retry-failed`);
      expect(res.status).toBe(201);
      expect((await json(res)).retrying).toBe(2);

      const retry = listZaloBroadcastRuns(b.id).find((r) => r.triggered_by === 'retry')!;
      expect(retry.state).toBe('pending');
      const targets = listZaloBroadcastTargets(retry.id);
      expect(targets.map((t) => t.thread_id)).toEqual([t1.thread_id, t3.thread_id]);
      expect(targets[0]).toMatchObject({ attempts: 1, sent_steps: ['text'], message_ids: [7], state: 'pending' });
    });

    it('answers 409 when there is nothing to retry or no run yet', async () => {
      const b = await create();
      expect((await json(await send(a, 'POST', `${BASE}/${b.id}/retry-failed`))).code).toBe('NO_RUN');
      const run = materializeBroadcastRun(getZaloBroadcast(b.id)!, 1_000_000, 'manual')!;
      for (const t of listZaloBroadcastTargets(run.id)) updateZaloBroadcastTarget(t.id, { state: 'sent' });
      finishZaloBroadcastRun(run.id, { state: 'completed' });
      expect((await json(await send(a, 'POST', `${BASE}/${b.id}/retry-failed`))).code).toBe('NOTHING_TO_RETRY');
    });
  });

  describe('read / update / delete', () => {
    it('lists campaigns with the last run summary', async () => {
      const b = await create();
      const run = materializeBroadcastRun(getZaloBroadcast(b.id)!, 1_000_000, 'manual')!;
      finishZaloBroadcastRun(run.id, { state: 'completed', counts: { sent: 3, failed: 0, skipped: 0, pending: 0 } });
      const out = await json(await send(a, 'GET', BASE));
      expect(out.broadcasts).toHaveLength(1);
      expect(out.broadcasts[0].lastRun).toMatchObject({ state: 'completed', sentCount: 3, failedCount: 0 });
    });

    it('returns the detail with runs and per-group results of recent runs', async () => {
      const b = await create();
      const run = materializeBroadcastRun(getZaloBroadcast(b.id)!, 1_000_000, 'manual')!;
      const [t1] = listZaloBroadcastTargets(run.id);
      updateZaloBroadcastTarget(t1.id, { state: 'failed', errorCode: 'NOT_IN_GROUP', errorMessage: 'không còn trong nhóm' });
      const out = await json(await send(a, 'GET', `${BASE}/${b.id}`));
      expect(out.groups.map((g: { name: string }) => g.name)).toEqual(['Nhóm 1', 'Nhóm 2', 'Nhóm 3']);
      expect(out.runs).toHaveLength(1);
      expect(out.runs[0].targets[0]).toMatchObject({ groupName: 'Nhóm 1', state: 'failed', errorCode: 'NOT_IN_GROUP' });
    });

    it('updates a draft with a partial body and revalidates', async () => {
      const b = await create();
      const res = await send(a, 'PATCH', `${BASE}/${b.id}`, { name: 'Đổi tên', timesOfDay: ['09:30'] });
      expect(res.status).toBe(200);
      expect(getZaloBroadcast(b.id)).toMatchObject({ name: 'Đổi tên', times_of_day: ['09:30'], target_thread_ids: groups });

      const bad = await send(a, 'PATCH', `${BASE}/${b.id}`, { minDelaySec: 3 });
      expect(bad.status).toBe(422);
      expect(getZaloBroadcast(b.id)!.min_delay_sec).toBe(20);
    });

    it('keeps an active campaign inside the budget when edited, and restarts its clock', async () => {
      updateZaloAccountSettings(accountId, { daily_message_cap: 10 }); // budget 6
      const b = await create({ timesOfDay: ['08:00'] }); // 3 ops
      await send(a, 'POST', `${BASE}/${b.id}/activate`);
      const over = await send(a, 'PATCH', `${BASE}/${b.id}`, { timesOfDay: ['08:00', '10:00', '12:00'] });
      expect(over.status).toBe(422);
      expect((await json(over)).code).toBe('DAILY_BUDGET_EXCEEDED');

      const ok = await send(a, 'PATCH', `${BASE}/${b.id}`, { timesOfDay: ['08:00', '12:00'] });
      expect(ok.status).toBe(200);
      expect(getZaloBroadcast(b.id)!.activated_at).toBeGreaterThan(0);
    });

    it('does not edit a finished campaign', async () => {
      const b = await create();
      setZaloBroadcastState(b.id, 'completed');
      expect((await send(a, 'PATCH', `${BASE}/${b.id}`, { name: 'x' })).status).toBe(409);
    });

    it('deletes only draft, cancelled or completed campaigns, with their runs', async () => {
      const b = await create();
      const run = materializeBroadcastRun(getZaloBroadcast(b.id)!, 1_000_000, 'manual')!;
      finishZaloBroadcastRun(run.id, { state: 'completed' });

      await send(a, 'POST', `${BASE}/${b.id}/activate`);
      expect((await send(a, 'DELETE', `${BASE}/${b.id}`)).status).toBe(409);
      await send(a, 'POST', `${BASE}/${b.id}/cancel`);
      expect((await send(a, 'DELETE', `${BASE}/${b.id}`)).status).toBe(200);
      expect(getZaloBroadcast(b.id)).toBeUndefined();
      expect(listZaloBroadcastRuns(b.id)).toHaveLength(0);
      expect(listZaloBroadcastTargets(run.id)).toHaveLength(0);
    });

    it('does not delete while a run is pending', async () => {
      const b = createZaloBroadcast({
        name: 'x', accountId, templateId, targetThreadIds: groups, scheduleKind: 'daily', timesOfDay: ['08:00'],
        daysOfWeek: [], daysOfMonth: [], timezone: 'Asia/Ho_Chi_Minh', startDate: null, endDate: null,
        minDelaySec: 20, maxDelaySec: 45,
      });
      materializeBroadcastRun(b, 1_000_000, 'manual');
      const res = await send(a, 'DELETE', `${BASE}/${b.id}`);
      expect(res.status).toBe(409);
      expect((await json(res)).code).toBe('RUN_ACTIVE');
    });
  });
});
