import { displayName, type ComposerInput } from './MentionInput';
import type { RefObject } from 'preact';
import { useEffect, useId, useState } from 'preact/hooks';
import { Bot } from 'lucide-preact';
import { AgentAvatar } from '@/components/AgentAvatar';
import { StatusDot } from '@/components/Pill';

export interface PickerAgent { id: string; name: string; description?: string; running?: boolean }
const normalize = (value: string) => value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');

/** `$` mention picker for the chat composer. A message that opens with
 *  `$agent` goes straight to that agent; a `$agent` later in the message
 *  asks the chat agent to hand that part of the work over. */
export function useAgentPicker(draft: string, input: RefObject<ComposerInput | HTMLTextAreaElement>, select: (text: string) => void, agents: PickerAgent[]) {
  const [caret, setCaret] = useState(0);
  const [index, setIndex] = useState(0);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const listId = useId();
  const prefix = draft.slice(0, caret);
  // Letter-first query so `$5` or `$100` never opens the picker.
  const match = prefix.match(/(?:^|\s)\$((?:\p{L}[\p{L}\p{N}_-]*)?)$/u);
  const query = match?.[1];
  const start = match ? prefix.length - match[1].length - 1 : -1;
  const triggerKey = `${caret}:${draft}`;
  const open = query !== undefined && dismissedKey !== triggerKey;
  const visible = agents
    .filter((a) => a.id !== 'main' && normalize(`${a.id} ${a.name} ${a.description ?? ''}`).includes(normalize(query ?? '')))
    .sort((a, b) => Number(!!b.running) - Number(!!a.running) || (a.name || a.id).localeCompare(b.name || b.id));
  const active = Math.min(index, Math.max(0, visible.length - 1));
  useEffect(() => { setIndex(0); }, [query, start]);

  function syncCaret() { setCaret(input.current?.selectionStart ?? draft.length); }
  function choose(agent: PickerAgent) {
    const token = `$${agent.id} `;
    select(draft.slice(0, start) + token + draft.slice(caret));
    const nextCaret = start + token.length;
    setCaret(nextCaret);
    setDismissedKey(triggerKey);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(nextCaret, nextCaret); });
  }
  function onKeyDown(event: KeyboardEvent) {
    if (!open || event.isComposing) return false;
    if (event.key === 'Escape') { event.preventDefault(); setDismissedKey(triggerKey); return true; }
    if (!visible.length) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setIndex((active + (event.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length);
      return true;
    }
    if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
      event.preventDefault(); choose(visible[active]); return true;
    }
    return false;
  }
  const picker = open ? <div class="mb-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-elevated)] shadow-lg overflow-hidden">
    <div class="px-3 py-2 text-[11px] text-[var(--color-text-muted)] flex items-center gap-2"><Bot size={14} />Agents · đầu tin: chat trực tiếp · giữa câu: giao việc · ↑↓ Enter Esc</div>
    <div id={listId} role="listbox" aria-label="Agents" class="max-h-64 overflow-y-auto p-1">
      {!visible.length && <p role="status" class="px-3 py-3 text-[12px] text-[var(--color-text-muted)]">{agents.length ? 'Không có agent phù hợp.' : 'Đang tải agents…'}</p>}
      {visible.map((agent, i) => <button key={agent.id} id={`${listId}-${i}`} role="option" aria-selected={i === active} type="button"
        ref={el => { if (el && i === active) el.scrollIntoView({ block: 'nearest' }); }}
        onMouseDown={event => event.preventDefault()} onClick={() => choose(agent)}
        class={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[12px] ${i === active ? 'bg-[var(--color-control-hover)]' : 'hover:bg-[var(--color-control-hover)]'}`}>
        <AgentAvatar agentId={agent.id} name={agent.name} size={26} running={agent.running} />
        <span class="flex-1 min-w-0">
          <span class="flex items-center gap-1.5"><span class="font-medium text-[var(--color-text)] truncate">{displayName(agent.name, agent.id)}</span></span>
          {agent.description && <span class="block truncate text-[11px] text-[var(--color-text-muted)]">{agent.description}</span>}
        </span>
        <span class="inline-flex shrink-0 items-center gap-1 text-[10px] text-[var(--color-text-muted)]"><StatusDot tone={agent.running ? 'done' : 'cancelled'} />{agent.running ? 'Online' : 'Offline'}</span>
      </button>)}
    </div>
  </div> : null;
  return { picker, open, syncCaret, onKeyDown, inputProps: {
    'aria-autocomplete': 'list' as const,
    'aria-controls': open ? listId : undefined,
    'aria-activedescendant': open && visible.length ? `${listId}-${active}` : undefined,
  } };
}
