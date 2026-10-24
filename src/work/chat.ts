import { camelRow, nowIso, type DB } from '../core/db.js';
import type { EventBus } from '../core/events.js';
import type { Conversation, Message } from '../core/types.js';
import type { AgentRegistry } from '../agents/contracts.js';
import type { ChatService, TaskService } from './contracts.js';

export const DEFAULT_CHAT_TITLE = 'Cuộc trò chuyện mới';

export function createChatService({ db, bus, tasks, agents }: { db: DB; bus: EventBus; tasks: TaskService; agents: AgentRegistry }): ChatService {
  const conv = (id: number): Conversation | undefined => camelRow<Conversation>(db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Record<string, unknown> | undefined);
  const require_ = (id: number): Conversation => {
    const c = conv(id);
    if (!c) throw new Error(`Không tìm thấy cuộc trò chuyện #${id}`);
    return c;
  };

  return {
    listConversations(filter = {}) {
      const rows = filter.agentId
        ? db.prepare('SELECT * FROM conversations WHERE agent_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?').all(filter.agentId, filter.limit ?? 100)
        : db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC, id DESC LIMIT ?').all(filter.limit ?? 100);
      return (rows as Record<string, unknown>[]).map((r) => camelRow<Conversation>(r)!);
    },

    create({ agentId, title }) {
      if (!agents.get(agentId)) throw new Error(`Không tìm thấy agent "${agentId}"`);
      const now = nowIso();
      const info = db.prepare('INSERT INTO conversations (agent_id, title, created_at, updated_at) VALUES (?,?,?,?)').run(agentId, title?.trim() || DEFAULT_CHAT_TITLE, now, now);
      return require_(Number(info.lastInsertRowid));
    },

    get(id) {
      const conversation = conv(id);
      if (!conversation) return undefined;
      const messages = (db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id').all(id) as Record<string, unknown>[]).map((r) => camelRow<Message>(r)!);
      return { conversation, messages };
    },

    rename(id, title) {
      require_(id);
      if (!title.trim()) throw new Error('Tên cuộc trò chuyện không được để trống');
      db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(title.trim().slice(0, 120), nowIso(), id);
      return require_(id);
    },

    remove(id) {
      db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    },

    send(conversationId, content) {
      const c = require_(conversationId);
      if (!content.trim()) throw new Error('Tin nhắn không được để trống');
      const ts = nowIso();
      const first = (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(conversationId) as { n: number }).n === 0;
      const info = db.prepare("INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, 'user', ?, ?)").run(conversationId, content, ts);
      if (first && c.title === DEFAULT_CHAT_TITLE) {
        const line = content.trim().split(/\r?\n/)[0]!;
        db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(line.length > 60 ? line.slice(0, 59) + '…' : line, conversationId);
      }
      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(ts, conversationId);
      const task = tasks.create({ prompt: content, agentId: c.agentId, kind: 'chat', priority: 10, trigger: 'chat', source: 'chat', conversationId });
      db.prepare('UPDATE messages SET task_id = ? WHERE id = ?').run(task.id, info.lastInsertRowid);
      const message = camelRow<Message>(db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid) as Record<string, unknown>)!;
      bus.emit({ type: 'message', message });
      return { message, task };
    },
  };
}
