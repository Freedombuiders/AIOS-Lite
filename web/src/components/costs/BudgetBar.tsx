export function BudgetBar({ percent, warnPercent = 80 }: { percent: number | null; warnPercent?: number }) {
  if (percent === null) return <span class="hint">không giới hạn</span>;
  const p = Math.min(100, percent);
  const color = percent >= 100 ? '#e66767' : percent >= warnPercent ? '#c98500' : '#199e70';
  return (
    <div class="flex items-center gap-2" role="progressbar" aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100} aria-label="Đã dùng ngân sách">
      <div class="h-2 w-28 overflow-hidden rounded bg-[var(--color-elevated)]">
        <div class="h-full rounded" style={{ width: `${p}%`, background: color }} />
      </div>
      <span class="tabular-nums text-[12px]">{Math.round(percent)}%</span>
    </div>
  );
}
