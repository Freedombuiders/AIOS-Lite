// Translates AIOS-Lite SSE events into the (eventName, data) vocabulary the copied chat components use:
// user_message, assistant_message, assistant_delta, progress, processing, error.
import { computed } from '@preact/signals';
import type { AppEvent } from './events';
import { sseConnected, subscribeEvents } from './sse';

type Listener = (eventName: string, data: any) => void;

export const chatStreamConnected = computed(() => sseConnected.value);

/** taskId → conversation scope, learned from task events (run events only carry the task id). */
const scopeOfTask = new Map<number, { scope: string; agentId: string }>();
/** scope → running chat task id. */
const runningTask = new Map<string, number>();

function trackTask(e: Extract<AppEvent, { type: 'task' }>): void {
  const t = e.task;
  if (t.conversationId === null) return;
  const scope = String(t.conversationId);
  scopeOfTask.set(t.id, { scope, agentId: t.agentId });
  if (t.status === 'queued' || t.status === 'running') runningTask.set(scope, t.id);
  else if (runningTask.get(scope) === t.id) runningTask.delete(scope);
}

subscribeEvents((e) => {
  if (e.type === 'task') trackTask(e);
});

export function subscribeChatStream(fn: Listener): () => void {
  return subscribeEvents((e) => {
    if (e.type === 'message') {
      const m = e.message;
      if (m.role === 'user') fn('user_message', { chatId: String(m.conversationId), content: m.content, source: 'dashboard' });
      else if (m.role === 'agent') {
        const owner = m.taskId !== null ? scopeOfTask.get(m.taskId) : undefined;
        fn('assistant_message', { chatId: String(m.conversationId), content: m.content, agentId: owner?.agentId, source: 'dashboard' });
      }
    } else if (e.type === 'run-event') {
      const owner = scopeOfTask.get(e.taskId);
      if (!owner) return;
      const base = { chatId: owner.scope, agentId: owner.agentId };
      const ev = e.event;
      if (ev.type === 'text') fn('assistant_delta', { ...base, content: ev.text });
      else if (ev.type === 'tool') fn('progress', { ...base, description: ev.name, kind: 'tool', status: ev.status === 'end' ? 'completed' : ev.status === 'error' ? 'failed' : 'in_progress', toolCallId: `${e.runId}:${ev.name}` });
      else if (ev.type === 'status') fn('progress', { ...base, description: ev.message });
    } else if (e.type === 'task') {
      const owner = scopeOfTask.get(e.task.id);
      if (!owner) return;
      const base = { chatId: owner.scope, agentId: owner.agentId };
      if (e.task.status === 'running') fn('processing', { ...base, processing: true });
      else if (e.task.status === 'failed' || e.task.status === 'cancelled') {
        fn('processing', { ...base, processing: false });
        if (e.task.status === 'failed') fn('error', { ...base, content: e.task.error ?? 'Agent không trả lời được.' });
      }
    }
  });
}

export function isChatScopeProcessing(scope: string | undefined): boolean {
  return scope !== undefined && runningTask.has(scope);
}

/** The running chat task of a conversation, for the Stop button. */
export function runningChatTask(scope: string | undefined): number | undefined {
  return scope === undefined ? undefined : runningTask.get(scope);
}

export function resetUnread(): void {
  /* the lite shell has no unread counter */
}
