import { describe, expect, it } from 'vitest';
import { agent, makeKit } from './test-kit.js';

const kit = () => makeKit([agent('main'), agent('dev', { budgetUsdMonth: 1 })]);

describe('tasks', () => {
  it('create applies defaults and validates the agent', () => {
    const { deps } = kit();
    const t = deps.tasks.create({ prompt: 'dòng đầu\ndòng hai' });
    expect(t).toMatchObject({ title: 'dòng đầu', agentId: 'main', status: 'queued', source: 'user', trigger: 'assigned', contextProfile: 'standard', depth: 0, meta: {} });
    expect(() => deps.tasks.create({ prompt: 'x', agentId: 'ghost' })).toThrow(/Không tìm thấy agent/);
    expect(deps.tasks.create({ prompt: 'x'.repeat(200) }).title.length).toBeLessThanOrEqual(80);
  });
  it('emits task events, round-trips JSON meta, computes depth', () => {
    const { deps } = kit();
    const seen: number[] = [];
    deps.bus.on('task', (e) => seen.push(e.task.id));
    const p = deps.tasks.create({ prompt: 'p', meta: { a: { b: 1 } } });
    const c = deps.tasks.create({ prompt: 'c', parentId: p.id });
    expect(deps.tasks.get(p.id)!.meta).toEqual({ a: { b: 1 } });
    expect(c.depth).toBe(1);
    expect(seen).toEqual([p.id, c.id]);
    deps.tasks.update(p.id, { meta: { z: 1 } });
    expect(seen.length).toBe(3);
    expect(deps.tasks.children(p.id).map((x) => x.id)).toEqual([c.id]);
  });
  it('list filters', () => {
    const { deps } = kit();
    deps.tasks.create({ prompt: 'a', source: 'module:care' });
    deps.tasks.create({ prompt: 'b', source: 'user', agentId: 'dev' });
    expect(deps.tasks.list({ source: 'module:*' })).toHaveLength(1);
    expect(deps.tasks.list({ agentId: 'dev' })).toHaveLength(1);
    expect(deps.tasks.list({ q: 'a' })).toHaveLength(1);
    expect(deps.tasks.list({ parentId: null })).toHaveLength(2);
    expect(deps.tasks.list({ status: ['queued', 'done'] })).toHaveLength(2);
  });
  it('cancel cascades, retry and approve', () => {
    const { deps } = kit();
    const p = deps.tasks.create({ prompt: 'p' });
    const c = deps.tasks.create({ prompt: 'c', parentId: p.id });
    deps.tasks.cancel(p.id);
    expect(deps.tasks.get(c.id)!.status).toBe('cancelled');
    expect(deps.tasks.retry(p.id)).toMatchObject({ status: 'queued', trigger: 'retry' });
    expect(() => deps.tasks.retry(p.id)).toThrow();
    deps.tasks.update(p.id, { status: 'review' });
    expect(deps.tasks.approve(p.id).status).toBe('done');
    expect(() => deps.tasks.approve(p.id)).toThrow();
  });
  it('waitFor resolves on terminal, rejects on timeout and abort', async () => {
    const { deps } = kit();
    const t = deps.tasks.create({ prompt: 'p' });
    const w = deps.tasks.waitFor(t.id, { timeoutMs: 2000 });
    deps.tasks.update(t.id, { status: 'done' });
    expect((await w).status).toBe('done');
    const t2 = deps.tasks.create({ prompt: 'q' });
    await expect(deps.tasks.waitFor(t2.id, { timeoutMs: 30 })).rejects.toThrow(/Hết thời gian/);
    const ac = new AbortController();
    const w3 = deps.tasks.waitFor(t2.id, { signal: ac.signal });
    ac.abort();
    await expect(w3).rejects.toThrow();
    expect((await deps.tasks.waitFor(t2.id, { until: ['queued'] })).id).toBe(t2.id);
  });
  it('counts', () => {
    const { deps } = kit();
    deps.tasks.create({ prompt: 'a' });
    expect(deps.tasks.counts()).toMatchObject({ queued: 1, done: 0 });
  });
});

