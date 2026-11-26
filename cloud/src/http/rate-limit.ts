/**
 * Fixed-window counters in D1: one row per key, reset when the window moves on.
 * One upsert per request, no read-then-write race.
 */
import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import type { AppEnv } from '../app-types';
import type { Env } from '../env';
import { tooManyRequests } from './errors';

/** Counts one hit for `key` and returns the count in the current window. */
export async function hit(env: Env, key: string, windowSec: number): Promise<{ count: number; resetAt: number }> {
  const windowMs = windowSec * 1000;
  const windowStart = Math.floor(env.now() / windowMs) * windowMs;
  const row = await env.db.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.count + 1 ELSE 1 END,
       window_start = excluded.window_start
     RETURNING count`,
  ).bind(key, windowStart).first<{ count: number }>();
  return { count: row?.count ?? 1, resetAt: windowStart + windowMs };
}

export const clientIp = (c: Context<AppEnv>) => c.req.header('cf-connecting-ip')?.trim() || 'unknown';

/** Limits requests per client IP (`CF-Connecting-IP`) using the config's auth limit. */
export const authRateLimit = createMiddleware<AppEnv>(async (c, next) => {
  const { limit, windowSec } = c.env.config.authRateLimit;
  const { count, resetAt } = await hit(c.env, `auth:${clientIp(c)}`, windowSec);
  if (count > limit) {
    c.header('Retry-After', String(Math.max(1, Math.ceil((resetAt - c.env.now()) / 1000))));
    throw tooManyRequests();
  }
  await next();
});
