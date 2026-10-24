import { displayName } from './MentionInput';
import { useEffect, useState } from 'preact/hooks';
import { useFetch } from '@/lib/useFetch';

export interface PickerSkill { id: string; name?: string; command: string; description: string; }

export function useSkillPicker(draft: string, select: (value: string) => void) {
  const { data, error } = useFetch<{ items: { id: string; name: string; description: string }[] }>('/skills', 60_000);
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  // Opened from a menu while the draft already has text: every skill is offered and the pick goes in front.
  const [manual, setManual] = useState(false);
  const typed = draft.match(/^\/([^\s]*)$/)?.[1]?.toLowerCase();
  const query = manual ? '' : typed;
  const all = (data?.items ?? []).map((s): PickerSkill => ({ id: s.id, name: s.name, command: s.id, description: s.description }));
  const matches = all.filter((s) => !query || `${s.name ?? ''} ${s.id} ${s.command} ${s.description}`.toLowerCase().includes(query));
  const open = query !== undefined && !dismissed;
  const activeIndex = Math.min(index, Math.max(0, matches.length - 1));
  useEffect(() => { setIndex(0); setDismissed(false); setManual(false); }, [draft]);
  function choose(skill: PickerSkill) {
    const rest = manual ? draft.replace(/^\s+/, '') : '';
    setManual(false);
    select(`/skill ${skill.id} ${rest}`);
  }
  function onKeyDown(e: KeyboardEvent) {
    if (!open || e.isComposing) return false;
    if (e.key === 'Escape') { e.preventDefault(); setDismissed(true); setManual(false); return true; }
    if (!matches.length) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((activeIndex + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length);
      return true;
    }
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      e.preventDefault(); choose(matches[activeIndex]); return true;
    }
    return false;
  }
  const picker = open ? <div class="max-h-64 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-elevated)] mb-2 p-1" aria-label="Skills">
    <div class="px-2 py-1 text-xs text-[var(--color-text-muted)]">Skills · ↑↓ chọn · Enter dùng · Esc đóng</div>
    {!matches.length && <div class="p-2 text-sm">{error ? 'Không tải được skills.' : data ? 'Không tìm thấy skill.' : 'Đang tải skills…'}</div>}
    {matches.map((s, i) => <button key={s.id} type="button"
      ref={(el) => { if (el && i === activeIndex) el.scrollIntoView({ block: 'nearest' }); }}
      onMouseDown={(e) => e.preventDefault()} onClick={() => choose(s)}
      class={`block w-full text-left rounded px-2 py-2 text-sm ${i === activeIndex ? 'bg-[var(--color-control-hover)]' : ''}`}>
      <span class="font-medium text-[var(--color-accent)]">{displayName(s.name, s.id)}</span>
      <span class="block text-xs text-[var(--color-text-muted)] truncate">{s.description}</span>
    </button>)}
  </div> : null;
  /** Open the list without typing "/" (the composer's "+" menu). */
  function openPicker() { setDismissed(false); setIndex(0); setManual(true); }
  return { picker, onKeyDown, skills: all, open, openPicker };
}
