import { useState } from 'preact/hooks';
import { Card, Field } from '@/components/ui';
import { apiPut, errorText } from '@/lib/api';
import { formatCost } from '@/lib/format';
import { BudgetBar } from './BudgetBar';
import type { BudgetOverview } from './types';

export function GlobalBudgetForm({ global, onSaved }: { global: BudgetOverview['global']; onSaved: () => void }) {
  const [usd, setUsd] = useState(String(global.usdMonth || ''));
  const [warn, setWarn] = useState(String(global.warnPercent));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function save(e: Event) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await apiPut('/api/costs/budgets/global', { usdMonth: Number(usd) || 0, warnPercent: Number(warn) || 80 });
      setMsg('Đã lưu.');
      onSaved();
    } catch (err) {
      setMsg(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Ngân sách chung của tháng">
      <form class="flex flex-wrap items-end gap-3" onSubmit={save}>
        <Field label="Ngân sách tháng (USD)" hint="Để trống hoặc 0 nếu không giới hạn">
          <input class="input w-40" type="number" min="0" step="0.5" value={usd} onInput={(e) => setUsd((e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="Cảnh báo khi dùng (%)">
          <input class="input w-28" type="number" min="1" max="100" value={warn} onInput={(e) => setWarn((e.target as HTMLInputElement).value)} />
        </Field>
        <button class="btn btn-primary" type="submit" disabled={busy}>Lưu</button>
        {msg && <span class="hint">{msg}</span>}
      </form>
      <div class="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-[13px]">
        <span>Đã chi tháng này: <b>{formatCost(global.spentUsd)}</b>{global.unpricedRuns > 0 && <span class="hint"> (+{global.unpricedRuns} lượt chưa có giá)</span>}</span>
        <span>Dự báo cuối tháng: <b>{formatCost(global.forecastUsd)}</b></span>
        <BudgetBar percent={global.percent} warnPercent={global.warnPercent} />
      </div>
    </Card>
  );
}
