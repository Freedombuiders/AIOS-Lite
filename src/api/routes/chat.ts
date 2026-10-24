import type { Hono } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../../core/deps.js';
import { badRequest } from '../errors.js';
import { body, found, intParam } from '../util.js';

export function chatRoutes(app: Hono, deps: AppDeps): void {
  const convo = (c: Parameters<typeof intParam>[0]) => found(deps.chat.get(intParam(c)), 'cuộc trò chuyện');

  app.get('/api/conversations', (c) => c.json({ items: deps.chat.listConversations({ agentId: c.req.query('agentId') || undefined }) }));
  app.post('/api/conversations', async (c) => {
    const input = await body(c, z.object({ agentId: z.string().min(1), title: z.string().max(200).optional() }));
    if (!deps.agents.get(input.agentId)) throw badRequest(`Không tìm thấy agent "${input.agentId}".`);
    return c.json(deps.chat.create(input), 201);
  });
  app.get('/api/conversations/:id', (c) => c.json(convo(c)));
  app.patch('/api/conversations/:id', async (c) => {
    const { conversation } = convo(c);
    const { title } = await body(c, z.object({ title: z.string().trim().min(1).max(200) }));
    return c.json(deps.chat.rename(conversation.id, title));
  });
  app.delete('/api/conversations/:id', (c) => {
    deps.chat.remove(convo(c).conversation.id);
    return c.json({ ok: true });
  });
  app.post('/api/conversations/:id/messages', async (c) => {
    const { conversation } = convo(c);
    const { content } = await body(c, z.object({ content: z.string().trim().min(1).max(100_000) }));
    return c.json(deps.chat.send(conversation.id, content), 201);
  });
}
