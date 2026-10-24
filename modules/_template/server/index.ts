import { defineModule } from '../../../src/modules/sdk.js';

interface NoteRow {
  id: number;
  text: string;
  answer: string | null;
  task_id: number | null;
  created_at: string;
}

export default defineModule({
  // Route nằm dưới /api/m/<id>/... và chỉ phục vụ khi module đã được Add.
  routes(app, ctx) {
    app.get('/hello', (c) => c.json({ message: ctx.settings.get<string>('greeting', 'Xin chào!'), module: ctx.id }));

    app.get('/notes', (c) => c.json({ items: ctx.db.prepare('SELECT * FROM template_notes ORDER BY id DESC LIMIT 50').all() }));

    // Nhờ agent trả lời bằng một lượt "lean" đi qua Engine (có phân quyền, ghi lượt chạy, tính chi phí).
    app.post('/ask', async (c) => {
      const { text, agentId } = (await c.req.json()) as { text?: string; agentId?: string };
      if (!text?.trim()) return c.json({ error: { code: 'bad_request', message: 'Thiếu nội dung câu hỏi.' } }, 400);
      const agent = agentId ?? ctx.agents.list().find((a) => a.access.modules[ctx.id]?.includes('notes.write'))?.id ?? 'main';
      if (agentId && !ctx.access.can(agent, 'notes.write')) {
        return c.json({ error: { code: 'forbidden', message: `Agent "${agent}" chưa được cấp quyền notes.write.` } }, 403);
      }
      const result = await ctx.agents.runLean({
        agentId: agent,
        title: 'Trả lời ghi chú',
        prompt: `Trả lời ngắn gọn bằng tiếng Việt: ${text}`,
        moduleContext: `Số ghi chú hiện có: ${(ctx.db.prepare('SELECT COUNT(*) AS n FROM template_notes').get() as { n: number }).n}`,
        timeoutMs: 120_000,
      });
      const clean = ctx.outbound.sanitize(result.output);
      const info = ctx.db.prepare('INSERT INTO template_notes (text, answer, task_id) VALUES (?, ?, ?)').run(text, clean, result.taskId);
      ctx.events.emit('note-added', { id: Number(info.lastInsertRowid) });
      return c.json({ ok: result.ok, answer: clean, taskId: result.taskId, error: result.error }, result.ok ? 200 : 502);
    });
  },

  // Chạy khi Add và khi khởi động nếu module đang bật. Mọi timer tạo qua ctx.schedule tự dừng khi Remove.
  start(ctx) {
    ctx.schedule.every('heartbeat', 60_000, () => {
      if (!ctx.settings.get<boolean>('heartbeat', false)) return;
      ctx.log.info('nhịp định kỳ của module');
    });
  },

  // Gọi cho mỗi task kết thúc có source = 'module:<id>' (ví dụ lượt runLean ở trên).
  onTaskFinished(task, _run, ctx) {
    ctx.audit.log('note.task_finished', String(task.id), { status: task.status });
  },

  // Thêm dữ liệu của module vào prompt của lượt lean (đã lọc theo quyền).
  contextFor(_task, ctx) {
    const rows = ctx.db.prepare('SELECT text FROM template_notes ORDER BY id DESC LIMIT 3').all() as Pick<NoteRow, 'text'>[];
    return rows.length ? `Ghi chú gần đây:\n${rows.map((r) => `- ${r.text}`).join('\n')}` : '';
  },

  // Dịch vụ cho module khác dùng qua ctx.modules.get('<id>').
  provides: (ctx) => ({
    addNote(text: string): number {
      return Number(ctx.db.prepare('INSERT INTO template_notes (text) VALUES (?)').run(text).lastInsertRowid);
    },
  }),
});
