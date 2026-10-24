import type { ComponentChildren } from 'preact';
import { Card } from '@/components/ui';
import { formatNumber } from '@/lib/format';
import { costCell, tokenCell } from './format';
import type { CostBucket } from './types';

export interface BreakdownRow extends CostBucket {
  key: string;
  label: ComponentChildren;
}

export function BreakdownTable({ title, firstCol, rows }: { title: string; firstCol: string; rows: BreakdownRow[] }) {
  return (
    <Card title={title}>
      {rows.length === 0 ? (
        <p class="hint">Chưa có lượt chạy nào trong khoảng này.</p>
      ) : (
        <table class="table">
          <thead>
            <tr><th>{firstCol}</th><th class="text-right">Chi phí</th><th class="text-right">Lượt</th><th class="text-right">Token vào / ra</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td>{r.label}</td>
                <td class={`text-right tabular-nums ${r.unpricedRuns > 0 ? 'text-[var(--color-text-muted)]' : ''}`}>{costCell(r)}</td>
                <td class="text-right tabular-nums">{formatNumber(r.runs)}</td>
                <td class="text-right tabular-nums">{tokenCell(r)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
