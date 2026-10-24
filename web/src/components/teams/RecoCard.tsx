import { Check, ShoppingCart, SkipForward, Undo2 } from 'lucide-preact';
import { Pill } from '@/components/Pill';
import { ARM_LABEL, EFFORT_LABEL, PRIORITY_LABEL, type Reco } from '@/lib/teams';

export interface RecoCardProps {
  reco: Reco;
  busy?: boolean;
  onCart: () => void;
  onUncart: () => void;
  onSkip: () => void;
  onApply: () => void;
}

export function RecoCard({ reco, busy, onCart, onUncart, onSkip, onApply }: RecoCardProps) {
  const open = reco.status === 'new' || reco.status === 'cart';
  return (
    <article class={`card card-pad ${reco.status === 'cart' ? 'border-[var(--color-accent)]' : ''}`} data-reco={reco.id}>
      <div class="flex flex-wrap items-start justify-between gap-2">
        <div class="min-w-0 flex-1">
          <div class="mb-1 flex flex-wrap items-center gap-1.5">
            <Pill tone="accent">{ARM_LABEL[reco.arm]}</Pill>
            <Pill tone={reco.priority === 1 ? 'error' : reco.priority === 2 ? 'warn' : 'neutral'}>{PRIORITY_LABEL[reco.priority]}</Pill>
            <span class="hint">Công sức: {EFFORT_LABEL[reco.effort]}</span>
            {reco.status === 'done' && <Pill tone="success">đã áp dụng</Pill>}
            {reco.status === 'skipped' && <Pill>đã bỏ qua</Pill>}
          </div>
          <h3 class="m-0 text-[13px] font-medium">{reco.title}</h3>
          <p class="m-0 mt-1 text-[12px] text-[var(--color-text-muted)]">{reco.benefit}</p>
          <p class="m-0 mt-1 text-[12px]"><span class="font-medium">Sẽ làm:</span> {reco.actionText}</p>
          {reco.evidence.length > 0 && <ul class="hint m-0 mt-1 list-disc pl-4">{reco.evidence.map((e) => <li key={e}>{e}</li>)}</ul>}
          {reco.result && <p class="m-0 mt-1 text-[12px] text-[var(--color-status-done)]">{reco.result}</p>}
        </div>
        {open && (
          <div class="flex flex-wrap items-center gap-1.5">
            {reco.status === 'cart'
              ? <button type="button" class="control-button control-sm" disabled={busy} onClick={onUncart}><Undo2 size={11} /> Bỏ khỏi giỏ</button>
              : <button type="button" class="control-button control-sm" disabled={busy} onClick={onCart}><ShoppingCart size={11} /> Thêm vào giỏ</button>}
            <button type="button" class="control-button control-sm" disabled={busy} onClick={onSkip}><SkipForward size={11} /> Bỏ qua</button>
            <button type="button" class="control-button control-accent control-sm" disabled={busy} onClick={onApply}><Check size={11} /> Áp dụng</button>
          </div>
        )}
      </div>
    </article>
  );
}
