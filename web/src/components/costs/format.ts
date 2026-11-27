import { formatCost, formatNumber } from '@/lib/format';
import type { CostBucket } from './types';

// runs of an engine of an earlier version (history) fall back to grey
export const RUNTIME_COLORS: Record<string, string> = { genbot: '#7a5cd6', mock: '#8a8f98' };
export const runtimeColor = (rt: string): string => RUNTIME_COLORS[rt] ?? '#8a8f98';

/** Cost cell: unknown prices are shown as such, never as $0. */
export function costCell(b: Pick<CostBucket, 'costUsd' | 'runs' | 'unpricedRuns'>): string {
  if (b.runs > 0 && b.unpricedRuns === b.runs) return 'chưa có giá';
  const base = formatCost(b.costUsd);
  return b.unpricedRuns > 0 ? `${base} +${b.unpricedRuns} chưa có giá` : base;
}

export const tokenCell = (b: Pick<CostBucket, 'inputTokens' | 'outputTokens'>): string => `${formatNumber(b.inputTokens)} / ${formatNumber(b.outputTokens)}`;
