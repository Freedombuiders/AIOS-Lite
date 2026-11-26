import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { AppDeps } from '../core/deps.js';
import { errorBody, handleError } from './errors.js';
import { createOwnerAuth, ownerGate, ownerRoutes, type OwnerAuth } from './owner.js';
import { agentsRoutes } from './routes/agents.js';
import { brainRoutes } from './routes/brain.js';
import { chatRoutes } from './routes/chat.js';
import { connectionsRoutes } from './routes/connections.js';
import { costsRoutes } from './routes/costs.js';
import { mountIntegrationRoutes, RUN_TOKEN_PATHS } from './routes/integrations.js';
import { memoryRoutes } from './routes/memory.js';
import { miscRoutes } from './routes/misc.js';
import { modulesRoutes } from './routes/modules.js';
import { runsRoutes } from './routes/runs.js';
import { skillsAdminRoutes } from './routes/skills-admin.js';
import { schedulesRoutes } from './routes/schedules.js';
import { systemRoutes } from './routes/system.js';
import { teamsRoutes } from './routes/teams.js';
import { tasksRoutes } from './routes/tasks.js';
import { sseHandler } from './sse.js';

export interface ApiServerOptions {
  /** SSE keep-alive interval, ms (default 25 000) */
  pingMs?: number;
  /** directory with the built web app (default <root>/dist/web) */
  webDir?: string;
  /** owner sessions (default: built from deps; tests pass one with a print sink) */
  owner?: OwnerAuth;
}

export interface ApiServer {
  app: Hono;
  /** owner principal: pairing codes, sessions (src/api/owner.ts) */
  owner: OwnerAuth;
  listen(): Promise<{ close(): Promise<void>; port: number }>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
};

/** Reachable without AIOS_TOKEN: the MCP bridge (own per-run token) and owner pairing. */
const OPEN_PATHS: readonly string[] = [...RUN_TOKEN_PATHS, '/api/owner/status', '/api/owner/pair', '/api/owner/pair/request'];

const originsFrom = (raw: string | undefined): string[] => (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export function createApiServer(deps: AppDeps, opts: ApiServerOptions = {}): ApiServer {
  const app = new Hono();
  const token = deps.config.token;
  const owner = opts.owner ?? createOwnerAuth({ db: deps.db, token, allowedOrigins: originsFrom(process.env.AIOS_ALLOWED_ORIGINS) });
  const webDir = opts.webDir ?? path.join(deps.config.rootDir, 'dist', 'web');

  app.onError(handleError(deps.log));
  app.notFound((c) => c.json(errorBody('not_found', 'Không tìm thấy đường dẫn này.'), 404));

  // AIOS_TOKEN (when set) gates every route as before; a paired owner browser session passes it too.
  app.use('/api/*', async (c, next) => {
    if (token && !OPEN_PATHS.includes(c.req.path) && !owner.hasToken(c) && !owner.hasSession(c)) {
      return c.json(errorBody('unauthorized', 'Thiếu hoặc sai token (AIOS_TOKEN).'), 401);
    }
    await next();
  });
  // Owner routes (src/api/owner.ts OWNER_ROUTES) need the owner; no state change from another site.
  app.use('/api/*', ownerGate(owner));
  ownerRoutes(app, owner);

  app.get('/api/events', sseHandler(deps, opts.pingMs ?? 25_000));
  systemRoutes(app, deps);
  agentsRoutes(app, deps);
  connectionsRoutes(app, deps);
  costsRoutes(app, deps);
  mountIntegrationRoutes(app, deps);
  tasksRoutes(app, deps);
  runsRoutes(app, deps);
  schedulesRoutes(app, deps);
  chatRoutes(app, deps);
  brainRoutes(app, deps);
  memoryRoutes(app, deps);
  skillsAdminRoutes(app, deps);
  miscRoutes(app, deps);
  modulesRoutes(app, deps);
  teamsRoutes(app, deps);
  deps.modules.mount(app);

  // built web app with SPA fallback (only when it exists)
  app.get('*', (c) => {
    if (c.req.path.startsWith('/api/') || !fs.existsSync(path.join(webDir, 'index.html'))) {
      return c.json(errorBody('not_found', 'Không tìm thấy đường dẫn này.'), 404);
    }
    const rel = decodeURIComponent(c.req.path).replace(/^\/+/, '');
    const file = path.resolve(webDir, rel);
    const inside = file === webDir || file.startsWith(webDir + path.sep);
    const target = inside && rel && fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(webDir, 'index.html');
    const ext = path.extname(target).toLowerCase();
    const headers: Record<string, string> = { 'Content-Type': MIME[ext] ?? 'application/octet-stream' };
    if (target.includes(`${path.sep}assets${path.sep}`)) headers['Cache-Control'] = 'public, max-age=31536000, immutable';
    return new Response(new Uint8Array(fs.readFileSync(target)), { headers });
  });

  return {
    app,
    owner,
    listen() {
      return new Promise((resolve, reject) => {
        const server = serve({ fetch: app.fetch, hostname: deps.config.host, port: deps.config.port }, (info: AddressInfo) => {
          deps.log.info({ host: deps.config.host, port: info.port }, 'API listening');
          resolve({
            port: info.port,
            close: () =>
              new Promise<void>((done) => {
                const s = server as Server;
                s.closeAllConnections?.();
                s.close(() => done());
              }),
          });
        });
        server.on('error', reject);
      });
    },
  };
}
