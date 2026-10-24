// Chat state hook and message views shared by the Trò chuyện page and embedded chat panels.
// Data comes from /api/conversations; live updates arrive through lib/chat-stream.ts.
import { ArrowUpRight, Sparkles } from 'lucide-preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { Message } from '@core/types';
import { AgentAvatar } from '@/components/AgentAvatar';
import { LiveTurnView, ReplyWithActivity } from '@/components/ChatActivity';
import type { PickerAgent } from '@/components/AgentPicker';
import { mentionParts } from '@/components/MentionInput';
import type { PickerSkill } from '@/components/SkillPicker';
import { ApiError, apiGet, apiPost } from '@/lib/api';
import { liveProgress, liveText, normalizeActivity, startLiveTurn } from '@/lib/chat-activity';
import type { LiveTurn, TurnActivity } from '@/lib/chat-activity';
import { activeConversation } from '@/lib/chat-conversations';
import { chatStreamConnected, isChatScopeProcessing, resetUnread, runningChatTask, subscribeChatStream } from '@/lib/chat-stream';
import { sendErrorText } from '@/lib/chat-v2';
import type { Attachment } from '@/lib/chat-v2';
import type { ScreenContextPayload } from '@/lib/page-context';

/** Replies without an agent id belong to the workspace's main agent. */
const MAIN_AGENT = 'main';

export interface Turn {
  id?: number;
  taskId?: number | null;
  role: 'user' | 'assistant';
  content: string;
  source?: string;
  /** Epoch seconds or milliseconds. */
  created_at?: number;
  agent_id?: string;
  photoUrl?: string;
  photoCaption?: string;
  activity?: TurnActivity;
  /** File names sent with the message (browser side only). */
  attachments?: string[];
}

export interface ProgressItem {
  id: string;
  timestamp: number;
  description: string;
  status?: string;
  kind?: string;
  progressKind?: string;
  toolCallId?: string;
  planEntries?: { content: string; status: string; priority?: string }[];
  locations?: { path: string; line?: number | null }[];
}

export const QUICK_ACTIONS = [
  { label: 'Cập nhật tình hình', prompt: 'Cho mình cập nhật nhanh: bạn đang làm việc gì?' },
  { label: 'Việc tiếp theo', prompt: 'Dựa trên ngữ cảnh hiện có, mình nên tập trung vào việc gì tiếp theo?' },
  { label: 'Kế hoạch hôm nay', prompt: 'Hôm nay có những việc gì? Việc nào cần ưu tiên?' },
  { label: 'Kết quả gần đây', prompt: 'Trong 24 giờ qua đã hoàn thành được những gì?' },
];

const MAX_PROGRESS_ITEMS = 8;

/** Fold one progress event into the visible list: same id updates in place, the list keeps the newest few. */
function foldProgress(list: ProgressItem[], data: any): ProgressItem[] {
  const timestamp: number = data.timestamp || Date.now();
  const id: string = data.toolCallId ? `tool:${data.toolCallId}` : data.progressKind === 'plan' ? 'plan' : `progress:${timestamp}:${data.description}`;
  const item: ProgressItem = {
    id, timestamp, description: data.description, status: data.status, kind: data.kind,
    progressKind: data.progressKind, toolCallId: data.toolCallId, planEntries: data.planEntries, locations: data.locations,
  };
  const rest = list.filter((p) => p.id !== id);
  const old = list.find((p) => p.id === id);
  const merged = old ? list.map((p) => (p.id === id ? { ...p, ...item } : p)) : [...rest, item];
  return merged.slice(-MAX_PROGRESS_ITEMS);
}

function turnsFrom(messages: Message[], agentId: string): Turn[] {
  return messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      id: m.id,
      taskId: m.taskId,
      role: m.role === 'user' ? ('user' as const) : ('assistant' as const),
      content: m.content,
      created_at: Date.parse(m.createdAt),
      agent_id: m.role === 'agent' ? agentId : undefined,
    }));
}

