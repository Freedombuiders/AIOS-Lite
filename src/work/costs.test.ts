import { describe, expect, it } from 'vitest';
import { checkBudgetWarnings, createCostService, startCostWatcher } from './costs.js';
import { agent, makeKit } from './test-kit.js';

const NOW = new Date('2026-10-15T12:00:00.000Z');

function seed(kit: ReturnType<typeof makeKit>) {
  const { db } = kit;
  const task = (id: number, source: string, agentId: string) =>
    db.prepare("INSERT INTO tasks (id, title, prompt, agent_id, source) VALUES (?, ?, 'p', ?, ?)").run(id, `Việc ${id}`, agentId, source);
  task(1, 'chat', 'main');
  task(2, 'schedule:3', 'main');
  task(3, 'module:care', 'writer');
  task(4, 'user', 'writer');
  const run = (taskId: number, agentId: string, runtime: string, model: string | null, at: string, cost: number | null, i: number, o: number) =>
    db.prepare('INSERT INTO runs (task_id, agent_id, runtime, model, status, started_at, cost_usd, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(taskId, agentId, runtime, model, 'done', at, cost, i, o);
  run(1, 'main', 'claude', 'opus', '2026-10-15T08:00:00.000Z', 2, 100, 50);
  run(2, 'main', 'claude', 'opus', '2026-10-14T08:00:00.000Z', 1, 10, 5);
  run(3, 'writer', 'codex', 'gpt', '2026-10-14T09:00:00.000Z', null, 300, 100);
  run(4, 'writer', 'claude', 'sonnet', '2026-10-01T09:00:00.000Z', 0.5, 20, 10);
  run(4, 'writer', 'claude', 'sonnet', '2026-08-01T09:00:00.000Z', 99, 1, 1); // outside every window
}

describe('cost summary', () => {
  it('sums known costs and counts unknown separately', () => {
    const kit = makeKit([agent('main'), agent('writer')]);
    seed(kit);
    const s = createCostService({ db: kit.db, agents: kit.deps.agents }).summary(30, NOW);
    expect(s.totals.costUsd).toBeCloseTo(3.5);
    expect(s.totals.runs).toBe(4);
    expect(s.totals.unpricedRuns).toBe(1);
    expect(s.totals.inputTokens).toBe(430);
    expect(s.byDay).toHaveLength(30);
    expect(s.byDay.find((d) => d.day === '2026-10-14')).toMatchObject({ costUsd: 1, unpricedRuns: 1, runs: 2, byRuntime: { claude: 1 } });
    expect(s.byAgent.find((a) => a.agentId === 'writer')).toMatchObject({ costUsd: 0.5, unpricedRuns: 1 });
    expect(s.bySource.map((x) => x.source).sort()).toEqual(['chat', 'module:care', 'schedule', 'user']);
    expect(s.byModel.find((m) => m.runtime === 'codex')?.costUsd).toBe(0);
    expect(s.topTasks.map((t) => t.taskId)).toEqual([1, 2, 4]);
  });

  it('respects the period', () => {
    const kit = makeKit([agent('main'), agent('writer')]);
    seed(kit);
    const s = createCostService({ db: kit.db, agents: kit.deps.agents }).summary(7, NOW);
    expect(s.totals.runs).toBe(3);
  });
});

describe('budgets and warnings', () => {
  it('computes percent and forecast', () => {
    const kit = makeKit([agent('main', { budgetUsdMonth: 10 }), agent('writer')]);
    seed(kit);
    const svc = createCostService({ db: kit.db, agents: kit.deps.agents });
    svc.setGlobal({ usdMonth: 4, warnPercent: 50 });
    const b = svc.budgets(NOW);
    expect(b.agents.find((a) => a.agentId === 'main')).toMatchObject({ spentUsd: 3, percent: 30, budgetUsdMonth: 10 });
    expect(b.agents.find((a) => a.agentId === 'writer')?.percent).toBeNull();
    expect(b.global.spentUsd).toBeCloseTo(3.5);
    expect(b.global.percent).toBeCloseTo(87.5);
    expect(b.global.forecastUsd).toBeGreaterThan(3.5);
    expect(b.hardStopSuggestion).toBeNull();
  });

  it('warns once per month per scope', () => {
    const kit = makeKit([agent('main', { budgetUsdMonth: 3.5 }), agent('writer')]);
    seed(kit);
    const d = { db: kit.db, agents: kit.deps.agents, attention: kit.deps.attention };
    createCostService(d).setGlobal({ usdMonth: 4, warnPercent: 80 });
    expect(checkBudgetWarnings(d, NOW).sort()).toEqual(['budget:warn:global:2026-10', 'budget:warn:main:2026-10']);
    expect(checkBudgetWarnings(d, NOW)).toEqual([]);
    // a later month raises again
    expect(checkBudgetWarnings(d, new Date('2026-11-02T00:00:00Z'))).toEqual([]); // no spend yet in November
    const items = kit.deps.attention.list().filter((i) => i.kind === 'budget');
    expect(items.every((i) => i.severity === 'warn')).toBe(true);
  });

  it('watcher reacts to finished runs only', () => {
    const kit = makeKit([agent('main', { budgetUsdMonth: 0.000001 })]);
    const month = new Date().toISOString().slice(0, 7);
    kit.db.prepare("INSERT INTO tasks (id, title, prompt, agent_id) VALUES (1, 't', 'p', 'main')").run();
    kit.db.prepare('INSERT INTO runs (task_id, agent_id, runtime, status, cost_usd) VALUES (1, ?, ?, ?, 1)').run('main', 'claude', 'done');
    const stop = startCostWatcher({ db: kit.db, bus: kit.deps.bus, agents: kit.deps.agents, attention: kit.deps.attention });
    const run = { id: 1, taskId: 1, agentId: 'main' } as never;
    kit.deps.bus.emit({ type: 'run', run: { ...(run as object), status: 'running' } as never });
    expect(kit.deps.attention.list().some((i) => i.key.startsWith('budget:warn'))).toBe(false);
    kit.deps.bus.emit({ type: 'run', run: { ...(run as object), status: 'done' } as never });
    expect(kit.deps.attention.list().some((i) => i.key === `budget:warn:main:${month}`)).toBe(true);
    stop();
  });
});
