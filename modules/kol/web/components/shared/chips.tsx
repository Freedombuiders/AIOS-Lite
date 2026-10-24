import { useState } from 'preact/hooks';
import { X } from 'lucide-preact';
import { INPUT } from './ops-shared';

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
