import fs from 'node:fs';
import path from 'node:path';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../../core/deps.js';
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

  app.get('/api/runtimes', async (c) => {
    const probe = c.req.query('probe') === '1';
    const items = await Promise.all(
      deps.runtimes.list().map(async (r) => ({ ...(await r.doctor({ probe })), label: r.label, capabilities: r.capabilities })),
    );
    return c.json({ items });
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
