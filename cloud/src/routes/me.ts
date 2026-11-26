import { Hono } from 'hono';
import type { AppEnv } from '../app-types';
import { sessionJson, userJson, type SessionRow } from '../db/users';
import { requireSession } from '../http/auth';
import { notFound } from '../http/errors';
import { deleteAccount } from '../services/account';

export const meRoutes = new Hono<AppEnv>();

meRoutes.use('*', requireSession);

meRoutes.get('/', async (c) => {
  const { user, session } = c.var.auth;
  const { results } = await c.env.db.prepare(
    `SELECT id, user_id, kind, label, created_at, expires_at, revoked_at FROM sessions
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC`,
  ).bind(user.id, c.env.now()).all<SessionRow>();
  return c.json({ user: userJson(user), sessions: results.map((s) => sessionJson(s, session.id)) });
});

meRoutes.delete('/sessions/:id', async (c) => {
  const res = await c.env.db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
    .bind(c.env.now(), c.req.param('id'), c.var.auth.user.id).run();
  if (!res.meta.changes) throw notFound('Không tìm thấy phiên này.');
  return c.json({ ok: true });
});

meRoutes.delete('/', async (c) => {
  await deleteAccount(c.env, c.var.auth.user);
  return c.json({ ok: true });
});
