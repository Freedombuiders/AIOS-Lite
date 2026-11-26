/** Account deletion (`DELETE /me`): app stores require a way to delete an account and its data. */
import type { Env } from '../env';
import { auditStmt, countActiveAdmins, type UserRow } from '../db/users';
import { userPrefix } from '../db/uploads';
import { conflict } from '../http/errors';

/** Deletes every object under `u/<userId>/`. */
export async function deleteUserObjects(env: Env, userId: string): Promise<number> {
  let deleted = 0;
  for (;;) {
    // Always list from the start: deleting the page moves the remainder up.
    const page = await env.blobs.list(userPrefix(userId));
    if (page.keys.length === 0) return deleted;
    await env.blobs.delete(page.keys);
    deleted += page.keys.length;
  }
}

export async function deleteAccount(env: Env, user: UserRow): Promise<void> {
  if (user.role === 'admin' && user.status === 'active' && (await countActiveAdmins(env)) <= 1) {
    throw conflict('Bạn là quản trị viên cuối cùng. Hãy cấp quyền quản trị cho người khác trước khi xoá tài khoản.');
  }
  // Files first: if this fails the account still exists and the user can retry.
  const objects = await deleteUserObjects(env, user.id);
  const db = env.db;
  await db.batch([
    db.prepare('UPDATE packs SET cover_key = NULL WHERE cover_key LIKE ?').bind(`${userPrefix(user.id)}%`),
    db.prepare('DELETE FROM uploads WHERE user_id = ?').bind(user.id),
    db.prepare('DELETE FROM downloads WHERE user_id = ?').bind(user.id),
    db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
    db.prepare('DELETE FROM login_codes WHERE user_id = ?').bind(user.id),
    db.prepare('DELETE FROM users WHERE id = ?').bind(user.id),
    auditStmt(env, user.id, 'user.delete_self', user.id, { objects }),
  ]);
  env.log.info('account deleted', { userId: user.id, objects });
}
