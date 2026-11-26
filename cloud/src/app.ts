/** Builds the Hono app. The platform `Env` arrives as Hono bindings (see src/index.ts and tests). */
import { Hono } from 'hono';
import type { AppEnv } from './app-types';
import { notFoundHandler, onError } from './http/errors';
import { adminUserRoutes } from './routes/admin-users';
import { authRoutes } from './routes/auth';
import { meRoutes } from './routes/me';

export function createApp() {
  const app = new Hono<AppEnv>();
  app.onError(onError);
  app.notFound(notFoundHandler);
  app.get('/health', (c) => c.json({ ok: true }));
  app.route('/auth', authRoutes);
  app.route('/me', meRoutes);
  app.route('/admin', adminUserRoutes);
  return app;
}
