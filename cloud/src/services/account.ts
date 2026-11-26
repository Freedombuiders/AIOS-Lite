/** Account deletion (`DELETE /me`): app stores require a way to delete an account and its data. */
import type { Env } from '../env';
import { auditStmt, countActiveAdmins, type UserRow } from '../db/users';
import { conflict } from '../http/errors';

export async function deleteAccount(env: Env, user: UserRow): Promise<void> {
  if (user.role === 'admin' && user.status === 'active' && (await countActiveAdmins(env)) <= 1) {
    throw conflict('Bạn là quản trị viên cuối cùng. Hãy cấp quyền quản trị cho người khác trước khi xoá tài khoản.');
  }
  const db = env.db;
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
    db.prepare('DELETE FROM login_codes WHERE user_id = ?').bind(user.id),
    db.prepare('DELETE FROM users WHERE id = ?').bind(user.id),
    auditStmt(env, user.id, 'user.delete_self', user.id),
  ]);
  env.log.info('account deleted', { userId: user.id });
}
