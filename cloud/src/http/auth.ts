import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../app-types';
import { findActiveSession } from '../auth/session';
import { forbidden, unauthorized } from './errors';

/** Reads `Authorization: Bearer <token>`. A disabled user's sessions stop working on the next request. */
export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  const m = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '');
  if (!m) throw unauthorized();
  const found = await findActiveSession(c.env, m[1]);
  if (!found) throw unauthorized('Phiên đăng nhập không còn hiệu lực. Hãy đăng nhập lại.');
  c.set('auth', found);
  await next();
});

/** Use after requireSession. */
export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (c.var.auth.user.role !== 'admin') throw forbidden('Chỉ quản trị viên được làm việc này.');
  await next();
});
