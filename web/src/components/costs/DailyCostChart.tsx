import { useState } from 'preact/hooks';
import { Legend } from '@/components/fb/charts/Legend';
import { StackedBars } from '@/components/fb/charts/StackedBars';
import { formatCost } from '@/lib/format';
import { runtimeColor } from './format';
import type { CostSummary } from './types';

export function DailyCostChart({ byDay }: { byDay: CostSummary['byDay'] }) {
  const [active, setActive] = useState<number | null>(null);
  const runtimes = [...new Set(byDay.flatMap((d) => Object.keys(d.byRuntime)))].sort();
  if (runtimes.length === 0) return <p class="hint">Chưa có chi phí nào được ghi nhận trong khoảng này.</p>;
  const series = runtimes.map((rt) => ({ key: rt, label: rt, color: runtimeColor(rt) }));
  const values = byDay.map((d) => runtimes.map((rt) => d.byRuntime[rt] ?? 0));
  const labels = byDay.map((d) => `${d.day.slice(8, 10)}/${d.day.slice(5, 7)}`);
  return (
    <div class="flex flex-col gap-2">
      <Legend items={series.map((s) => ({ label: s.label, color: s.color }))} />
      <StackedBars
        series={series}
        values={values}
        labels={labels}
        active={active}
        onActive={setActive}
        formatAxis={(v) => formatCost(v)}
        groupLabel="Chi phí theo ngày"
        ariaOf={(i) => `${labels[i]}: ${formatCost(byDay[i]!.costUsd)}${byDay[i]!.unpricedRuns ? `, ${byDay[i]!.unpricedRuns} lượt chưa có giá` : ''}`}
        tooltip={(i) => (
          <div>
            <div class="font-medium">{labels[i]}</div>
            {runtimes.filter((rt) => byDay[i]!.byRuntime[rt]).map((rt) => <div key={rt}>{rt}: {formatCost(byDay[i]!.byRuntime[rt])}</div>)}
            <div>{byDay[i]!.runs} lượt{byDay[i]!.unpricedRuns ? `, ${byDay[i]!.unpricedRuns} chưa có giá` : ''}</div>
          </div>
        )}
      />
    </div>
  );
}
