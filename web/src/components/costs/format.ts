import { formatCost, formatNumber } from '@/lib/format';
import type { CostBucket } from './types';

export const RUNTIME_COLORS: Record<string, string> = { claude: '#d95926', codex: '#3987e5', grok: '#199e70', hermes: '#c98500', mock: '#8a8f98' };
export const runtimeColor = (rt: string): string => RUNTIME_COLORS[rt] ?? '#8a8f98';

/** Cost cell: unknown prices are shown as such, never as $0. */
export function costCell(b: Pick<CostBucket, 'costUsd' | 'runs' | 'unpricedRuns'>): string {
  if (b.runs > 0 && b.unpricedRuns === b.runs) return 'chưa có giá';
  const base = formatCost(b.costUsd);
  return b.unpricedRuns > 0 ? `${base} +${b.unpricedRuns} chưa có giá` : base;
}

export const tokenCell = (b: Pick<CostBucket, 'inputTokens' | 'outputTokens'>): string => `${formatNumber(b.inputTokens)} / ${formatNumber(b.outputTokens)}`;
