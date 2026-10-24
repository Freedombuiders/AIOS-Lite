import { GRANT_LEVELS, type IntegrationGrant } from '@/lib/integrations';

/** Segmented Tắt / Chỉ đọc / Hỏi trước / Đọc & ghi picker. */
export function GrantControl({ value, onChange, disabled, label }: { value: IntegrationGrant; onChange: (v: IntegrationGrant) => void; disabled?: boolean; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} class="inline-flex overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)]">
      {GRANT_LEVELS.map((l) => {
        const on = l.value === value;
        return (
          <button
            key={l.value}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            title={l.hint}
            class={`border-0 px-2.5 py-1 text-[12px] disabled:opacity-50 ${on ? (l.value === 'write' ? 'bg-[var(--color-status-failed)] text-white' : 'control-accent') : 'bg-transparent text-[var(--color-text-muted)] hover:bg-[var(--color-control-hover)]'}`}
            onClick={() => !on && onChange(l.value)}
          >
            {l.label}
          </button>
        );
      })}
    </div>
  );
}
