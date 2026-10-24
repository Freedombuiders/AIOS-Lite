// Conversation list shared by the chat page and the dock, backed by /api/conversations.
import { signal } from '@preact/signals';
import type { Conversation as ApiConversation } from '@core/types';
import { apiDelete, apiGet, apiPatch, apiPost } from './api';
import { subscribeEvents } from './sse';

export interface Conversation {
  id: string;
  /** Same as id: the chat stream filters events by it. */
  scope_chat_id: string;
  agentId: string;
  title: string;
  legacy: number;
  /** Epoch seconds. */
  updated_at: number;
  title_source?: 'default' | 'summary' | 'user';
}

export const activeConversation = signal<Conversation | null>(null);
export const conversations = signal<Conversation[]>([]);

const REMEMBER_KEY = 'aios.conversation';

function fromApi(c: ApiConversation): Conversation {
  return { id: String(c.id), scope_chat_id: String(c.id), agentId: c.agentId, title: c.title, legacy: 0, updated_at: Math.floor(Date.parse(c.updatedAt) / 1000) };
}

export function selectConversation(conversation: Conversation): void {
  activeConversation.value = conversation;
  try {
    sessionStorage.setItem(REMEMBER_KEY, conversation.id);
  } catch {
    /* storage blocked */
  }
}

export function rememberedConversationId(): string | null {
  try {
    return sessionStorage.getItem(REMEMBER_KEY);
  } catch {
    return null;
  }
}

let latestRequest = 0;

/** Reload the list and keep the active conversation in sync. */
export async function refreshConversations(): Promise<Conversation[]> {
  const mine = ++latestRequest;
  const res = await apiGet<{ items: ApiConversation[] }>('/conversations');
  if (mine !== latestRequest) return conversations.value;
  const list = (res.items ?? []).map(fromApi);
  conversations.value = list;
  const active = activeConversation.value;
  const fresh = active ? list.find((c) => c.id === active.id) : undefined;
  if (fresh) activeConversation.value = fresh;
  else {
    const pick = list.find((c) => c.id === rememberedConversationId()) ?? list[0];
    if (pick) selectConversation(pick);
    else activeConversation.value = null;
  }
  return list;
}

export async function createConversation(agentId = 'main'): Promise<Conversation> {
  const made = fromApi(await apiPost<ApiConversation>('/conversations', { agentId }));
  selectConversation(made);
  await refreshConversations();
  return made;
}

export async function renameConversation(id: string, title: string): Promise<void> {
  await apiPatch(`/conversations/${encodeURIComponent(id)}`, { title: title.trim() });
  await refreshConversations();
}

/** AIOS-Lite has no auto-title endpoint; the stored title is returned unchanged. */
export async function autoNameConversation(id: string): Promise<Conversation> {
  const found = conversations.value.find((c) => c.id === id);
  if (!found) throw new Error('Không tìm thấy cuộc trò chuyện');
  return found;
}

export async function deleteConversation(id: string): Promise<void> {
  await apiDelete(`/conversations/${encodeURIComponent(id)}`);
  if (activeConversation.value?.id === id) activeConversation.value = null;
  await refreshConversations();
}

// A new message moves its conversation to the top.
subscribeEvents((e) => {
  if (e.type !== 'message') return;
  const id = String(e.message.conversationId);
  if (!conversations.value.some((c) => c.id === id)) void refreshConversations().catch(() => undefined);
});