describe('runs', () => {
  it('start / events / finish / cost', () => {
    const { deps } = kit();
    const t = deps.tasks.create({ prompt: 'a', agentId: 'dev' });
    const r = deps.runs.start({ taskId: t.id, agentId: 'dev', runtime: 'mock', trigger: 'assigned' });
    const ev: unknown[] = [];
    deps.bus.on('run-event', (e) => ev.push(e.event));
    deps.runs.addEvent(r.id, t.id, { type: 'text', text: 'hi' });
    expect(ev).toHaveLength(1);
    expect(deps.runs.events(r.id)[0]!.event).toEqual({ type: 'text', text: 'hi' });
    const f = deps.runs.finish(r.id, { status: 'done', output: 'ok', usage: { inputTokens: 5, costUsd: 0.25 } });
    expect(f).toMatchObject({ status: 'done', inputTokens: 5, outputTokens: null, costUsd: 0.25 });
    expect(f.durationMs).not.toBeNull();
    const r2 = deps.runs.start({ taskId: t.id, agentId: 'dev', runtime: 'mock', trigger: 'assigned' });
    expect(deps.runs.finish(r2.id, { status: 'done' }).costUsd).toBeNull();
    expect(deps.runs.monthCost('dev')).toBeCloseTo(0.25);
    expect(deps.runs.list({ taskId: t.id })).toHaveLength(2);
  });
  it('monthCost ignores previous months; failOrphans', () => {
    const { deps, db } = kit();
    const t = deps.tasks.create({ prompt: 'a', agentId: 'dev' });
    db.prepare("INSERT INTO runs (task_id, agent_id, runtime, status, cost_usd, started_at) VALUES (?, 'dev', 'mock', 'done', 9, '2020-01-01T00:00:00.000Z')").run(t.id);
    expect(deps.runs.monthCost('dev')).toBe(0);
    const r = deps.runs.start({ taskId: t.id, agentId: 'dev', runtime: 'mock', trigger: 'assigned' });
    expect(deps.runs.failOrphans('x')).toBe(1);
    expect(deps.runs.get(r.id)).toMatchObject({ status: 'failed', error: 'x' });
  });
});

describe('comments', () => {
  it('user comment re-queues finished tasks, only stores on running', () => {
    const { deps } = kit();
    const t = deps.tasks.create({ prompt: 'a' });
    deps.tasks.update(t.id, { status: 'running' });
    deps.comments.add(t.id, 'user', 'một');
    expect(deps.tasks.get(t.id)!.status).toBe('running');
    deps.tasks.update(t.id, { status: 'review' });
    deps.comments.add(t.id, 'user', 'hai');
    expect(deps.tasks.get(t.id)).toMatchObject({ status: 'queued', trigger: 'commented' });
    deps.tasks.update(t.id, { status: 'done' });
    deps.comments.add(t.id, 'user', 'ba', { requeue: false });
    expect(deps.tasks.get(t.id)!.status).toBe('done');
    deps.comments.add(t.id, 'agent:main', 'ghi chú');
    expect(deps.tasks.get(t.id)!.status).toBe('done');
    expect(deps.comments.list(t.id)).toHaveLength(4);
  });
  it('since', () => {
    const { deps, db } = kit();
    const t = deps.tasks.create({ prompt: 'a' });
    deps.comments.add(t.id, 'user', 'x');
    db.prepare("UPDATE task_comments SET created_at = '2020-01-01T00:00:00.000Z'").run();
    deps.comments.add(t.id, 'user', 'y');
    expect(deps.comments.since(t.id, '2021-01-01T00:00:00.000Z').map((c) => c.body)).toEqual(['y']);
    expect(deps.comments.since(t.id, null)).toHaveLength(2);
  });
});

describe('attention', () => {
  it('derives review / failed / budget items and acknowledges them', () => {
    const { deps } = kit();
    const a = deps.tasks.create({ prompt: 'r' });
    deps.tasks.update(a.id, { status: 'review' });
    const b = deps.tasks.create({ prompt: 'f' });
    deps.tasks.update(b.id, { status: 'failed', error: 'lỗi' });
    const t = deps.tasks.create({ prompt: 'x', agentId: 'dev' });
    const r = deps.runs.start({ taskId: t.id, agentId: 'dev', runtime: 'mock', trigger: 'assigned' });
    deps.runs.finish(r.id, { status: 'done', usage: { costUsd: 2 } });
    const kinds = () => deps.attention.list().map((i) => `${i.kind}:${i.key}`).sort();
    expect(kinds()).toEqual([`budget:budget:dev:${new Date().toISOString().slice(0, 7)}`, `failed:task:${b.id}`, `review:task:${a.id}`].sort());
    deps.attention.resolve(`task:${b.id}`);
    expect(deps.attention.list().find((i) => i.key === `task:${b.id}`)).toBeUndefined();
    // a new review cycle on the same task shows up again
    deps.tasks.update(a.id, { status: 'queued' });
    deps.attention.resolve(`task:${a.id}`);
    const spin = Date.now() + 3;
    while (Date.now() < spin);
    deps.tasks.update(a.id, { status: 'review' });
    expect(deps.attention.list().find((i) => i.key === `task:${a.id}`)).toBeDefined();
  });
  it('raise / resolve raised items', () => {
    const { deps } = kit();
    const events: boolean[] = [];
    deps.bus.on('attention', (e) => events.push(!!e.resolved));
    deps.attention.raise({ key: 'module:care:draft:1', kind: 'module', title: 'Nháp', moduleId: 'care', severity: 'info' });
    expect(deps.attention.list()).toHaveLength(1);
    deps.attention.resolve('module:care:draft:1');
    expect(deps.attention.list()).toHaveLength(0);
    expect(events).toEqual([false, true]);
  });
});

