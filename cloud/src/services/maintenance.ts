/** Daily cleanup run by the Workers cron trigger (wrangler.jsonc `triggers.crons`). */
import type { Env } from '../env';

const DAY = 86_400_000;

export async function runMaintenance(env: Env): Promise<Record<string, number>> {
  const now = env.now();
  const db = env.db;
  const [codes, pending, limits] = await db.batch([
    db.prepare('DELETE FROM login_codes WHERE expires_at < ?').bind(now - DAY),
    db.prepare('DELETE FROM oauth_pending WHERE expires_at < ?').bind(now),
    db.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(now - DAY),
  ]) as { meta: { changes?: number } }[];
  const out = { loginCodes: codes.meta.changes ?? 0, oauthPending: pending.meta.changes ?? 0, rateLimits: limits.meta.changes ?? 0 };
  env.log.info('maintenance done', out);
  return out;
}
