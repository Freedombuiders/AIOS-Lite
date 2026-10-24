// Cost analytics over the runs table + budget warnings. Missing cost_usd means unknown, never zero.
import { camelRow, nowIso, type DB } from '../core/db.js';
import type { EventBus } from '../core/events.js';
import type { AgentRegistry } from '../agents/contracts.js';
import type { AttentionService } from './contracts.js';

export const GLOBAL_BUDGET_KEY = 'costs.globalBudget';
export const DEFAULT_WARN_PERCENT = 80;

export interface GlobalBudget {
  usdMonth: number;
  warnPercent: number;
}

export interface CostBucket {
  costUsd: number;
  runs: number;
  unpricedRuns: number;
  inputTokens: number;
  outputTokens: number;
}

export interface CostSummary {
  days: number;
  since: string;
  totals: CostBucket;
  byDay: Array<{ day: string; costUsd: number; runs: number; unpricedRuns: number; tokens: number; byRuntime: Record<string, number> }>;
  byAgent: Array<CostBucket & { agentId: string; name: string }>;
  byModel: Array<CostBucket & { runtime: string; model: string | null }>;
  bySource: Array<CostBucket & { source: string; label: string }>;
  topTasks: Array<{ taskId: number; title: string; agentId: string; costUsd: number; runs: number }>;
}

export interface BudgetRow {
  agentId: string;
  name: string;
  budgetUsdMonth: number | null;
  spentUsd: number;
  unpricedRuns: number;
  percent: number | null;
  forecastUsd: number;
}

export interface BudgetOverview {
  month: string;
  global: GlobalBudget & { spentUsd: number; unpricedRuns: number; percent: number | null; forecastUsd: number; overBudget: boolean };
  agents: BudgetRow[];
  warnings: Array<{ key: string; title: string; detail: string | null; severity: string; createdAt: string; resolved: boolean }>;
  /** the engine only stops single agents; this tells the owner a global stop is advisable */
  hardStopSuggestion: string | null;
}

const empty = (): CostBucket => ({ costUsd: 0, runs: 0, unpricedRuns: 0, inputTokens: 0, outputTokens: 0 });

export function sourceLabel(source: string): string {
  if (source === 'chat') return 'Chat';
  if (source === 'user') return 'Việc tay';
  if (source.startsWith('schedule:')) return 'Lịch';
  if (source.startsWith('module:')) return `Module ${source.slice(7)}`;
  if (source.startsWith('agent:')) return 'Agent giao';
  return 'Khác';
}

/** group key: schedules collapse into one "schedule" bucket, modules stay per module */
const sourceKey = (source: string): string => (source.startsWith('schedule:') ? 'schedule' : source.startsWith('agent:') ? 'agent' : source);

function add(b: CostBucket, r: { cost: number | null; i: number | null; o: number | null }): void {
  b.runs++;
  if (r.cost == null) b.unpricedRuns++;
  else b.costUsd += r.cost;
  b.inputTokens += r.i ?? 0;
  b.outputTokens += r.o ?? 0;
}

interface RunRow {
  taskId: number;
  agentId: string;
  runtime: string;
  model: string | null;
  startedAt: string;
  cost: number | null;
  i: number | null;
  o: number | null;
  source: string | null;
  title: string | null;
}

