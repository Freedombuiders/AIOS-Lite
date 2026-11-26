/**
 * Sessions: a 32-byte random token handed to the client once; only its SHA-256
 * is stored, so a database leak does not leak usable tokens and any session can
 * be revoked at once.
 */
import type { Env } from '../env';
import { newId, sha256Hex, toBase64Url } from '../lib/encoding';
import type { SessionKind, SessionRow, UserRow } from '../db/users';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const SESSION_TTL_MS: Record<SessionKind, number> = {
  mobile: 90 * DAY,
  machine: 90 * DAY,
  web: 12 * HOUR,
};

/** `last_seen_at` is written at most this often per user, to save D1 writes. */
export const LAST_SEEN_EVERY_MS = 5 * 60_000;

export const hashToken = (token: string) => sha256Hex(token);

export async function createSession(env: Env, userId: string, kind: SessionKind, label?: string | null): Promise<{ token: string; session: SessionRow }> {
  const token = toBase64Url(env.randomBytes(32));
  const now = env.now();
  const session: SessionRow = {
    id: newId('ses', (n) => env.randomBytes(n)),
    user_id: userId,
    kind,
    label: label ?? null,
    created_at: now,
    expires_at: now + SESSION_TTL_MS[kind],
    revoked_at: null,
  };
  await env.db.prepare(
    'INSERT INTO sessions (id, user_id, token_hash, kind, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).bind(session.id, userId, await hashToken(token), kind, session.label, now, session.expires_at).run();
  return { token, session };
}

interface JoinedRow {
  s_id: string; s_kind: SessionKind; s_label: string | null; s_created_at: number; s_expires_at: number;
  id: string; google_sub: string; email: string; name: string | null; avatar_url: string | null;
  role: UserRow['role']; status: UserRow['status']; created_at: number; last_seen_at: number | null;
}

/** The live session for a token, with its active user; null when unknown, expired, revoked or the user is disabled. */
export async function findActiveSession(env: Env, token: string): Promise<{ user: UserRow; session: SessionRow } | null> {
  if (!token || token.length > 200) return null;
  const now = env.now();
  const row = await env.db.prepare(
    `SELECT s.id AS s_id, s.kind AS s_kind, s.label AS s_label, s.created_at AS s_created_at, s.expires_at AS s_expires_at,
            u.id, u.google_sub, u.email, u.name, u.avatar_url, u.role, u.status, u.created_at, u.last_seen_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND u.status = 'active'`,
  ).bind(await hashToken(token), now).first<JoinedRow>();
  if (!row) return null;
  const user: UserRow = {
    id: row.id, google_sub: row.google_sub, email: row.email, name: row.name, avatar_url: row.avatar_url,
    role: row.role, status: row.status, created_at: row.created_at, last_seen_at: row.last_seen_at,
  };
  if (user.last_seen_at === null || now - user.last_seen_at >= LAST_SEEN_EVERY_MS) {
    await env.db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').bind(now, user.id).run();
    user.last_seen_at = now;
  }
  const session: SessionRow = {
    id: row.s_id, user_id: row.id, kind: row.s_kind, label: row.s_label,
    created_at: row.s_created_at, expires_at: row.s_expires_at, revoked_at: null,
  };
  return { user, session };
}
