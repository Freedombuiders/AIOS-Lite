// Per-run token for the MCP bridge: HMAC-SHA256 over `agentId.taskId.exp`, so the bridge never sees any credential.
import crypto from 'node:crypto';
import type { DB } from '../core/db.js';

const KV_KEY = 'integrations_token_secret';

export function createRunToken(input: { agentId: string; taskId: number | string }, secret: string, ttlMs = 2 * 3600_000): string {
  const exp = Date.now() + ttlMs;
  const payload = Buffer.from(JSON.stringify([input.agentId, String(input.taskId), exp])).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyRunToken(token: string, secret: string): { agentId: string; taskId: number } | null {
  const [payload, sig, extra] = token.split('.');
  if (!payload || !sig || extra !== undefined) return null;
  const want = crypto.createHmac('sha256', secret).update(payload).digest();
  let got: Buffer;
  try { got = Buffer.from(sig, 'base64url'); } catch { return null; }
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  try {
    const [agentId, taskId, exp] = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as [string, string, number];
    const id = Number(taskId);
    if (typeof agentId !== 'string' || !Number.isInteger(id) || typeof exp !== 'number' || exp < Date.now()) return null;
    return { agentId, taskId: id };
  } catch {
    return null;
  }
}

/** The HMAC secret lives in kv; created on first use. */
export function tokenSecret(db: DB): string {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(KV_KEY) as { value: string } | undefined;
  if (row?.value) return row.value;
  const secret = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT OR IGNORE INTO kv (key, value) VALUES (?, ?)').run(KV_KEY, secret);
  return (db.prepare('SELECT value FROM kv WHERE key = ?').get(KV_KEY) as { value: string }).value;
}
