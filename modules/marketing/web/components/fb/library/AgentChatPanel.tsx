// Kho nội dung's agent chat. The conversation is a core conversation (shared with the Trò chuyện page);
// this panel only adds the context of the ticked rows and refreshes the list after each reply.
import { useEffect, useRef, useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { ArrowDown, Maximize2, Send, Sparkles, Square, X } from 'lucide-preact';
import { Bubble, ProcessingTurn, useChatSession, useStickToBottom } from '@/components/ChatThread';
import { StatusDot } from '@/components/Pill';
import { useFetch } from '@/lib/useFetch';
import { activeConversation, conversations, createConversation, refreshConversations, selectConversation } from '@/lib/chat-conversations';
import { FormatChip, StatusPill } from '@modules/marketing/web/components/fb/common';
import { composeAgentMessage } from '@modules/marketing/web/lib/agent-message';
import type { FbContentDto } from '@modules/marketing/web/lib/fbstudio';

interface AgentOption { id: string; name: string }

const SUGGESTIONS = [
  'Viết 5 caption cho tuần sau',
  'Biến bài đang chọn thành Reel',
  'Lên kế hoạch tuần từ insight',
  'Viết lại bài đang chọn theo giọng Page',
];

const ICON_BTN = 'p-1.5 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-control-hover)] transition-colors';

export function AgentChatPanel({ initialDraft = '', selected, onDeselect, onClearSelection, onReply, onClose }: {
  initialDraft?: string;
  selected: FbContentDto[];
  onDeselect: (id: number) => void;
  onClearSelection: () => void;
  /** Called after each assistant message so the Kho list picks up what the agent wrote. */
  onReply: () => void;
  onClose: () => void;
}) {
  const agents = useFetch<{ items: AgentOption[] }>('/api/agents', 60_000);
  const agentList = agents.data?.items ?? [];
  const [agentId, setAgentId] = useState('');
  // Default writer: the module's template agent when it exists, else main.
  useEffect(() => {
    if (agentId || agentList.length === 0) return;
    setAgentId(agentList.some((a) => a.id === 'content-fb') ? 'content-fb' : agentList.some((a) => a.id === 'main') ? 'main' : agentList[0].id);
  }, [agentList.length]);

  // One conversation per writer agent: reuse the latest, create it on first use.
  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    void (async () => {
      const list = await refreshConversations().catch(() => conversations.value);
      if (cancelled) return;
      if (activeConversation.value?.agentId === agentId) return;
      const mine = list.find((c) => c.agentId === agentId);
      if (mine) selectConversation(mine);
      else await createConversation(agentId);
    })();
    return () => { cancelled = true; };
  }, [agentId]);

  const { turns, loading, processing, progressLabel, live, error, streamConnected, sending, send, abort } = useChatSession(agentId || 'main', onReply);
  const { ref: messagesRef, atBottom, scrollToBottom } = useStickToBottom([turns.length, processing, live], agentId);

  const [draft, setDraft] = useState(initialDraft);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);

  async function submit(text: string) {
    const message = text.trim();
    if (!message || sending || !activeConversation.value) return;
    const ok = await send(composeAgentMessage(message, selected));
    if (ok && text === draft) setDraft('');
    if (ok) scrollToBottom(false);
  }

  const busy = processing || sending;
  const ready = !!activeConversation.value && activeConversation.value.agentId === agentId;
  const empty = !loading && turns.length === 0 && !error;

  return (
    <aside aria-label="Chat với agent" class="flex flex-col min-h-0 w-full md:w-[380px] md:shrink-0 bg-[var(--color-sidebar)] border-l border-[var(--color-border)]">
      <div class="shrink-0 flex items-center gap-2.5 px-3 py-2.5 border-b border-[var(--color-border)]">
        <span class="w-7 h-7 rounded-full bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)] inline-flex items-center justify-center shrink-0" aria-hidden="true">
          <Sparkles size={14} />
        </span>
        <div class="flex-1 min-w-0">
          <label class="flex items-center gap-1.5 min-w-0">
            <span class="sr-only">Agent</span>
            <select
              class="min-w-0 max-w-full bg-transparent border-0 outline-none p-0 text-[13px] font-semibold text-[var(--color-text)] cursor-pointer"
              value={agentId}
              onChange={(e) => setAgentId((e.currentTarget as HTMLSelectElement).value)}
            >
              {agentList.map((a) => <option key={a.id} value={a.id}>{a.name || a.id}</option>)}
            </select>
          </label>
          <div class="flex items-center gap-1.5 text-[11px] text-[var(--color-text-faint)] min-w-0">
            <StatusDot tone={streamConnected ? 'done' : 'cancelled'} />
            <span class="truncate">
              {processing ? (progressLabel || 'Agent đang làm…') : streamConnected ? 'Bài agent soạn nằm ở Kho, trạng thái Chờ duyệt' : 'Đang kết nối lại…'}
            </span>
          </div>
        </div>
        <Link href="/chat" title="Mở chat toàn màn hình" aria-label="Mở chat toàn màn hình" class={ICON_BTN}>
          <Maximize2 size={14} />
        </Link>
        <button type="button" onClick={onClose} title="Đóng" aria-label="Đóng khung chat" class={ICON_BTN}>
          <X size={15} />
        </button>
      </div>

      <div class="relative flex-1 min-h-0">
        <div ref={messagesRef} class="absolute inset-0 overflow-y-auto px-3 py-3 flex flex-col gap-2.5" role="log" aria-live="polite" aria-label="Cuộc trò chuyện với agent">
          {loading && turns.length === 0 && <div class="py-8 text-center text-[11.5px] text-[var(--color-text-faint)]">Đang tải cuộc trò chuyện…</div>}
          {error && <div class="text-[12px] text-[var(--color-status-failed)]">{error}</div>}
          {empty && (
            <div class="mt-auto flex flex-col gap-2">
              <div class="text-center text-[12px] text-[var(--color-text-faint)] mb-1">Bấm một gợi ý để gửi</div>
              {SUGGESTIONS.map((q) => (
                <button
                  key={q}
                  type="button"
                  disabled={busy || !ready}
                  onClick={() => void submit(q)}
                  class="w-full text-left px-3 py-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] text-[13px] text-[var(--color-text)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-elevated)] disabled:opacity-40 transition-colors"
                >
                  {q}
                </button>
              ))}
            </div>
          )}
          {turns.map((t, i) => <Bubble key={i} turn={t} compact />)}
          {processing && <ProcessingTurn live={live} compact />}
        </div>
        {!atBottom && (
          <button
            type="button"
            onClick={() => scrollToBottom()}
            aria-label="Xuống tin mới nhất"
            class="absolute bottom-2 left-1/2 -translate-x-1/2 h-7 px-3 inline-flex items-center gap-1 rounded-full border border-[var(--color-border-strong)] bg-[var(--color-elevated)] text-[11.5px] text-[var(--color-text)]"
          >
            <ArrowDown size={12} /> Tin mới nhất
          </button>
        )}
      </div>

      <div class="shrink-0 px-3 pt-2.5 pb-3 border-t border-[var(--color-border)] flex flex-col gap-2">
        {selected.length > 0 ? (
          <div class="flex flex-col gap-1">
            <div class="flex items-center gap-2 text-[11.5px] text-[var(--color-text-muted)]">
              <span class="inline-flex items-center h-6 px-2 rounded-md bg-[var(--color-accent-soft)] text-[var(--color-text)]">Ngữ cảnh: {selected.length} content</span>
              <button type="button" class="underline" onClick={onClearSelection}>Bỏ chọn hết</button>
            </div>
            <ul class="m-0 p-0 list-none flex flex-col gap-1 max-h-20 overflow-y-auto">
              {selected.map((c) => (
                <li key={c.id} class="flex items-center gap-2 text-[12px] min-w-0">
                  <FormatChip format={c.format} />
                  <span class="truncate min-w-0 flex-1">{c.title || '(chưa có tiêu đề)'}</span>
                  <StatusPill status={c.status} />
                  <button type="button" aria-label={`Bỏ chọn: ${c.title}`} class="shrink-0 p-0.5 rounded hover:bg-[var(--color-control-hover)]" onClick={() => onDeselect(c.id)}>
                    <X size={12} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div class="text-[11.5px] text-[var(--color-text-faint)]">Tick ô vuông ở bảng để đưa content vào ngữ cảnh.</div>
        )}

        <form
          class="flex gap-2 items-end px-2.5 py-2 rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-card)] focus-within:border-[var(--color-accent)]"
          onSubmit={(e) => { e.preventDefault(); void submit(draft); }}
        >
          <label class="flex-1 min-w-0">
            <span class="sr-only">Nhắn agent</span>
            <textarea
              ref={inputRef}
              rows={1}
              value={draft}
              placeholder="Nhắn agent… (Enter gửi, Shift+Enter xuống dòng)"
              class="w-full max-h-40 resize-none border-0 outline-none bg-transparent text-[13px] leading-normal text-[var(--color-text)] placeholder:text-[var(--color-text-faint)]"
              onInput={(e) => setDraft((e.currentTarget as HTMLTextAreaElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void submit(draft); }
              }}
            />
          </label>
          {processing && (
            <button type="button" aria-label="Dừng agent" title="Dừng agent" class={ICON_BTN} onClick={() => void abort()}>
              <Square size={14} />
            </button>
          )}
          <button
            type="submit"
            aria-label="Gửi"
            title="Gửi"
            disabled={!draft.trim() || sending || !ready}
            class="shrink-0 w-8 h-8 rounded-full inline-flex items-center justify-center bg-[var(--color-accent)] text-white disabled:opacity-40 transition-opacity"
          >
            <Send size={14} />
          </button>
        </form>
      </div>
    </aside>
  );
}
