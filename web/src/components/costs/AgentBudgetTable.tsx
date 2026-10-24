import { useState } from 'preact/hooks';
import { Card } from '@/components/ui';
import { apiPut, errorText } from '@/lib/api';
import { formatCost } from '@/lib/format';
import { BudgetBar } from './BudgetBar';
import type { BudgetRow } from './types';

function BudgetCell({ row, onSaved }: { row: BudgetRow; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(String(row.budgetUsdMonth ?? ''));
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    try {
      await apiPut(`/api/agents/${encodeURIComponent(row.agentId)}`, { budgetUsdMonth: Number(val) || 0 });
      setEditing(false);
      setErr(null);
      onSaved();
    } catch (e) {
      setErr(errorText(e));
    }
  }

  if (!editing) {
    return (
      <button type="button" class="btn btn-ghost" onClick={() => setEditing(true)} aria-label={`Sửa ngân sách của ${row.name}`}>
        {row.budgetUsdMonth ? formatCost(row.budgetUsdMonth) : 'Không giới hạn'}
      </button>
    );
  }
  return (
    <span class="inline-flex items-center gap-1">
      <input class="input w-24" type="number" min="0" step="0.5" value={val} aria-label={`Ngân sách của ${row.name}`} onInput={(e) => setVal((e.target as HTMLInputElement).value)} />
      <button type="button" class="btn btn-primary" onClick={save}>Lưu</button>
      <button type="button" class="btn" onClick={() => setEditing(false)}>Hủy</button>
      {err && <span class="hint">{err}</span>}
    </span>
  );
}

export function AgentBudgetTable({ rows, warnPercent, onSaved }: { rows: BudgetRow[]; warnPercent: number; onSaved: () => void }) {
  return (
    <Card title="Ngân sách từng agent">
      {rows.length === 0 ? (
        <p class="hint">Chưa có agent nào.</p>
      ) : (
        <table class="table">
          <thead>
            <tr><th>Agent</th><th>Ngân sách tháng</th><th class="text-right">Đã chi</th><th>Mức dùng</th><th class="text-right">Dự báo</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.agentId}>
                <td>{r.name}</td>
                <td><BudgetCell row={r} onSaved={onSaved} /></td>
                <td class="text-right tabular-nums">
                  {formatCost(r.spentUsd)}
                  {r.unpricedRuns > 0 && <div class="hint">+{r.unpricedRuns} lượt chưa có giá</div>}
                </td>
                <td><BudgetBar percent={r.percent} warnPercent={warnPercent} /></td>
                <td class={`text-right tabular-nums ${r.budgetUsdMonth && r.forecastUsd > r.budgetUsdMonth ? 'text-[#e66767]' : ''}`}>{formatCost(r.forecastUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