describe('scheduler', () => {
  it('validates cron, computes next, fires with injected now, skip_if_active, skip_missed', () => {
    const { deps, db } = kit();
    expect(() => deps.scheduler.create({ name: 'x', agentId: 'main', cron: 'nope', prompt: 'p' })).toThrow(/không hợp lệ/);
    expect(() => deps.scheduler.create({ name: 'x', agentId: 'main', cron: '* * * * *', timezone: 'Mars/Base', prompt: 'p' })).toThrow(/không hợp lệ/);
    expect(() => deps.scheduler.create({ name: 'x', agentId: 'ghost', cron: '* * * * *', prompt: 'p' })).toThrow(/Không tìm thấy agent/);
    const s = deps.scheduler.create({ name: 'Báo cáo', agentId: 'main', cron: '0 9 * * *', timezone: 'Asia/Ho_Chi_Minh', prompt: 'báo cáo' });
    expect(s.nextRunAt).toBeTruthy();
    // 09:00 ICT = 02:00Z
    expect(new Date(s.nextRunAt!).getUTCMinutes()).toBe(0);
    expect(new Date(s.nextRunAt!).getUTCHours()).toBe(2);
    const due = new Date(Date.parse(s.nextRunAt!) + 1000);
    expect(deps.scheduler.tick(new Date(Date.parse(s.nextRunAt!) - 1000))).toHaveLength(0);
    const fired = deps.scheduler.tick(due);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ source: `schedule:${s.id}`, trigger: 'schedule', agentId: 'main' });
    const next = deps.scheduler.get(s.id)!;
    expect(Date.parse(next.nextRunAt!)).toBeGreaterThan(due.getTime());
    // previous task still queued → skipped but advanced
    const due2 = new Date(Date.parse(next.nextRunAt!) + 1000);
    expect(deps.scheduler.tick(due2)).toHaveLength(0);
    expect(Date.parse(deps.scheduler.get(s.id)!.nextRunAt!)).toBeGreaterThan(due2.getTime());
    // finish it → fires again
    deps.tasks.update(fired[0]!.id, { status: 'done' });
    const due3 = new Date(Date.parse(deps.scheduler.get(s.id)!.nextRunAt!) + 1000);
    expect(deps.scheduler.tick(due3)).toHaveLength(1);
    // skip_missed on start: overdue schedule moves to the future without running
    db.prepare("UPDATE schedules SET next_run_at = '2020-01-01T00:00:00.000Z'").run();
    const before = deps.tasks.list().length;
    deps.scheduler.start();
    deps.scheduler.stop();
    expect(deps.tasks.list().length).toBe(before);
    expect(Date.parse(deps.scheduler.get(s.id)!.nextRunAt!)).toBeGreaterThan(Date.now());
    expect(deps.scheduler.runNow(s.id).trigger).toBe('schedule');
    deps.scheduler.update(s.id, { enabled: false });
    expect(deps.scheduler.tick(new Date(Date.now() + 10 * 86400000))).toHaveLength(0);
    deps.scheduler.remove(s.id);
    expect(deps.scheduler.list()).toHaveLength(0);
  });
});

describe('stats', () => {
  it('overview', () => {
    const { deps } = kit();
    const t = deps.tasks.create({ prompt: 'a', agentId: 'dev' });
    const r = deps.runs.start({ taskId: t.id, agentId: 'dev', runtime: 'mock', trigger: 'assigned' });
    deps.runs.finish(r.id, { status: 'done', usage: { costUsd: 0.5 } });
    const o = deps.stats.overview();
    expect(o.agents).toMatchObject({ total: 2, enabled: 2 });
    expect(o.runsToday).toBe(1);
    expect(o.costMonthUsd).toBeCloseTo(0.5);
    expect(o.costByAgent[0]).toMatchObject({ agentId: 'dev', runs: 1 });
    expect(o.tasks.queued).toBe(1);
  });
});
