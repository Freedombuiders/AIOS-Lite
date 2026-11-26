/**
 * Photos and videos for posting. The client PUTs the file straight to R2 with
 * a signed URL, then calls complete; the Worker checks the real size and the
 * first bytes, and hands back a signed read URL that social platforms can fetch.
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app-types';
import {
  POST_MEDIA_TTL_MS, READ_URL_TTL_SEC, UPLOAD_URL_TTL_SEC, deleteUploads, uploadJson, uploadKey, type UploadRow,
} from '../db/uploads';
import { requireSession } from '../http/auth';
import { ApiError, badRequest, forbidden, notFound, readJson } from '../http/errors';
import { newId } from '../lib/encoding';
import { MEDIA_TYPES, SNIFF_BYTES, UPLOAD_PURPOSES, isMediaType, sniff } from '../uploads/media';

export const uploadRoutes = new Hono<AppEnv>();

uploadRoutes.use('*', requireSession);

async function ownUpload(c: Context<AppEnv>): Promise<UploadRow> {
  // Someone else's id is "not found", so ids cannot be probed.
  const row = await c.env.db.prepare("SELECT * FROM uploads WHERE id = ? AND user_id = ? AND status != 'deleted'")
    .bind(c.req.param('id'), c.var.auth.user.id).first<UploadRow>();
  if (!row) throw notFound('Không tìm thấy tệp.');
  return row;
}

uploadRoutes.post('/', async (c) => {
  const user = c.var.auth.user;
  const body = await readJson(c, z.object({
    contentType: z.string().max(100),
    size: z.number().int().positive(),
    purpose: z.enum(UPLOAD_PURPOSES),
  }));
  const contentType = body.contentType.toLowerCase().split(';')[0].trim();
  if (!isMediaType(contentType)) throw badRequest(`Chỉ nhận ${Object.keys(MEDIA_TYPES).join(', ')}.`);
  const media = MEDIA_TYPES[contentType];
  if (body.size > media.maxBytes) throw badRequest(`${media.kind === 'video' ? 'Video' : 'Ảnh'} tối đa ${media.maxBytes / 1024 / 1024} MB.`);
  if (body.purpose !== 'post-media' && media.kind !== 'image') throw badRequest('Ảnh đại diện và ảnh bìa phải là ảnh.');
  if (body.purpose === 'pack-cover' && user.role !== 'admin') throw forbidden('Chỉ quản trị viên tải được ảnh bìa gói.');

  const used = await c.env.db.prepare("SELECT coalesce(sum(size), 0) AS n FROM uploads WHERE user_id = ? AND status IN ('pending', 'ready')")
    .bind(user.id).first<{ n: number }>();
  const quota = c.env.config.uploadQuotaBytes;
  if ((used?.n ?? 0) + body.size > quota) {
    throw new ApiError(403, 'quota_exceeded', `Vượt hạn mức lưu trữ ${Math.round(quota / 1024 / 1024)} MB. Hãy xoá bớt tệp cũ.`);
  }

  const id = newId('upl', (n) => c.env.randomBytes(n));
  const now = c.env.now();
  const key = uploadKey(user.id, body.purpose, id, media.ext);
  await c.env.db.prepare(
    "INSERT INTO uploads (id, user_id, r2_key, content_type, size, purpose, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
  ).bind(id, user.id, key, contentType, body.size, body.purpose, now, body.purpose === 'post-media' ? now + POST_MEDIA_TTL_MS : null).run();
  const put = await c.env.blobs.presignPut(key, { contentType, contentLength: body.size, expiresInSec: UPLOAD_URL_TTL_SEC });
  return c.json({ id, uploadUrl: put.url, headers: put.headers, expiresAt: new Date(now + UPLOAD_URL_TTL_SEC * 1000).toISOString() }, 201);
});

uploadRoutes.post('/:id/complete', async (c) => {
  const row = await ownUpload(c);
  if (row.status === 'ready') {
    const json = await uploadJson(c.env, row);
    return c.json({ id: row.id, url: json.url, expiresAt: json.urlExpiresAt });
  }
  const head = await c.env.blobs.head(row.r2_key);
  if (!head) throw badRequest('Chưa thấy tệp trên kho. Hãy tải lên bằng uploadUrl trước.');
  const reject = async (message: string) => {
    await deleteUploads(c.env, [row]);
    return badRequest(message);
  };
  if (head.size !== row.size) throw await reject(`Kích thước thật (${head.size} byte) khác khai báo (${row.size} byte). Tệp đã bị xoá.`);
  const first = await c.env.blobs.get(row.r2_key, { offset: 0, length: Math.min(SNIFF_BYTES, head.size) });
  if (!first || sniff(first) !== row.content_type) throw await reject(`Nội dung tệp không phải ${row.content_type}. Tệp đã bị xoá.`);

  await c.env.db.prepare("UPDATE uploads SET status = 'ready', size = ? WHERE id = ?").bind(head.size, row.id).run();
  if (row.purpose === 'avatar') {
    // A new avatar replaces the old ones.
    const { results: old } = await c.env.db.prepare("SELECT * FROM uploads WHERE user_id = ? AND purpose = 'avatar' AND status = 'ready' AND id != ?")
      .bind(row.user_id, row.id).all<UploadRow>();
    await deleteUploads(c.env, old);
  }
  return c.json({
    id: row.id,
    url: await c.env.blobs.presignGet(row.r2_key, READ_URL_TTL_SEC),
    expiresAt: new Date(c.env.now() + READ_URL_TTL_SEC * 1000).toISOString(),
  });
});

uploadRoutes.get('/', async (c) => {
  const purpose = c.req.query('purpose');
  if (purpose && !(UPLOAD_PURPOSES as readonly string[]).includes(purpose)) throw badRequest(`"purpose" chỉ nhận: ${UPLOAD_PURPOSES.join(', ')}.`);
  const { results } = await c.env.db.prepare(
    `SELECT * FROM uploads WHERE user_id = ? AND status != 'deleted' ${purpose ? 'AND purpose = ?' : ''} ORDER BY created_at DESC LIMIT 200`,
  ).bind(c.var.auth.user.id, ...(purpose ? [purpose] : [])).all<UploadRow>();
  return c.json({ items: await Promise.all(results.map((u) => uploadJson(c.env, u))) });
});

uploadRoutes.delete('/:id', async (c) => {
  const row = await ownUpload(c);
  await deleteUploads(c.env, [row]);
  if (row.purpose === 'pack-cover') {
    await c.env.db.prepare('UPDATE packs SET cover_key = NULL WHERE cover_key = ?').bind(row.r2_key).run();
  }
  return c.json({ ok: true });
});
