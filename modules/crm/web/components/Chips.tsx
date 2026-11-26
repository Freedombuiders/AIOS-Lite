import { DUE_CHIP_CLASS, dueChip } from '../lib/format';
import { STAGE_CHIP, STAGE_LABEL } from '../lib/stages';
import type { Stage } from '../lib/types';

export function StageChip({ stage }: { stage: Stage }) {
  return <span class={`inline-block rounded-full px-2.5 py-[3px] text-[12px] font-semibold ${STAGE_CHIP[stage]}`}>{STAGE_LABEL[stage]}</span>;
}

export function DueChip({ dueAtMs, nowMs }: { dueAtMs: number | null | undefined; nowMs: number }) {
  const c = dueChip(dueAtMs, nowMs);
  return <span class={`inline-block rounded-full px-2 py-px text-[12px] font-semibold ${DUE_CHIP_CLASS[c.tone]}`}>{c.text}</span>;
}

export function TagChips({ tags, max = 3 }: { tags: readonly string[]; max?: number }) {
  if (!tags.length) return <span class="text-[var(--color-text-faint)]">—</span>;
  return (
    <span class="flex flex-wrap gap-1.5">
      {tags.slice(0, max).map((t) => <span key={t} class="rounded-full bg-[rgba(255,255,255,0.07)] px-2 py-px text-[12px] text-[var(--color-control-text)]">{t}</span>)}
      {tags.length > max && <span class="text-[12px] text-[var(--color-text-faint)]">+{tags.length - max}</span>}
    </span>
  );
}
