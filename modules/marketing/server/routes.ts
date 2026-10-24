/**
 * Routes of the module, served at /api/m/marketing/*. Each workstream registers its own;
 * the contract (paths, bodies, DTOs) is in ./types.ts.
 */
import type { Hono } from 'hono';

import { registerAnalyticsRoutes } from './analytics/routes.js';
import { registerCommentRoutes } from './comments/routes.js';
import { registerCoreRoutes } from './core/routes.js';

export function registerFbStudioRoutes(app: Hono): void {
  registerCoreRoutes(app);
  registerCommentRoutes(app);
  registerAnalyticsRoutes(app);
}
