import fs from 'node:fs';
import path from 'node:path';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../../core/deps.js';
import { allowedRuntimes } from '../../core/runtime-policy.js';
import { genbotKeysFor } from '../../integrations/genbot-keys.js';
import { checkGenbotAgent } from '../../runtimes/genbot.js';
import { notFound } from '../errors.js';
import { body } from '../util.js';

export const EMERGENCY_KEY = 'emergency_stop';

function readVersion(rootDir: string): string {
  try {
    return (JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function systemRoutes(app: Hono, deps: AppDeps): void {
  const started = Date.now();
  const version = readVersion(deps.config.rootDir);
  const emergency = () => (deps.db.prepare('SELECT value FROM kv WHERE key = ?').get(EMERGENCY_KEY) as { value: string } | undefined)?.value === '1';
  const settings = () => ({ timezone: deps.config.timezone, maxParallel: deps.config.maxParallel, emergencyStop: emergency(), version });

  app.get('/api/health', (c) => c.json({ ok: true, version, uptimeSec: Math.round((Date.now() - started) / 1000) }));

  // Only the runtimes an agent may use (GenBot; 'mock' is never offered to the UI, even under tests or mock mode).
  app.get('/api/runtimes', async (c) => {
    const probe = c.req.query('probe') === '1';
    const allowed = allowedRuntimes();
    const items = await Promise.all(
      deps.runtimes.list().filter((r) => allowed.includes(r.id) && r.id !== 'mock').map(async (r) => ({ ...(await r.doctor({ probe })), label: r.label, capabilities: r.capabilities })),
    );
    return c.json({ items });
  });

  /**
   * Checks one GenBot configuration: a saved agent (`agentId`), the values on an agent form (`runtimeOptions`), or both
   * (form values win). Runtime.doctor stays generic; this is the per-agent check behind the form's "Kiểm tra" button.
   */
  app.post('/api/runtimes/genbot/check', async (c) => {
    const input = await body(c, z.object({ agentId: z.string().optional(), probe: z.boolean().optional(), runtimeOptions: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional() }));
    const saved = input.agentId ? deps.agents.get(input.agentId) : undefined;
    if (input.agentId && !saved) throw notFound(`Không tìm thấy agent "${input.agentId}".`);
    const runtimeOptions = { ...saved?.runtimeOptions, ...input.runtimeOptions };
    const keys = genbotKeysFor(deps);
    return c.json(await checkGenbotAgent(deps.runtimes.get('genbot'), { ...(saved ? { id: saved.id } : {}), runtimeOptions }, { probe: input.probe, keyFor: (id) => keys.get(id) }));
  });

  app.get('/api/stats', (c) => c.json(deps.stats.overview()));

  app.get('/api/attention', (c) => c.json({ items: deps.attention.list() }));
  app.post('/api/attention/:key/resolve', (c) => {
    deps.attention.resolve(decodeURIComponent(c.req.param('key')));
    return c.json({ ok: true });
  });

  app.get('/api/settings', (c) => c.json(settings()));
  app.put('/api/settings', async (c) => {
    const input = await body(c, z.object({ emergencyStop: z.boolean().optional() }));
    if (input.emergencyStop !== undefined) {
      deps.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(EMERGENCY_KEY, input.emergencyStop ? '1' : '0');
      deps.audit.log({ actor: 'user', action: input.emergencyStop ? 'settings.emergency_stop_on' : 'settings.emergency_stop_off' });
    }
    return c.json(settings());
  });
}
