import type { DB } from '../core/db.js';
import type { AgentRegistry } from '../agents/contracts.js';
import type { RunService, StatsService, TaskService } from './contracts.js';

export function createStatsService({ db, agents, runs, tasks }: { db: DB; agents: AgentRegistry; runs: RunService; tasks: TaskService }): StatsService {
  return {
    overview() {
      const list = agents.list();
      const d = new Date();
      const dayStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
      const monthStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
      const running = (db.prepare("SELECT COUNT(DISTINCT agent_id) AS n FROM tasks WHERE status = 'running'").get() as { n: number }).n;
      const runsToday = (db.prepare('SELECT COUNT(*) AS n FROM runs WHERE started_at >= ?').get(dayStart) as { n: number }).n;
      const byAgent = db
        .prepare('SELECT agent_id, COALESCE(SUM(cost_usd), 0) AS cost, COUNT(*) AS runs FROM runs WHERE started_at >= ? GROUP BY agent_id ORDER BY cost DESC')
        .all(monthStart) as { agent_id: string; cost: number; runs: number }[];
      const costByAgent = byAgent.map((r) => ({ agentId: r.agent_id, costUsd: r.cost, runs: r.runs }));
      return {
        agents: { total: list.length, enabled: list.filter((a) => a.enabled).length, running },
        tasks: tasks.counts(),
        runsToday,
        costMonthUsd: costByAgent.reduce((s, r) => s + r.costUsd, 0),
        costByAgent,
        recentRuns: runs.list({ limit: 10 }),
      };
    },
  };
}
