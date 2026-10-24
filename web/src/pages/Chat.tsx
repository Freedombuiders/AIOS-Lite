// Chat page: conversation list (conversation-* classes) + ChatThread parts on the owner's chat surface (chat-v2.css, main.css).
import { Hand, MessageSquarePlus, Pencil, Send, Square, Trash2 } from 'lucide-preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Link, useLocation } from 'wouter-preact';
import type { Task } from '@core/types';
import { Bubble, ChatEmptyState, ProcessingTurn, useChatSession, useStickToBottom, agentNameOf } from '@/components/ChatThread';
import { ConfirmModal } from '@/components/ConfirmModal';
import { Modal } from '@/components/Modal';
import { StatusPill } from '@/components/TaskBits';
import { Field } from '@/components/ui';
import { errorText } from '@/lib/api';
import { useAgents } from '@/lib/agents';
import { activeConversation, conversations, createConversation, deleteConversation, refreshConversations, renameConversation, selectConversation } from '@/lib/chat-conversations';
import type { Conversation } from '@/lib/chat-conversations';
import { formatRelativeTime, resolveAgentName } from '@/lib/format';
import { pushToast } from '@/lib/toasts';
import { useFetch } from '@/lib/useFetch';

function Delegated({ taskId }: { taskId: number }) {
  const f = useFetch<{ items: Task[] }>(`/tasks?parentId=${taskId}`);
  const items = f.data?.items ?? [];
  if (!items.length) return null;
  return (
    <div class="chat-progress chat-progress-compact" style={{ marginTop: 6 }}>
      <div class="hint">Đã giao việc cho agent khác</div>
      {items.map((t) => (
        <Link key={t.id} href={`/tasks/${t.id}`} class="flex items-center gap-2 text-[12px] no-underline">
          <StatusPill status={t.status} /> <span class="truncate">{resolveAgentName(t.agentId)}: {t.title}</span>
        </Link>
      ))}
    </div>
  );
}

function Thread({ conversation, agents }: { conversation: Conversation; agents: { id: string; name: string }[] }) {
  const session = useChatSession(conversation.agentId, () => void refreshConversations().catch(() => undefined));
  const [text, setText] = useState('');
  const stick = useStickToBottom([session.turns.length, session.live], conversation.id);
  const input = useRef<HTMLTextAreaElement>(null);
  const name = agentNameOf(agents, conversation.agentId) ?? resolveAgentName(conversation.agentId);

  async function submit(value = text) {
    if (!value.trim() || session.sending) return;
    if (await session.send(value)) setText('');
  }

  return (
    <div class="chat-surface flex h-full min-w-0 flex-1 flex-col">
      <div class="chat-toolbar flex items-center gap-3 border-b border-[var(--color-border)] px-6">
        <div class="min-w-0">
          <div class="truncate text-[14px] font-semibold">{conversation.title}</div>
          <div class="hint">với {name}</div>
        </div>
        {!session.streamConnected && <span class="hint ml-auto">Mất kết nối trực tiếp, đang thử lại…</span>}
      </div>
      <div ref={stick.ref} class="chat-messages min-h-0 flex-1 overflow-y-auto">
        {session.turns.length === 0 && !session.live && !session.loading && (
          <ChatEmptyState name={name} onPrompt={(p) => void submit(p)} disabled={session.sending} />
        )}
        <div class="mx-auto max-w-3xl">
          {session.turns.map((t, i) => (
            <div key={t.id ?? i}>
              <Bubble turn={t} agentName={name} />
              {t.role === 'assistant' && t.taskId ? <Delegated taskId={t.taskId} /> : null}
            </div>
          ))}
          {(session.processing || session.live) && <ProcessingTurn live={session.live} />}
          {session.error && <div class="chat-error" role="alert">{session.error}</div>}
        </div>
      </div>
      <div class="chat-composer-area">
        <div class="chat-composer-inner mx-auto max-w-3xl">
          <div class="chat-composer">
            <textarea
              ref={input}
              class="chat-input"
              rows={1}
              placeholder={`Nhắn cho ${name}…`}
              value={text}
              onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
            {session.processing ? (
              <button type="button" class="chat-send chat-stop" onClick={() => void session.abort()} aria-label="Dừng"><Square size={14} /></button>
            ) : (
              <button type="button" class="chat-send" disabled={!text.trim() || session.sending} onClick={() => void submit()} aria-label="Gửi"><Send size={15} /></button>
            )}
          </div>
          <div class="chat-composer-hint"><span>Enter để gửi, Shift + Enter xuống dòng</span><span>{conversation.updated_at ? `Cập nhật ${formatRelativeTime(conversation.updated_at * 1000 > 0 ? new Date(conversation.updated_at * 1000).toISOString() : null)}` : ''}</span></div>
        </div>
      </div>
    </div>
  );
}

