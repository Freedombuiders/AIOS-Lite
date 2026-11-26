// Daily run cap (runtime_options.max_runs_day): the money budget does nothing for a runtime that reports no cost.
import { afterEach, describe, expect, it } from 'vitest';
import { dayStartIso } from './runs.js';
import { agent, makeKit, type Kit } from './test-kit.js';

let kit: Kit | undefined;
afterEach(async () => {
  await kit?.deps.dispatcher.stop();
  kit = undefined;
});

const TZ = 'Asia/Ho_Chi_Minh';

function start(k: Kit) {
  kit = k;
  k.deps.dispatcher.start();
  return k;
}

/** n finished runs for the agent, all started at `at` */
function seedRuns(k: Kit, agentId: string, n: number, at: string) {
  const task = k.deps.tasks.create({ agentId, prompt: 'cũ' });
  const insert = k.db.prepare("INSERT INTO runs (task_id, agent_id, runtime, status, trigger, started_at) VALUES (?, ?, 'genbot', 'done', 'assigned', ?)");
  k.db.transaction(() => {
    for (let i = 0; i < n; i++) insert.run(task.id, agentId, at);
  })();
  k.db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);
}

describe('dayStartIso', () => {
  it('is local midnight of the zone, in UTC', () => {
    // 2026-11-26 01:30 in Hà Nội (UTC+7) is still 2026-11-25 18:30 UTC
    expect(dayStartIso(TZ, new Date('2026-11-25T18:30:00Z'))).toBe('2026-11-25T17:00:00.000Z');
    expect(dayStartIso(TZ, new Date('2026-11-26T16:59:59Z'))).toBe('2026-11-25T17:00:00.000Z');
    expect(dayStartIso(TZ, new Date('2026-11-26T17:00:00Z'))).toBe('2026-11-26T17:00:00.000Z');
    expect(dayStartIso('UTC', new Date('2026-11-26T10:00:00Z'))).toBe('2026-11-26T00:00:00.000Z');
    expect(dayStartIso('No/Such_Zone', new Date('2026-11-26T10:00:00Z'))).toBe('2026-11-26T00:00:00.000Z');
  });
});

describe('max_runs_day', () => {
  it('the 501st run of the day ends with budget, without calling the runtime; a new day runs again', async () => {
    const k = start(makeKit([agent('bot', { runtime: 'genbot' })], { config: { timezone: TZ }, runtimeCaps: { reportsCost: false } }));
    seedRuns(k, 'bot', 500, new Date().toISOString());
    expect(k.deps.runs.dayCount('bot', TZ)).toBe(500);
    const t = k.deps.tasks.create({ agentId: 'bot', prompt: 'lượt 501' });
    await k.settle();
    const failed = k.deps.tasks.require(t.id);
    expect(failed).toMatchObject({ status: 'failed', meta: { errorFamily: 'budget' } });
    expect(failed.error).toContain('500 lượt chạy mỗi ngày');
    expect(k.requests).toHaveLength(0);
    expect(k.deps.attention.list().some((a) => a.kind === 'budget' && a.title.includes('500 lượt'))).toBe(true);

    // the same 500 runs, but yesterday: today's count is 0 and the agent runs
    k.db.prepare('UPDATE runs SET started_at = ? WHERE agent_id = ?').run(new Date(Date.now() - 36 * 3600_000).toISOString(), 'bot');
    const next = k.deps.tasks.create({ agentId: 'bot', prompt: 'ngày mới' });
    await k.settle();
    expect(k.deps.tasks.require(next.id).status).toBe('done');
    expect(k.requests).toHaveLength(1);
  });

  it('honours an explicit max_runs_day for any runtime, and 0 turns the cap off', async () => {
    const k = start(makeKit([agent('a', { runtimeOptions: { max_runs_day: 2 } }), agent('b', { runtimeOptions: { max_runs_day: 0 } })], { config: { timezone: TZ }, runtimeCaps: { reportsCost: false } }));
    seedRuns(k, 'a', 2, new Date().toISOString());
    seedRuns(k, 'b', 600, new Date().toISOString());
    const ta = k.deps.tasks.create({ agentId: 'a', prompt: 'x' });
    const tb = k.deps.tasks.create({ agentId: 'b', prompt: 'y' });
    await k.settle();
    expect(k.deps.tasks.require(ta.id).meta.errorFamily).toBe('budget');
    expect(k.deps.tasks.require(tb.id).status).toBe('done');
  });

  it('no default cap for a runtime that reports cost (the money budget applies there)', async () => {
    const k = start(makeKit([agent('c')], { config: { timezone: TZ }, runtimeCaps: { reportsCost: true } }));
    seedRuns(k, 'c', 600, new Date().toISOString());
    const t = k.deps.tasks.create({ agentId: 'c', prompt: 'x' });
    await k.settle();
    expect(k.deps.tasks.require(t.id).status).toBe('done');
  });
});
