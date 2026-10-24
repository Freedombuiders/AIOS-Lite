// Mock of /api/costs/* for the UI preview. Deterministic data, built from the mock agents.
import * as d from './data';

type Handler = (params: string[], q: URLSearchParams, body: any) => unknown;
export const costRoutes: Array<[string, string, Handler]> = [];

const RUNTIMES = ['claude', 'codex', 'grok'] as const;
const MODELS: Record<string, string> = { claude: 'opus', codex: 'gpt-5', grok: 'grok-4' };
const SOURCES: Array<[string, string]> = [['chat', 'Chat'], ['user', 'Việc tay'], ['schedule', 'Lịch'], ['module:care', 'Module care'], ['agent', 'Agent giao']];

const bucket = () => ({ costUsd: 0, runs: 0, unpricedRuns: 0, inputTokens: 0, outputTokens: 0 });

costRoutes.push(['GET', '/costs/summary', (_p, q) => {
  const days = Number(q.get('days') ?? 30);
  const totals = bucket();
  const agents = d.agents.map((a) => ({ ...bucket(), agentId: a.id, name: a.name }));
  const models = RUNTIMES.map((rt) => ({ ...bucket(), runtime: rt, model: MODELS[rt] as string | null }));
  const sources = SOURCES.map(([source, label]) => ({ ...bucket(), source, label }));
  const byDay = [];
  for (let k = 0; k < days; k++) {
    const day = new Date(Date.now() - (days - 1 - k) * 86_400_000).toISOString().slice(0, 10);
    const row = { day, costUsd: 0, runs: 0, unpricedRuns: 0, tokens: 0, byRuntime: {} as Record<string, number> };
    RUNTIMES.forEach((rt, ri) => {
      const runs = (k * 7 + ri * 3) % 5;
      const priced = rt !== 'codex';
      const cost = priced ? ((k * 13 + ri * 5) % 9) * 0.12 + 0.05 : 0;
      const tokens = runs * 1800;
      const a = agents[(k + ri) % agents.length]!;
      for (const b of [row, totals, a, models[ri]!, sources[(k + ri) % sources.length]!]) {
        b.runs += runs;
        if (!priced) b.unpricedRuns += runs;
        b.costUsd += cost;
        if ('tokens' in b) b.tokens += tokens;
        else {
          (b as ReturnType<typeof bucket>).inputTokens += tokens;
          (b as ReturnType<typeof bucket>).outputTokens += Math.round(tokens / 8);
        }
      }
      if (priced && runs) row.byRuntime[rt] = cost;
    });
    byDay.push(row);
  }
  return {
    days, since: byDay[0]!.day, totals, byDay,
    byAgent: agents.filter((a) => a.runs > 0), byModel: models, bySource: sources,
    topTasks: d.tasks.slice(0, 5).map((t, i) => ({ taskId: t.id, title: t.title, agentId: t.agentId, costUsd: 1.8 - i * 0.3, runs: 3 - (i % 3) })),
  };
}]);

let globalBudget = { usdMonth: 60, warnPercent: 80 };

costRoutes.push(['GET', '/costs/budgets', () => {
  const rows = d.agents.map((a) => {
    const budget = a.budgetUsdMonth && a.budgetUsdMonth > 0 ? a.budgetUsdMonth : null;
    const spent = a.stats.costMonthUsd;
    return { agentId: a.id, name: a.name, budgetUsdMonth: budget, spentUsd: spent, unpricedRuns: a.runtime === 'codex' ? a.stats.runsMonth : 0, percent: budget ? (spent / budget) * 100 : null, forecastUsd: spent * 2 };
  });
  const spent = rows.reduce((s, r) => s + r.spentUsd, 0);
  const month = new Date().toISOString().slice(0, 7);
  return {
    month,
    global: { ...globalBudget, spentUsd: spent, unpricedRuns: rows.reduce((s, r) => s + r.unpricedRuns, 0), percent: globalBudget.usdMonth ? (spent / globalBudget.usdMonth) * 100 : null, forecastUsd: spent * 2, overBudget: globalBudget.usdMonth > 0 && spent >= globalBudget.usdMonth },
    agents: rows,
    warnings: [{ key: `budget:warn:main:${month}`, title: 'Trợ lý chính đã dùng 80% ngân sách tháng', detail: 'Đã chi $24.00 / $30', severity: 'warn', createdAt: d.NOW(), resolved: false }],
    hardStopSuggestion: null,
  };
}]);

costRoutes.push(['PUT', '/costs/budgets/global', (_p, _q, b) => (globalBudget = { usdMonth: Number(b.usdMonth) || 0, warnPercent: Number(b.warnPercent) || 80 })]);
