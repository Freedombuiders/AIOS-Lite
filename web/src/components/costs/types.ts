// Mirrors the JSON of /api/costs/* (src/work/costs.ts).
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
  global: { usdMonth: number; warnPercent: number; spentUsd: number; unpricedRuns: number; percent: number | null; forecastUsd: number; overBudget: boolean };
  agents: BudgetRow[];
  warnings: Array<{ key: string; title: string; detail: string | null; severity: string; createdAt: string; resolved: boolean }>;
  hardStopSuggestion: string | null;
}
