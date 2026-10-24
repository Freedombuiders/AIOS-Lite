import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { Plus, X } from 'lucide-preact';
import { BTN_SM, INPUT } from '@modules/radar/web/components/ui';

/** Chips editor for string[]; Enter or comma adds, backspace-free: click x to remove. */
export function Chips({ value, onChange, placeholder, label }: {
  value: string[]; onChange: (v: string[]) => void; placeholder?: string; label: string;
}) {
  const [draft, setDraft] = useState('');
  function add() {
    const parts = draft.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    if (parts.length) onChange([...value, ...parts.filter((p) => !value.includes(p))]);
    setDraft('');
  }
  return (
    <div class="flex flex-wrap items-center gap-1.5 min-w-0">
      {value.map((v, i) => (
        <span key={`${v}-${i}`} class="inline-flex items-center gap-1 h-7 pl-2.5 pr-1 rounded-full bg-[var(--color-elevated)] border border-[var(--color-border)] text-[12px] max-w-full">
          <span class="truncate">{v}</span>
          <button type="button" aria-label={`Xóa ${v}`} class="p-0.5 rounded-full hover:bg-[var(--color-control-hover)]" onClick={() => onChange(value.filter((_, j) => j !== i))}><X size={12} /></button>
        </span>
      ))}
      <input
        class={`${INPUT} h-7 text-[12px] w-48`}
        aria-label={label}
        placeholder={placeholder ?? 'Thêm, Enter để lưu'}
        value={draft}
        onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
        onBlur={add}
      />
    </div>
  );
}

export function Row({ label, hint, children }: { label: string; hint?: string; children: ComponentChildren }) {
  return (
    <div class="grid gap-1.5 md:grid-cols-[170px_1fr] md:gap-4 items-start">
      <div class="pt-1.5">
        <div class="text-[12.5px] font-medium text-[var(--color-text)]">{label}</div>
        {hint && <div class="text-[11.5px] text-[var(--color-text-muted)]">{hint}</div>}
      </div>
      <div class="min-w-0">{children}</div>
    </div>
  );
}

export function Check({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label class="inline-flex items-center gap-2 text-[13px]">
      <input type="checkbox" class="w-4 h-4 accent-[var(--color-accent)]" checked={checked} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} />
      {label}
    </label>
  );
}

export interface Col<T> { head: string; w?: string; cell: (row: T, set: (patch: Partial<T>) => void) => ComponentChildren }

/** Editable table with add/remove rows. */
export function RowsTable<T>({ rows, cols, onChange, blank, addLabel }: {
  rows: T[]; cols: Col<T>[]; onChange: (rows: T[]) => void; blank: () => T; addLabel: string;
}) {
  return (
    <div class="flex flex-col gap-2 min-w-0">
      {rows.length > 0 && (
        <div class="overflow-x-auto">
          <table class="w-full text-[12.5px]">
            <thead>
              <tr class="text-left text-[11px] uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
                {cols.map((c) => <th key={c.head} class="pr-2 pb-1 font-semibold">{c.head}</th>)}
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i}>
                  {cols.map((c) => (
                    <td key={c.head} class="pr-2 py-0.5 align-middle" style={c.w ? { minWidth: c.w } : undefined}>
                      {c.cell(row, (patch) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r))))}
                    </td>
                  ))}
                  <td><button type="button" aria-label="Xóa dòng" class="p-1 rounded hover:bg-[var(--color-control-hover)]" onClick={() => onChange(rows.filter((_, j) => j !== i))}><X size={14} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div><button type="button" class={BTN_SM} onClick={() => onChange([...rows, blank()])}><Plus size={12} class="mr-1" />{addLabel}</button></div>
    </div>
  );
}

export function TextCell({ value, onChange, placeholder, label }: { value: string; onChange: (v: string) => void; placeholder?: string; label: string }) {
  return <input class={`${INPUT} h-8 w-full text-[12.5px]`} aria-label={label} placeholder={placeholder} value={value} onInput={(e) => onChange((e.target as HTMLInputElement).value)} />;
}

export function NumCell({ value, onChange, label, w = 'w-24' }: { value: number | undefined; onChange: (v: number | undefined) => void; label: string; w?: string }) {
  return (
    <input
      type="number" min={0} class={`${INPUT} h-8 ${w} text-[12.5px]`} aria-label={label} value={value ?? ''}
      onInput={(e) => { const s = (e.target as HTMLInputElement).value; onChange(s === '' ? undefined : Number(s)); }}
    />
  );
}
