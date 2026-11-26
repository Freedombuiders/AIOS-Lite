import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app-types';
import {
  auditStmt, countActiveAdmins, decodeCursor, encodeCursor, getUser, revokeAllSessionsStmt, userJson, type UserRow,
} from '../db/users';
import { requireAdmin, requireSession } from '../http/auth';
import { badRequest, conflict, notFound, readJson } from '../http/errors';

const PAGE = 50;

export const adminUserRoutes = new Hono<AppEnv>();

adminUserRoutes.use('*', requireSession, requireAdmin);

adminUserRoutes.get('/users', async (c) => {
  const q = c.req.query('q')?.trim().toLowerCase();
  const status = c.req.query('status');
  if (status && status !== 'active' && status !== 'disabled') throw badRequest('"status" chỉ nhận active hoặc disabled.');
  const cursor = decodeCursor(c.req.query('cursor'));
  const where: string[] = [];
  const args: unknown[] = [];
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    where.push("(lower(email) LIKE ? ESCAPE '\\' OR lower(coalesce(name, '')) LIKE ? ESCAPE '\\')");
    args.push(like, like);
  }
  if (status) { where.push('status = ?'); args.push(status); }
  if (cursor) { where.push('(created_at < ? OR (created_at = ? AND id < ?))'); args.push(cursor.at, cursor.at, cursor.id); }
  const sql = `SELECT * FROM users ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`;
  const { results } = await c.env.db.prepare(sql).bind(...args, PAGE + 1).all<UserRow>();
  const page = results.slice(0, PAGE);
  const last = page[page.length - 1];
  return c.json({ items: page.map(userJson), next: results.length > PAGE && last ? encodeCursor(last.created_at, last.id) : null });
});

adminUserRoutes.patch('/users/:id', async (c) => {
  const body = await readJson(c, z.object({
    status: z.enum(['active', 'disabled']).optional(),
    role: z.enum(['user', 'admin']).optional(),
  }).refine((b) => b.status !== undefined || b.role !== undefined));
  const actor = c.var.auth.user;
  const target = await getUser(c.env, c.req.param('id'));
  if (!target) throw notFound('Không tìm thấy người dùng.');

  const losesAdmin = target.role === 'admin' && target.status === 'active'
    && (body.role === 'user' || body.status === 'disabled');
  if (losesAdmin && (await countActiveAdmins(c.env)) <= 1) {
    throw conflict('Không thể hạ quyền hoặc khoá quản trị viên cuối cùng.');
  }

  const db = c.env.db;
  const next = { role: body.role ?? target.role, status: body.status ?? target.status };
  // One transaction: disabling a user and revoking every session they hold happen together.
  const stmts = [
    db.prepare('UPDATE users SET role = ?, status = ? WHERE id = ?').bind(next.role, next.status, target.id),
    auditStmt(c.env, actor.id, 'user.update', target.id, { from: { role: target.role, status: target.status }, to: next }),
  ];
  if (next.status === 'disabled' && target.status !== 'disabled') stmts.push(revokeAllSessionsStmt(c.env, target.id));
  await db.batch(stmts);
  const updated = await getUser(c.env, target.id);
  return c.json(userJson(updated ?? { ...target, ...next }));
});

interface AuditRow { id: number; actor: string; action: string; target: string | null; detail: string | null; at: number }

adminUserRoutes.get('/audit', async (c) => {
  const cursor = decodeCursor(c.req.query('cursor'));
  const { results } = await c.env.db.prepare(
    `SELECT * FROM audit ${cursor ? 'WHERE id < ?' : ''} ORDER BY id DESC LIMIT ?`,
  ).bind(...(cursor ? [Number(cursor.id)] : []), PAGE + 1).all<AuditRow>();
  const page = results.slice(0, PAGE);
  const last = page[page.length - 1];
  return c.json({
    items: page.map((a) => ({
      id: a.id, actor: a.actor, action: a.action, target: a.target,
      detail: a.detail ? JSON.parse(a.detail) as unknown : null,
      at: new Date(a.at).toISOString(),
    })),
    next: results.length > PAGE && last ? encodeCursor(last.at, last.id) : null,
  });
});