/**
 * Chat state for one conversation: history, streamed reply, progress, send and stop.
 * `onReply` runs after every assistant message so the page can refresh its list.
 * Conversations are short, so history loads in one piece (hasOlder is always false).
 */
export function useChatSession(activeAgent: string, onReply?: () => void) {
  const conversation = activeConversation.value;
  const conversationId = conversation?.id;
  const scope = conversation?.scope_chat_id;

  const [turns, setTurns] = useState<Turn[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(() => isChatScopeProcessing(scope));
  const [live, setLive] = useState<LiveTurn | null>(() => (isChatScopeProcessing(scope) ? startLiveTurn() : null));
  const [progressItems, setProgressItems] = useState<ProgressItem[]>([]);
  const [progressLabel, setProgressLabel] = useState<string | null>(null);
  const [progressAgent, setProgressAgent] = useState(MAIN_AGENT);
  const loadVersion = useRef(0);
  const pendingFiles = useRef<{ text: string; names: string[] } | null>(null);
  const onReplyRef = useRef(onReply);
  onReplyRef.current = onReply;

  const clearProgress = () => {
    setProgressItems([]);
    setProgressLabel(null);
    setLive(null);
  };

  const refreshHistory = useCallback(async () => {
    const version = ++loadVersion.current;
    if (!conversationId) {
      setTurns([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const d = await apiGet<{ messages: Message[] }>(`/conversations/${encodeURIComponent(conversationId)}`);
      if (version === loadVersion.current) setTurns(turnsFrom(d.messages, activeAgent));
    } catch (e: any) {
      if (version === loadVersion.current) setError(e?.message || String(e));
    } finally {
      if (version === loadVersion.current) setLoading(false);
    }
  }, [conversationId, activeAgent]);

  // Reset and reload whenever the open conversation changes.
  useEffect(() => {
    setTurns([]);
    setError(null);
    setProgressItems([]);
    setProgressLabel(null);
    const busy = isChatScopeProcessing(scope);
    setProcessing(busy);
    setLive(busy ? startLiveTurn() : null);
    void refreshHistory();
    return () => {
      loadVersion.current++;
    };
  }, [refreshHistory, scope]);

  // A reconnect can leave a gap: reload history on every connect after the first.
  const streamConnected = chatStreamConnected.value;
  const seenConnected = useRef(false);
  useEffect(() => {
    if (!streamConnected) return;
    if (seenConnected.current) void refreshHistory();
    seenConnected.current = true;
  }, [streamConnected]);

  useEffect(() => {
    resetUnread();
    return subscribeChatStream((name, data) => {
      if (scope && data.chatId !== scope) return;
      if (activeAgent !== 'all' && data.agentId && data.agentId !== activeAgent) return;
      switch (name) {
        case 'history_cleared':
          setTurns([]);
          clearProgress();
          void refreshHistory();
          onReplyRef.current?.();
          break;
        case 'user_message': {
          const pending = pendingFiles.current;
          const names = pending && pending.text === data.content ? pending.names : undefined;
          if (names) pendingFiles.current = null;
          setTurns((prev) => [...prev, { role: 'user', content: data.content, source: data.source, ...(names ? { attachments: names } : {}) }]);
          break;
        }
        case 'assistant_delta':
          if (typeof data.content === 'string') setLive((prev) => liveText(prev ?? startLiveTurn(), data.content));
          break;
        case 'assistant_message':
          setTurns((prev) => [...prev, { role: 'assistant', content: data.content, source: data.source, agent_id: data.agentId || MAIN_AGENT, activity: normalizeActivity(data.activity) }]);
          setProcessing(false);
          clearProgress();
          onReplyRef.current?.();
          break;
        case 'assistant_photo':
          setTurns((prev) => [...prev, { role: 'assistant', content: '', source: data.source, agent_id: data.agentId || MAIN_AGENT, photoUrl: data.url, photoCaption: data.caption }]);
          break;
        case 'processing':
          if (data.processing !== undefined) setProcessing(!!data.processing);
          if (data.processing) setLive((prev) => prev ?? startLiveTurn());
          else clearProgress();
          setProgressAgent(MAIN_AGENT);
          break;
        case 'progress':
          if (!data.description) break;
          setProgressAgent(data.agentId || MAIN_AGENT);
          setProgressLabel(data.description);
          setProgressItems((prev) => foldProgress(prev, data));
          setLive((prev) => liveProgress(prev ?? startLiveTurn(Date.now(), data.agentId), {
            description: data.description, progressKind: data.progressKind, status: data.status, kind: data.kind, toolCallId: data.toolCallId,
          }));
          break;
        case 'error':
          setTurns((prev) => [...prev, { role: 'assistant', content: data.content || 'Lỗi' }]);
          setProcessing(false);
          clearProgress();
          break;
      }
    });
  }, [activeAgent, scope, refreshHistory]);

  /** True when the server accepted the message (the caller clears its draft); the reply streams in afterwards.
   *  `screen` and `attachments` are accepted for call-site compatibility: attachments are only remembered by name. */
  async function send(text: string, _screen?: ScreenContextPayload, attachments?: Attachment[]): Promise<boolean> {
    const content = text.trim();
    if (!content) return false;
    setSending(true);
    setError(null);
    clearProgress();
    pendingFiles.current = attachments?.length ? { text: content, names: attachments.map((a) => a.name) } : null;
    try {
      if (!conversationId) throw new Error('Chưa chọn cuộc trò chuyện.');
      await apiPost(`/conversations/${encodeURIComponent(conversationId)}/messages`, { content });
      return activeConversation.value?.id === conversationId;
    } catch (err: any) {
      pendingFiles.current = null;
      if (activeConversation.value?.id === conversationId) setError(err instanceof ApiError ? sendErrorText(err.body, err.message) : err?.message || String(err));
      return false;
    } finally {
      setSending(false);
    }
  }

  async function abort(): Promise<void> {
    const taskId = runningChatTask(scope);
    if (taskId === undefined) return;
    try {
      await apiPost(`/tasks/${taskId}/cancel`);
    } catch {
      /* the task already finished */
    }
  }

  async function loadOlder(): Promise<void> {
    /* nothing older: history is loaded whole */
  }

  return {
    refreshHistory, turns, loading, hasOlder: false, loadingOlder: false, loadOlder, sending, processing,
    progressLabel, progressItems, progressAgent, live, error, streamConnected, send, abort,
  };
}

/** Keeps a scroll box pinned to the bottom while the reader is near it; exposes a jump-to-latest helper. */
export function useStickToBottom(deps: unknown[], resetKey: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);

  const scrollToBottom = (smooth = true) => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  };

  useEffect(() => {
    const el = ref.current;
    if (atBottom && el) el.scrollTop = el.scrollHeight;
  }, [...deps, atBottom]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
    el.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener('scroll', onScroll);
  }, [resetKey]);

  return { ref, atBottom, scrollToBottom };
}

