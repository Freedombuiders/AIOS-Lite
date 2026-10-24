import { AgentBudgetTable } from '@/components/costs/AgentBudgetTable';
import { GlobalBudgetForm } from '@/components/costs/GlobalBudgetForm';
import type { BudgetOverview } from '@/components/costs/types';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { Card } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { useFetch } from '@/lib/useFetch';

export default function BudgetsPage() {
  const { data, loading, error, refresh } = useFetch<BudgetOverview>('/api/costs/budgets');
  return (
    <div class="page">
      <PageHeader title="Ngân sách AI" breadcrumb={data ? `Tháng ${data.month.slice(5)}/${data.month.slice(0, 4)}` : undefined} />
      <PageState loading={loading && !data} error={error} />
      {data && (
        <div class="flex flex-col gap-4">
          {data.hardStopSuggestion && <div class="card card-pad text-[13px] text-[#e66767]" role="alert">{data.hardStopSuggestion}</div>}
          <GlobalBudgetForm key={`${data.global.usdMonth}/${data.global.warnPercent}`} global={data.global} onSaved={refresh} />
          <AgentBudgetTable rows={data.agents} warnPercent={data.global.warnPercent} onSaved={refresh} />
          <Card title="Cảnh báo gần đây">
            {data.warnings.length === 0 ? (
              <p class="hint">Chưa có cảnh báo nào trong tháng này.</p>
            ) : (
              <ul class="m-0 flex list-none flex-col gap-2 p-0">
                {data.warnings.map((w) => (
                  <li key={w.key} class="text-[13px]">
                    <b>{w.title}</b>{w.resolved && <span class="hint"> (đã xử lý)</span>}
                    <div class="hint">{w.detail} · {formatDateTime(w.createdAt)}</div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
