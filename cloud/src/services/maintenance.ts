/** Daily cleanup run by the Workers cron trigger (wrangler.jsonc `triggers.crons`). */
import type { Env } from '../env';
import { PENDING_TTL_MS, deleteUploads, type UploadRow } from '../db/uploads';

const DAY = 86_400_000;
const BATCH = 500;

/**
 * Deletes post media past its 7 days and uploads left pending for over an
 * hour (the object may exist if the client uploaded but never completed).
 * Avatars and pack covers have no expiry and are never touched here.
 */
export async function cleanUploads(env: Env): Promise<number> {
  const now = env.now();
  let total = 0;
  for (;;) {
    const { results } = await env.db.prepare(
      `SELECT * FROM uploads
        WHERE (status = 'ready' AND purpose = 'post-media' AND expires_at IS NOT NULL AND expires_at <= ?)
           OR (status = 'pending' AND created_at <= ?)
        LIMIT ?`,
    ).bind(now, now - PENDING_TTL_MS, BATCH).all<UploadRow>();
    if (results.length === 0) return total;
    await deleteUploads(env, results);
    total += results.length;
  }
}

export async function runMaintenance(env: Env): Promise<Record<string, number>> {
  const now = env.now();
  const uploads = await cleanUploads(env);
  const db = env.db;
  const [codes, pending, limits, oldRows] = await db.batch([
    db.prepare('DELETE FROM login_codes WHERE expires_at < ?').bind(now - DAY),
    db.prepare('DELETE FROM oauth_pending WHERE expires_at < ?').bind(now),
    db.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(now - DAY),
    db.prepare("DELETE FROM uploads WHERE status = 'deleted' AND created_at < ?").bind(now - 30 * DAY),
  ]) as { meta: { changes?: number } }[];
  const out = {
    uploads,
    loginCodes: codes.meta.changes ?? 0,
    oauthPending: pending.meta.changes ?? 0,
    rateLimits: limits.meta.changes ?? 0,
    deletedUploadRows: oldRows.meta.changes ?? 0,
  };
  env.log.info('maintenance done', out);
  return out;
}