export default function ChatPage({ conversationId }: { conversationId?: number }) {
  const [, nav] = useLocation();
  const { agents } = useAgents();
  const [creating, setCreating] = useState(false);
  const [agentId, setAgentId] = useState('');
  const [renaming, setRenaming] = useState<Conversation | null>(null);
  const [title, setTitle] = useState('');
  const [deleting, setDeleting] = useState<Conversation | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const enabled = agents.filter((a) => a.enabled);
  const list = conversations.value;
  const active = activeConversation.value;

  useEffect(() => {
    refreshConversations().then(() => setLoaded(true)).catch((e) => { setListError(errorText(e)); setLoaded(true); });
  }, []);

  // The URL decides which conversation is open.
  useEffect(() => {
    if (conversationId === undefined) return;
    const hit = list.find((c) => c.id === String(conversationId));
    if (hit && hit.id !== active?.id) selectConversation(hit);
  }, [conversationId, list]);

  async function create() {
    try {
      const c = await createConversation(agentId || enabled[0]?.id || 'main');
      setCreating(false);
      nav(`/chat/${c.id}`);
    } catch (e) {
      pushToast({ tone: 'error', title: 'Không tạo được cuộc trò chuyện', description: errorText(e) });
    }
  }
  async function rename() {
    if (!renaming || !title.trim()) return;
    try {
      await renameConversation(renaming.id, title);
      setRenaming(null);
    } catch (e) {
      pushToast({ tone: 'error', title: 'Không đổi được tên', description: errorText(e) });
    }
  }
  async function remove() {
    if (!deleting) return;
    try {
      await deleteConversation(deleting.id);
      if (String(conversationId) === deleting.id) nav('/chat');
      setDeleting(null);
    } catch (e) {
      pushToast({ tone: 'error', title: 'Không xoá được', description: errorText(e) });
    }
  }

  const shown = conversationId !== undefined ? list.find((c) => c.id === String(conversationId)) : active ?? undefined;

  return (
    <div class="conversation-surface flex h-full">
      <aside class="conversation-sidebar" aria-label="Danh sách trò chuyện">
        <div class="conversation-sidebar-top">
          <span class="conversation-sidebar-label"><span>Trò chuyện</span></span>
        </div>
        <button type="button" class="conversation-new" disabled={!enabled.length} onClick={() => { setAgentId(enabled[0]?.id ?? ''); setCreating(true); }}>
          <MessageSquarePlus size={15} /> <span class="conversation-new-label">Cuộc trò chuyện mới</span>
        </button>
        <div class="conversation-list">
          {listError && <div class="conversation-no-results">{listError}</div>}
          {loaded && !listError && list.length === 0 && <div class="conversation-no-results">Chưa có cuộc trò chuyện nào. Bấm “Cuộc trò chuyện mới” để hỏi một agent.</div>}
          {list.map((c) => (
            <div key={c.id} class={`conversation-row${shown?.id === c.id ? ' selected' : ''}`}>
              <Link href={`/chat/${c.id}`} class="conversation-item no-underline">
                <span class="conversation-item-icon"><Hand size={14} /></span>
                <span>
                  <span class="conversation-title">{c.title}</span>
                  <span class="conversation-date">{resolveAgentName(c.agentId)} · {formatRelativeTime(new Date(c.updated_at * 1000).toISOString())}</span>
                </span>
              </Link>
              <button type="button" class="conversation-icon-button" aria-label="Đổi tên" onClick={() => { setRenaming(c); setTitle(c.title); }}><Pencil size={13} /></button>
              <button type="button" class="conversation-icon-button conversation-row-delete" aria-label="Xoá" onClick={() => setDeleting(c)}><Trash2 size={13} /></button>
            </div>
          ))}
        </div>
      </aside>
      {shown ? <Thread key={shown.id} conversation={shown} agents={agents} /> : (
        <div class="chat-surface flex h-full min-w-0 flex-1 items-center justify-center">
          <ChatEmptyState name="các agent" onPrompt={() => { setAgentId(enabled[0]?.id ?? ''); setCreating(true); }} disabled={!enabled.length} />
        </div>
      )}

      <Modal open={creating} onClose={() => setCreating(false)} title="Cuộc trò chuyện mới" width={400} footer={<><button type="button" class="control-button" onClick={() => setCreating(false)}>Huỷ</button><button type="button" class="control-button control-accent" disabled={!enabled.length} onClick={() => void create()}>Bắt đầu</button></>}>
        <Field label="Nói chuyện với">
          <select class="field" value={agentId} onChange={(e) => setAgentId((e.target as HTMLSelectElement).value)}>{enabled.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
        </Field>
      </Modal>
      <Modal open={renaming !== null} onClose={() => setRenaming(null)} title="Đổi tên cuộc trò chuyện" width={400} footer={<><button type="button" class="control-button" onClick={() => setRenaming(null)}>Huỷ</button><button type="button" class="control-button control-accent" onClick={() => void rename()}>Lưu</button></>}>
        <input class="field" value={title} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} onKeyDown={(e) => { if (e.key === 'Enter') void rename(); }} />
      </Modal>
      <ConfirmModal open={deleting !== null} onClose={() => setDeleting(null)} onConfirm={() => void remove()} destructive title="Xoá cuộc trò chuyện?" body={deleting ? `“${deleting.title}” và toàn bộ tin nhắn sẽ bị xoá.` : ''} confirmLabel="Xoá" />
    </div>
  );
}
