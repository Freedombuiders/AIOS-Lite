import type { ComposerInput } from './MentionInput';
import type { RefObject } from 'preact';
import { useEffect, useId, useState } from 'preact/hooks';
import { Folder, Lock } from 'lucide-preact';
import { useFetch } from '@/lib/useFetch';

interface FolderItem { path: string; readOnly: boolean }
const normalize = (value: string) => value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');

export function useFolderPicker(draft: string, input: RefObject<ComposerInput | HTMLTextAreaElement>, select: (text: string) => void) {
  const [caret, setCaret] = useState(0);
  const [index, setIndex] = useState(0);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const listId = useId();
  const prefix = draft.slice(0, caret);
  const match = prefix.match(/(?:^|\s)@([^@\n\r\[\]]*)$/);
  const query = match?.[1];
  const start = match ? prefix.length - match[1].length - 1 : -1;
  const triggerKey = `${caret}:${draft}`;
  const open = query !== undefined && dismissedKey !== triggerKey;
  const { data, error, loading } = useFetch<{ items: { id: string; name: string }[] }>(open ? '/brain/folders' : null);
  const matches = (error ? [] : (data?.items ?? []).map((f): FolderItem => ({ path: f.id, readOnly: false }))).filter(f => normalize(f.path).includes(normalize(query ?? '')));
  const visible = matches.slice(0, 60);
  const active = Math.min(index, Math.max(0, visible.length - 1));
  useEffect(() => { setIndex(0); }, [query, start]);

  function syncCaret() { setCaret(input.current?.selectionStart ?? draft.length); }
  function choose(folder: FolderItem) {
    const token = `@[${folder.path}] `;
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
    <div class="px-3 py-2 text-[11px] text-[var(--color-text-muted)] flex items-center gap-2"><Folder size={14} />Second Brain · ↑↓ chọn · Enter/Tab dùng · Esc đóng</div>
    <div id={listId} role="listbox" aria-label="Thư mục second brain" class="max-h-64 overflow-y-auto p-1">
      {!visible.length && <p role="status" class="px-3 py-3 text-[12px] text-[var(--color-text-muted)]">{error ? 'Không tải được thư mục. Kiểm tra kết nối vault và quyền của agent.' : loading ? 'Đang tải thư mục…' : 'Không có thư mục phù hợp trong phạm vi được đọc.'}</p>}
      {visible.map((folder, i) => <button key={folder.path} id={`${listId}-${i}`} role="option" aria-selected={i === active} type="button"
        ref={el => { if (el && i === active) el.scrollIntoView({ block: 'nearest' }); }}
        onMouseDown={event => event.preventDefault()} onClick={() => choose(folder)}
        class={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[12px] ${i === active ? 'bg-[var(--color-control-hover)]' : 'hover:bg-[var(--color-control-hover)]'}`}>
        <Folder size={15} class="shrink-0 text-[var(--color-accent)]" /><span class="flex-1 min-w-0 break-words">{folder.path}</span>
        {folder.readOnly && <span class="inline-flex shrink-0 items-center gap-1 text-[10px] text-[var(--color-text-muted)]"><Lock size={10} />Chỉ đọc</span>}
      </button>)}
    </div>
    {matches.length > 60 && <p class="px-3 py-2 text-[10px] text-[var(--color-text-muted)]">Danh sách được giới hạn. Gõ thêm tên hoặc đường dẫn để lọc.</p>}
  </div> : null;
  return { picker, syncCaret, onKeyDown, inputProps: {
    'aria-autocomplete': 'list' as const,
    'aria-controls': open ? listId : undefined,
    'aria-activedescendant': open && visible.length ? `${listId}-${active}` : undefined,
  } };
}