export function monthKey(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

export function createCostService({ db, agents }: { db: DB; agents: AgentRegistry }) {
  const agentName = (id: string) => agents.get(id)?.name ?? id;

  const readGlobal = (): GlobalBudget => {
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(GLOBAL_BUDGET_KEY) as { value: string } | undefined;
    try {
      const v = JSON.parse(row?.value ?? '{}') as Partial<GlobalBudget>;
      return { usdMonth: Number(v.usdMonth) > 0 ? Number(v.usdMonth) : 0, warnPercent: Number(v.warnPercent) > 0 ? Number(v.warnPercent) : DEFAULT_WARN_PERCENT };
    } catch {
      return { usdMonth: 0, warnPercent: DEFAULT_WARN_PERCENT };
    }
  };

  const rowsSince = (since: string): RunRow[] =>
    (db.prepare(
      `SELECT r.task_id AS taskId, r.agent_id AS agentId, r.runtime, r.model, r.started_at AS startedAt, r.cost_usd AS cost,
              r.input_tokens AS i, r.output_tokens AS o, t.source, t.title
       FROM runs r LEFT JOIN tasks t ON t.id = r.task_id WHERE r.started_at >= ? ORDER BY r.started_at`,
    ).all(since) as RunRow[]);

  function summary(days: number, now = new Date()): CostSummary {
    const startDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)));
    const since = startDay.toISOString();
    const rows = rowsSince(since);
    const totals = empty();
    const dayMap = new Map<string, CostSummary['byDay'][number]>();
    for (let k = 0; k < days; k++) {
      const day = new Date(startDay.getTime() + k * 86_400_000).toISOString().slice(0, 10);
      dayMap.set(day, { day, costUsd: 0, runs: 0, unpricedRuns: 0, tokens: 0, byRuntime: {} });
    }
    const agentMap = new Map<string, CostBucket & { agentId: string; name: string }>();
    const modelMap = new Map<string, CostBucket & { runtime: string; model: string | null }>();
    const sourceMap = new Map<string, CostBucket & { source: string; label: string }>();
    const taskMap = new Map<number, { taskId: number; title: string; agentId: string; costUsd: number; runs: number }>();

    for (const r of rows) {
      add(totals, r);
      const d = dayMap.get(r.startedAt.slice(0, 10));
      if (d) {
        d.runs++;
        d.tokens += (r.i ?? 0) + (r.o ?? 0);
        if (r.cost == null) d.unpricedRuns++;
        else {
          d.costUsd += r.cost;
          d.byRuntime[r.runtime] = (d.byRuntime[r.runtime] ?? 0) + r.cost;
        }
      }
      let a = agentMap.get(r.agentId);
      if (!a) agentMap.set(r.agentId, (a = { ...empty(), agentId: r.agentId, name: agentName(r.agentId) }));
      add(a, r);
      const mk = `${r.runtime}\u0000${r.model ?? ''}`;
      let m = modelMap.get(mk);
      if (!m) modelMap.set(mk, (m = { ...empty(), runtime: r.runtime, model: r.model }));
      add(m, r);
      const src = r.source ?? 'user';
      const sk = sourceKey(src);
      let s = sourceMap.get(sk);
      if (!s) sourceMap.set(sk, (s = { ...empty(), source: sk, label: sk === 'schedule' ? 'Lịch' : sk === 'agent' ? 'Agent giao' : sourceLabel(src) }));
      add(s, r);
      let t = taskMap.get(r.taskId);
      if (!t) taskMap.set(r.taskId, (t = { taskId: r.taskId, title: r.title ?? `Việc #${r.taskId}`, agentId: r.agentId, costUsd: 0, runs: 0 }));
      t.runs++;
      if (r.cost != null) t.costUsd += r.cost;
    }
    const byCost = <T extends { costUsd: number; runs: number }>(x: T, y: T) => y.costUsd - x.costUsd || y.runs - x.runs;
    return {
      days, since, totals,
      byDay: [...dayMap.values()],
      byAgent: [...agentMap.values()].sort(byCost),
      byModel: [...modelMap.values()].sort(byCost),
      bySource: [...sourceMap.values()].sort(byCost),
      topTasks: [...taskMap.values()].filter((t) => t.costUsd > 0).sort(byCost).slice(0, 10),
    };
  }

  /** spend per agent in the month of `now`: [agentId, cost, unpriced runs] */
  function monthSpend(now = new Date()): Map<string, { spent: number; unpriced: number }> {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const out = new Map<string, { spent: number; unpriced: number }>();
    const q = db.prepare('SELECT agent_id AS agentId, COALESCE(SUM(cost_usd), 0) AS spent, SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced FROM runs WHERE started_at >= ? GROUP BY agent_id');
    for (const r of q.all(start) as Array<{ agentId: string; spent: number; unpriced: number }>) out.set(r.agentId, { spent: r.spent, unpriced: r.unpriced });
    return out;
  }

  function forecast(spent: number, now: Date): number {
    const dim = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
    const elapsed = now.getUTCDate() - 1 + (now.getUTCHours() * 60 + now.getUTCMinutes()) / 1440;
    return elapsed < 0.05 ? spent : (spent / elapsed) * dim;
  }

  function budgets(now = new Date()): BudgetOverview {
    const spend = monthSpend(now);
    const g = readGlobal();
    const rows: BudgetRow[] = agents.list().map((a) => {
      const s = spend.get(a.id) ?? { spent: 0, unpriced: 0 };
      const budget = a.budgetUsdMonth && a.budgetUsdMonth > 0 ? a.budgetUsdMonth : null;
      return { agentId: a.id, name: a.name, budgetUsdMonth: budget, spentUsd: s.spent, unpricedRuns: s.unpriced, percent: budget ? (s.spent / budget) * 100 : null, forecastUsd: forecast(s.spent, now) };
    });
    // spend of agents that were archived still counts toward the global total
    let totalSpent = 0;
    let totalUnpriced = 0;
    for (const s of spend.values()) {
      totalSpent += s.spent;
      totalUnpriced += s.unpriced;
    }
    const month = monthKey(now);
    const warnings = (db.prepare("SELECT * FROM attention WHERE key LIKE 'budget:%' AND key LIKE ? ORDER BY created_at DESC LIMIT 20").all(`%:${month}`) as Record<string, unknown>[])
      .map((r) => camelRow<{ key: string; title: string; detail: string | null; severity: string; createdAt: string; resolvedAt: string | null }>(r)!)
      .map((r) => ({ key: r.key, title: r.title, detail: r.detail, severity: r.severity, createdAt: r.createdAt, resolved: !!r.resolvedAt }));
    const over = g.usdMonth > 0 && totalSpent >= g.usdMonth;
    return {
      month,
      global: { ...g, spentUsd: totalSpent, unpricedRuns: totalUnpriced, percent: g.usdMonth > 0 ? (totalSpent / g.usdMonth) * 100 : null, forecastUsd: forecast(totalSpent, now), overBudget: over },
      agents: rows,
      warnings,
      hardStopSuggestion: over ? `Tổng chi phí tháng ($${totalSpent.toFixed(2)}) đã vượt ngân sách chung ($${g.usdMonth}). Nên tạm dừng các agent hoặc bật dừng khẩn cấp trong Cài đặt.` : null,
    };
  }

  function setGlobal(input: GlobalBudget): GlobalBudget {
    db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(GLOBAL_BUDGET_KEY, JSON.stringify(input));
    return readGlobal();
  }

  return { summary, budgets, readGlobal, setGlobal, monthSpend };
}

