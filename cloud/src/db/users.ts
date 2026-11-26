/** D1 queries for users, sessions and the audit log. */
import type { Env, SqlStatement } from '../env';

export type Role = 'user' | 'admin';
export type UserStatus = 'active' | 'disabled';
export type SessionKind = 'mobile' | 'machine' | 'web';

export interface UserRow {
  id: string;
  google_sub: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  role: Role;
  status: UserStatus;
  created_at: number;
  last_seen_at: number | null;
}

export interface SessionRow {
  id: string;
  user_id: string;
  kind: SessionKind;
  label: string | null;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export function userJson(u: UserRow) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    avatarUrl: u.avatar_url,
    role: u.role,
    status: u.status,
    createdAt: iso(u.created_at),
    lastSeenAt: iso(u.last_seen_at),
  };
}

export function sessionJson(s: SessionRow, currentId?: string) {
  return {
    id: s.id,
    kind: s.kind,
    label: s.label,
    createdAt: iso(s.created_at),
    expiresAt: iso(s.expires_at),
    current: s.id === currentId,
  };
}

export function getUser(env: Env, id: string): Promise<UserRow | null> {
  return env.db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>();
}

export interface GoogleProfile { sub: string; email: string; name?: string; picture?: string }

/**
 * Creates the user on first sign-in, keyed by Google `sub` (not email: an email
 * can change or be recycled). Later sign-ins refresh email, name and picture.
 * An email in ADMIN_EMAILS promotes to admin; it never demotes.
 */
export function upsertGoogleUser(env: Env, id: string, p: GoogleProfile): Promise<UserRow | null> {
  const role: Role = env.config.adminEmails.includes(p.email.toLowerCase()) ? 'admin' : 'user';
  return env.db.prepare(
    `INSERT INTO users (id, google_sub, email, name, avatar_url, role, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
     ON CONFLICT(google_sub) DO UPDATE SET
       email = excluded.email,
       name = excluded.name,
       avatar_url = excluded.avatar_url,
       role = CASE WHEN excluded.role = 'admin' THEN 'admin' ELSE users.role END
     RETURNING *`,
  ).bind(id, p.sub, p.email, p.name ?? null, p.picture ?? null, role, env.now()).first<UserRow>();
}

export async function countActiveAdmins(env: Env): Promise<number> {
  const row = await env.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'").first<{ n: number }>();
  return row?.n ?? 0;
}

/** An audit row, as a statement so it can join the batch (transaction) of the change it records. */
export function auditStmt(env: Env, actor: string, action: string, target: string | null, detail?: unknown): SqlStatement {
  return env.db.prepare('INSERT INTO audit (actor, action, target, detail, at) VALUES (?, ?, ?, ?, ?)')
    .bind(actor, action, target, detail === undefined ? null : JSON.stringify(detail), env.now());
}

/** Revokes every live session of a user. */
export function revokeAllSessionsStmt(env: Env, userId: string): SqlStatement {
  return env.db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').bind(env.now(), userId);
}

/** Keyset cursor over (created_at, id), opaque to clients. */
export function encodeCursor(at: number, id: string | number): string {
  return btoa(`${at}|${id}`).replace(/=+$/, '');
}

export function decodeCursor(cursor: string | undefined): { at: number; id: string } | null {
  if (!cursor) return null;
  try {
    const [at, id] = atob(cursor).split('|');
    const n = Number(at);
    if (!Number.isFinite(n) || !id) return null;
    return { at: n, id };
  } catch {
    return null;
  }
}