export function ChatEmptyState({ name = 'các agent', compact = false, onPrompt, disabled = false }: { name?: string; compact?: boolean; onPrompt: (prompt: string) => void; disabled?: boolean }) {
  return (
    <div class={`chat-empty${compact ? ' chat-empty-compact' : ''}`}>
      <div class="chat-empty-icon"><Sparkles size={compact ? 24 : 30} /></div>
      <span class="chat-eyebrow">KHÔNG GIAN LÀM VIỆC AI</span>
      <h2>Hỏi bất cứ điều gì.</h2>
      <p>Bắt đầu trò chuyện với {name}: biến ý tưởng thành kế hoạch, hỏi tình hình hoặc quyết định việc tiếp theo.</p>
      <div class="chat-starters">
        {QUICK_ACTIONS.map((a) => (
          <button key={a.label} type="button" disabled={disabled} onClick={() => onPrompt(a.prompt)}>
            <span>{a.label}</span>
            <ArrowUpRight size={15} />
          </button>
        ))}
      </div>
    </div>
  );
}

/** Name of an agent from a list; falls back to the main agent's entry when no id is given. */
export function agentNameOf(agents: Array<{ id: string; name?: string }> | undefined, agentId?: string): string | undefined {
  const wanted = agentId || MAIN_AGENT;
  return agents?.find((a) => a.id === wanted)?.name || undefined;
}

