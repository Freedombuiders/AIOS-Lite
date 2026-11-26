import type { Env } from '../env';
import type { UploadPurpose } from '../uploads/media';

export interface UploadRow {
  id: string;
  user_id: string;
  r2_key: string;
  content_type: string;
  size: number | null;
  purpose: UploadPurpose;
  status: 'pending' | 'ready' | 'deleted';
  created_at: number;
  expires_at: number | null;
}

/** Read links live 24 hours; post media itself is deleted 7 days after upload. */
export const READ_URL_TTL_SEC = 24 * 3600;
export const POST_MEDIA_TTL_MS = 7 * 24 * 3_600_000;
export const UPLOAD_URL_TTL_SEC = 10 * 60;
export const PENDING_TTL_MS = 3_600_000;

/** `u/<userId>/<purpose>/<id>.<ext>`: never the user's own file name. */
export const uploadKey = (userId: string, purpose: UploadPurpose, id: string, ext: string) => `u/${userId}/${purpose}/${id}.${ext}`;
export const userPrefix = (userId: string) => `u/${userId}/`;

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export async function uploadJson(env: Env, u: UploadRow) {
  const ready = u.status === 'ready';
  return {
    id: u.id,
    purpose: u.purpose,
    contentType: u.content_type,
    size: u.size,
    status: u.status,
    createdAt: iso(u.created_at),
    /** When the file itself is deleted (post media only). */
    deleteAt: iso(u.expires_at),
    url: ready ? await env.blobs.presignGet(u.r2_key, READ_URL_TTL_SEC) : null,
    urlExpiresAt: ready ? iso(env.now() + READ_URL_TTL_SEC * 1000) : null,
  };
}

/** Deletes the objects and marks the rows deleted. */
export async function deleteUploads(env: Env, rows: UploadRow[]): Promise<void> {
  if (rows.length === 0) return;
  await env.blobs.delete(rows.map((r) => r.r2_key));
  for (let i = 0; i < rows.length; i += 50) {
    const chunk = rows.slice(i, i + 50);
    await env.db.prepare(`UPDATE uploads SET status = 'deleted' WHERE id IN (${chunk.map(() => '?').join(',')})`)
      .bind(...chunk.map((r) => r.id)).run();
  }
}
