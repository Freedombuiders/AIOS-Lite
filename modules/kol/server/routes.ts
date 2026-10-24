/** HTTP API of KOL Studio (Marketing › KOL Studio). Contract: ./types.ts. */

import type { Hono } from 'hono';

import { registerPublishRoutes } from './publish-routes.js';
import { registerStudioRoutes } from './studio-routes.js';

export function registerKolRoutes(app: Hono): void {
  registerStudioRoutes(app);
  registerPublishRoutes(app);
}
