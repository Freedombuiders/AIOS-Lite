import type { Hono } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../../core/deps.js';
import { setEnvKey } from '../../core/env.js';
import { protectValue, redactString } from '../../core/redact.js';
import type { Connection } from '../../core/types.js';
import { body, found } from '../util.js';

const REF = /^\$\{?([A-Z_][A-Z0-9_]*)\}?$/;

function maskEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!env) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    const ref = REF.exec(v);
    out[k] = ref ? `$${ref[1]}` : v ? '[set]' : '[missing]';
  }
  return out;
}

/** Connection safe for the UI: env values never leave the server. */
export function publicConnection(c: Connection, deps: AppDeps): Connection {
  const copy: Connection = { ...c };
  if ('env' in copy) (copy as { env?: Record<string, string> }).env = maskEnv(copy.env);
  if (copy.type === 'mcp') {
    copy.args = copy.args?.map((a) => redactString(a));
    if (copy.url) copy.url = redactString(copy.url);
  }
  return copy;
}

export function connectionsRoutes(app: Hono, deps: AppDeps): void {
  app.get('/api/connections', (c) => {
    const agents = deps.agents.list();
    const items = deps.connections.list().map((conn) => ({
      ...publicConnection(conn, deps),
      ready: deps.connections.has(conn.id),
      grantedTo: agents.filter((a) => a.access.connections[conn.id]).map((a) => a.id),
    }));
    return c.json({ items });
  });

  app.put('/api/connections/composio-key', async (c) => {
    const { apiKey } = await body(c, z.object({ apiKey: z.string().trim().min(8).max(500).regex(/^\S+$/, 'không được chứa khoảng trắng') }));
    setEnvKey(deps.config.envFile, 'COMPOSIO_API_KEY', apiKey);
    protectValue(apiKey);
    deps.connections.reload();
    deps.audit.log({ actor: 'user', action: 'connection.composio_key' });
    return c.json({ ok: true });
  });

  app.post('/api/connections/:id/test', async (c) => {
    const id = c.req.param('id');
    found(deps.connections.get(id), 'kết nối');
    const r = await deps.connections.test(id);
    return c.json({ ok: r.ok, message: redactString(r.message) });
  });
}
