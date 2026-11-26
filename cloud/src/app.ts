/** Builds the Hono app. The platform `Env` arrives as Hono bindings (see src/index.ts and tests). */
import { Hono } from 'hono';
import type { AppEnv } from './app-types';
import { requireAdmin, requireSession } from './http/auth';
import { notFoundHandler, onError } from './http/errors';
import { adminPackRoutes } from './routes/admin-packs';
import { adminUserRoutes } from './routes/admin-users';
import { authRoutes } from './routes/auth';
import { devBlobRoutes } from './routes/dev-blobs';
import { meRoutes } from './routes/me';
import { packRoutes } from './routes/packs';

export function createApp() {
  const app = new Hono<AppEnv>();
  app.onError(onError);
  app.notFound(notFoundHandler);
  app.get('/health', (c) => c.json({ ok: true }));
  app.route('/auth', authRoutes);
  app.route('/me', meRoutes);
  app.route('/packs', packRoutes);

  const admin = new Hono<AppEnv>();
  admin.use('*', requireSession, requireAdmin);
  admin.route('/', adminUserRoutes);
  admin.route('/', adminPackRoutes);
  app.route('/admin', admin);

  app.route('/_dev/blobs', devBlobRoutes);
  return app;
}
