import { useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { BreakdownTable } from '@/components/costs/BreakdownTable';
import { DailyCostChart } from '@/components/costs/DailyCostChart';
import { costCell, runtimeColor } from '@/components/costs/format';
import type { CostSummary } from '@/components/costs/types';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { Card, Stat } from '@/components/ui';
import { formatCost, formatNumber } from '@/lib/format';
import { useFetch } from '@/lib/useFetch';

const PERIODS = [7, 30, 90] as const;

export default function UsagePage() {
  const [days, setDays] = useState<number>(30);
  const { data, loading, error } = useFetch<CostSummary>(`/api/costs/summary?days=${days}`);

  const switcher = (
    <div class="flex gap-1" role="group" aria-label="Khoảng thời gian">
      {PERIODS.map((p) => (
        <button key={p} type="button" class={`btn ${days === p ? 'btn-primary' : ''}`} aria-pressed={days === p} onClick={() => setDays(p)}>
          {p} ngày
        </button>
      ))}
    </div>
  );

  return (
    <div class="page">
      <PageHeader title="Chi phí AI" actions={switcher} />
      <PageState loading={loading && !data} error={error} />
      {data && (
        <div class="flex flex-col gap-4">
          <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Tổng chi phí" value={data.totals.runs > 0 && data.totals.unpricedRuns === data.totals.runs ? 'chưa có giá' : formatCost(data.totals.costUsd)} sub={`${data.days} ngày gần nhất`} />
            <Stat label="Số lượt chạy" value={formatNumber(data.totals.runs)} />
            <Stat label="Lượt chưa có giá" value={formatNumber(data.totals.unpricedRuns)} sub="Runtime không báo chi phí (vd. Codex)" />
            <Stat label="Token vào / ra" value={`${formatNumber(data.totals.inputTokens)} / ${formatNumber(data.totals.outputTokens)}`} />
          </div>
          <Card title="Chi phí theo ngày">
            <DailyCostChart byDay={data.byDay} />
          </Card>
          <div class="grid gap-4 lg:grid-cols-2">
            <BreakdownTable title="Theo agent" firstCol="Agent" rows={data.byAgent.map((a) => ({ ...a, key: a.agentId, label: <Link href={`/agents/${a.agentId}`}>{a.name}</Link> }))} />
            <BreakdownTable
              title="Theo runtime và model"
              firstCol="Model"
              rows={data.byModel.map((m) => ({
                ...m,
                key: `${m.runtime}/${m.model ?? ''}`,
                label: (
                  <span class="inline-flex items-center gap-1.5">
                    <span class="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: runtimeColor(m.runtime) }} aria-hidden="true" />
                    {m.runtime} · {m.model ?? 'mặc định'}
                  </span>
                ),
              }))}
            />
          </div>
          <BreakdownTable title="Theo nguồn việc" firstCol="Nguồn" rows={data.bySource.map((s) => ({ ...s, key: s.source, label: s.label }))} />
          <Card title="Việc tốn kém nhất">
            {data.topTasks.length === 0 ? (
              <p class="hint">Chưa có việc nào có chi phí.</p>
            ) : (
              <table class="table">
                <thead><tr><th>Việc</th><th>Agent</th><th class="text-right">Lượt</th><th class="text-right">Chi phí</th></tr></thead>
                <tbody>
                  {data.topTasks.map((t) => (
                    <tr key={t.taskId}>
                      <td><Link href={`/tasks/${t.taskId}`}>{t.title}</Link></td>
                      <td>{t.agentId}</td>
                      <td class="text-right tabular-nums">{t.runs}</td>
                      <td class="text-right tabular-nums">{costCell({ costUsd: t.costUsd, runs: t.runs, unpricedRuns: 0 })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