export type CostService = ReturnType<typeof createCostService>;

/** Raises a warn attention once per month per scope when spend crosses the warn percent. Returns raised keys. */
export function checkBudgetWarnings({ db, agents, attention }: { db: DB; agents: AgentRegistry; attention: AttentionService }, now = new Date()): string[] {
  const svc = createCostService({ db, agents });
  const overview = svc.budgets(now);
  const month = overview.month;
  const raised: string[] = [];
  const raiseOnce = (scope: string, title: string, detail: string) => {
    const key = `budget:warn:${scope}:${month}`;
    if (db.prepare('SELECT 1 FROM attention WHERE key = ?').get(key)) return;
    attention.raise({ key, kind: 'budget', title, detail, severity: 'warn', link: '/budgets', createdAt: nowIso() });
    raised.push(key);
  };
  const warn = overview.global.warnPercent;
  for (const a of overview.agents) {
    if (a.percent != null && a.percent >= warn) raiseOnce(a.agentId, `${a.name} đã dùng ${Math.floor(a.percent)}% ngân sách tháng`, `Đã chi $${a.spentUsd.toFixed(2)} / $${a.budgetUsdMonth}`);
  }
  const g = overview.global;
  if (g.percent != null && g.percent >= warn) raiseOnce('global', `Đã dùng ${Math.floor(g.percent)}% ngân sách AI chung của tháng`, `Đã chi $${g.spentUsd.toFixed(2)} / $${g.usdMonth}`);
  return raised;
}

export interface CostWatcherDeps {
  db: DB;
  bus: EventBus;
  agents: AgentRegistry;
  attention: AttentionService;
}

/** Subscribes to finished runs; returns the unsubscribe function. */
export function startCostWatcher(deps: CostWatcherDeps): () => void {
  return deps.bus.on('run', (e) => {
    if (e.run.status === 'running') return;
    try {
      checkBudgetWarnings(deps);
    } catch {
      /* the watcher must never break a run */
    }
  });
}
