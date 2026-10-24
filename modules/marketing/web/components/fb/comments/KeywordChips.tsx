// Editable list of keywords shown as removable chips.

import { useState } from 'preact/hooks';
import { X } from 'lucide-preact';

export function KeywordChips({ value, onChange, label, placeholder = 'Thêm từ khóa, Enter để lưu' }: {
  value: string[];
  onChange: (next: string[]) => void;
  label: string;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState('');

  function commit() {
    const parts = draft.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) return;
    const seen = new Set(value.map((v) => v.toLowerCase()));
    const add = parts.filter((p) => {
      const k = p.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (add.length > 0) onChange([...value, ...add]);
    setDraft('');
  }

  return (
    <div class="flex flex-wrap items-center gap-1.5" role="group" aria-label={label}>
      {value.map((k) => (
        <span key={k} class="inline-flex items-center gap-1 h-[26px] pl-2.5 pr-1 rounded-md bg-[var(--color-elevated)] text-[12.5px]">
          {k}
          <button
            type="button"
            aria-label={`Bỏ “${k}”`}
            class="w-5 h-5 inline-flex items-center justify-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-control-hover)]"
            onClick={() => onChange(value.filter((x) => x !== k))}
          >
            <X size={11} />
          </button>
        </span>
      ))}
      <input
        value={draft}
        placeholder={placeholder}
        aria-label={`Thêm vào: ${label}`}
        class="h-[26px] flex-1 min-w-[140px] px-2 rounded-md border border-dashed border-[var(--color-border-strong)] bg-transparent text-[12.5px] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)] focus:outline-none"
        onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); }
          else if (e.key === 'Backspace' && !draft && value.length > 0) onChange(value.slice(0, -1));
        }}
        onBlur={commit}
      />
    </div>
  );
}