function clockOf(turn: Turn): { iso: string; label: string } | null {
  if (!turn.created_at) return null;
  const at = new Date(turn.created_at < 1e12 ? turn.created_at * 1000 : turn.created_at);
  return { iso: at.toISOString(), label: at.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) };
}

function Content({ turn, agents, skills }: { turn: Turn; agents: PickerAgent[]; skills: PickerSkill[] }) {
  if (turn.photoUrl) {
    return (
      <div class="chat-message-content chat-message-photo">
        <img src={turn.photoUrl} alt={turn.photoCaption || 'Ảnh đính kèm'} loading="lazy" />
        {turn.photoCaption && <div class="chat-photo-caption">{turn.photoCaption}</div>}
      </div>
    );
  }
  if (turn.role === 'assistant') return <ReplyWithActivity content={turn.content} activity={turn.activity} />;
  return (
    <>
      <div class="chat-message-content">
        {mentionParts(turn.content, agents, skills).map((part, i) =>
          part.label ? <span key={i} class={`chat-mention-tag chat-mention-${part.kind}`} title={part.title}>{part.label}</span> : <span key={i}>{part.text}</span>,
        )}
      </div>
      {turn.attachments?.length ? <div class="chat-photo-caption">Đính kèm: {turn.attachments.join(', ')}</div> : null}
    </>
  );
}

export function Bubble({ turn, compact = false, agentName, agents = [], skills = [] }: { turn: Turn; compact?: boolean; agentName?: string; agents?: PickerAgent[]; skills?: PickerSkill[] }) {
  const mine = turn.role === 'user';
  const agentId = turn.agent_id || MAIN_AGENT;
  const clock = clockOf(turn);
  const side = mine ? 'chat-message-user' : 'chat-message-agent';

  if (compact) {
    // Dock layout: no avatar row, the reply runs full width; only non-main agents get a label.
    return (
      <div class={`chat-message chat-message-compact chat-message-flat ${side}`} title={clock?.label}>
        <div class="chat-message-body">
          {!mine && agentId !== MAIN_AGENT && (
            <div class="chat-message-meta"><AgentAvatar agentId={agentId} name={agentName} size={16} /><span>{agentName || agentId}</span></div>
          )}
          <Content turn={turn} agents={agents} skills={skills} />
        </div>
      </div>
    );
  }
  return (
    <div class={`chat-message ${side}`}>
      {!mine && <span class="chat-message-agent-avatar" aria-hidden="true"><AgentAvatar agentId={agentId} name={agentName} size={32} /></span>}
      <div class="chat-message-body">
        <div class="chat-message-meta">
          {!mine && <span>{agentName || 'Agent'}</span>}
          {clock && <time dateTime={clock.iso}>{clock.label}</time>}
        </div>
        <Content turn={turn} agents={agents} skills={skills} />
      </div>
    </div>
  );
}

/** The reply being written right now. */
export function ProcessingTurn({ live, compact = false }: { live: LiveTurn | null; compact?: boolean }) {
  const fallback = useRef<LiveTurn | null>(null);
  if (!live && !fallback.current) fallback.current = startLiveTurn();
  return <LiveTurnView turn={live ?? fallback.current!} compact={compact} />;
}
