/**
 * Publishing packs (admins only; mounted under /admin behind requireAdmin).
 * Flow: create pack → create release (signed upload URL) → PUT zip to R2 →
 * finalize (check zip) → publish (check signature) → optionally yank.
 * A published release's content never changes: fix it by publishing a new version.
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app-types';
import { incomingKey, packJson, releaseJson, releaseKey, type PackRow, type ReleaseRow } from '../db/packs';
import { auditStmt } from '../db/users';
import { badRequest, conflict, notFound, readJson } from '../http/errors';
import { newId, sha256Hex } from '../lib/encoding';
import { MAX_PACK_BYTES, PACK_MODULES, packIdSchema, semverSchema } from '../packs/format';
import { verifyPackSignature } from '../packs/signature';
import { PackError, checkPackZip } from '../packs/zip-check';

export const PACK_UPLOAD_TTL_SEC = 10 * 60;

export const adminPackRoutes = new Hono<AppEnv>();

const text = (max: number) => z.string().trim().max(max);

async function getRelease(c: Context<AppEnv>): Promise<ReleaseRow> {
  const r = await c.env.db.prepare('SELECT * FROM pack_releases WHERE id = ?').bind(c.req.param('id')).first<ReleaseRow>();
  if (!r) throw notFound('Không tìm thấy bản phát hành.');
  return r;
}

async function getPack(c: Context<AppEnv>, id: string): Promise<PackRow> {
  const p = await c.env.db.prepare('SELECT * FROM packs WHERE id = ?').bind(id).first<PackRow>();
  if (!p) throw notFound('Không tìm thấy gói.');
  return p;
}

adminPackRoutes.post('/packs', async (c) => {
  const body = await readJson(c, z.object({
    id: packIdSchema,
    module: z.enum(PACK_MODULES),
    name: text(120).min(1),
    summary: text(500).optional(),
    industry: text(60).optional(),
    visibility: z.enum(['public', 'unlisted']).default('public'),
  }));
  const now = c.env.now();
  const db = c.env.db;
  const existing = await db.prepare('SELECT id FROM packs WHERE id = ?').bind(body.id).first();
  if (existing) throw conflict(`Gói "${body.id}" đã có.`);
  await db.batch([
    db.prepare('INSERT INTO packs (id, module, name, summary, industry, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(body.id, body.module, body.name, body.summary ?? null, body.industry ?? null, body.visibility, now, now),
    auditStmt(c.env, c.var.auth.user.id, 'pack.create', body.id, { module: body.module }),
  ]);
  return c.json(await packJson(c.env, await getPack(c, body.id)), 201);
});

adminPackRoutes.patch('/packs/:id', async (c) => {
  const pack = await getPack(c, c.req.param('id'));
  const body = await readJson(c, z.object({
    name: text(120).min(1).optional(),
    summary: text(500).nullable().optional(),
    industry: text(60).nullable().optional(),
    visibility: z.enum(['public', 'unlisted']).optional(),
  }));
  const next = {
    name: body.name ?? pack.name,
    summary: body.summary === undefined ? pack.summary : body.summary,
    industry: body.industry === undefined ? pack.industry : body.industry,
    visibility: body.visibility ?? pack.visibility,
  };
  const db = c.env.db;
  await db.batch([
    db.prepare('UPDATE packs SET name = ?, summary = ?, industry = ?, visibility = ?, updated_at = ? WHERE id = ?')
      .bind(next.name, next.summary, next.industry, next.visibility, c.env.now(), pack.id),
    auditStmt(c.env, c.var.auth.user.id, 'pack.update', pack.id, body),
  ]);
  return c.json(await packJson(c.env, await getPack(c, pack.id)));
});

adminPackRoutes.post('/packs/:id/releases', async (c) => {
  const pack = await getPack(c, c.req.param('id'));
  const body = await readJson(c, z.object({ version: semverSchema, size: z.number().int().positive() }));
  if (body.size > MAX_PACK_BYTES) throw badRequest(`Gói tối đa ${MAX_PACK_BYTES / 1024 / 1024} MB.`);
  const db = c.env.db;
  const existing = await db.prepare('SELECT * FROM pack_releases WHERE pack_id = ? AND version = ?').bind(pack.id, body.version).first<ReleaseRow>();
  if (existing && existing.status !== 'pending') throw conflict(`Bản ${body.version} đã có. Muốn sửa thì phát hành phiên bản mới.`);
  if (existing) {
    // A previous upload of this version never finished: start over.
    await c.env.blobs.delete(incomingKey(existing.id));
    await db.prepare("DELETE FROM pack_releases WHERE id = ? AND status = 'pending'").bind(existing.id).run();
  }
  const id = newId('rel', (n) => c.env.randomBytes(n));
  const now = c.env.now();
  await db.batch([
    db.prepare('INSERT INTO pack_releases (id, pack_id, version, r2_key, status, created_at) VALUES (?, ?, ?, ?, \'pending\', ?)')
      .bind(id, pack.id, body.version, releaseKey(pack.id, body.version), now),
    auditStmt(c.env, c.var.auth.user.id, 'release.create', id, { pack: pack.id, version: body.version }),
  ]);
  const upload = await c.env.blobs.presignPut(incomingKey(id), { contentType: 'application/zip', contentLength: body.size, expiresInSec: PACK_UPLOAD_TTL_SEC });
  return c.json({
    releaseId: id,
    uploadUrl: upload.url,
    headers: upload.headers,
    expiresAt: new Date(now + PACK_UPLOAD_TTL_SEC * 1000).toISOString(),
  }, 201);
});

adminPackRoutes.post('/releases/:id/finalize', async (c) => {
  const release = await getRelease(c);
  if (release.status !== 'pending') throw conflict('Bản này đã được kiểm rồi; nội dung không đổi được nữa.');
  const pack = await getPack(c, release.pack_id);
  const db = c.env.db;
  const incoming = incomingKey(release.id);
  const zip = await c.env.blobs.get(incoming);
  if (!zip) throw badRequest('Chưa có file zip trên R2. Hãy tải lên bằng uploadUrl trước.');

  const reject = async (err: PackError) => {
    // A bad upload is removed entirely so the same version can be retried from scratch.
    await c.env.blobs.delete(incoming);
    await db.batch([
      db.prepare("DELETE FROM pack_releases WHERE id = ? AND status = 'pending'").bind(release.id),
      auditStmt(c.env, c.var.auth.user.id, 'release.reject', release.id, { file: err.file, reason: err.reason }),
    ]);
    return badRequest(`Gói không hợp lệ: ${err.file}: ${err.reason}`, { file: err.file, reason: err.reason });
  };

  let checked;
  try {
    checked = await checkPackZip(zip, { id: pack.id, version: release.version, module: pack.module });
  } catch (err) {
    if (err instanceof PackError) throw await reject(err);
    throw err;
  }
  const sha = await sha256Hex(zip);
  await c.env.blobs.put(release.r2_key, zip, 'application/zip');
  await c.env.blobs.delete(incoming);
  await db.batch([
    db.prepare("UPDATE pack_releases SET status = 'draft', size = ?, sha256 = ?, manifest_json = ?, notes_count = ? WHERE id = ? AND status = 'pending'")
      .bind(zip.length, sha, JSON.stringify(checked.manifest), checked.notesCount, release.id),
    auditStmt(c.env, c.var.auth.user.id, 'release.finalize', release.id, { sha256: sha, size: zip.length }),
  ]);
  return c.json(releaseJson((await getRelease(c))));
});

adminPackRoutes.post('/releases/:id/publish', async (c) => {
  const release = await getRelease(c);
  const body = await readJson(c, z.object({ signature: z.string().min(1).max(200), keyId: z.string().min(1).max(100) }));
  if (release.status !== 'draft') throw conflict(release.status === 'pending' ? 'Hãy finalize trước khi phát hành.' : 'Bản này đã phát hành rồi.');
  const ok = await verifyPackSignature({
    publicKeys: c.env.config.packSigningKeys,
    keyId: body.keyId,
    signature: body.signature,
    packId: release.pack_id,
    version: release.version,
    sha256: release.sha256 ?? '',
  });
  if (!ok) throw badRequest('Chữ ký không hợp lệ cho gói này, hoặc keyId không có trong PACK_SIGNING_KEYS.');
  const now = c.env.now();
  const manifest = release.manifest_json ? JSON.parse(release.manifest_json) as { name: string; summary?: string } : null;
  const db = c.env.db;
  await db.batch([
    db.prepare("UPDATE pack_releases SET status = 'published', signature = ?, key_id = ?, published_at = ? WHERE id = ? AND status = 'draft'")
      .bind(body.signature, body.keyId, now, release.id),
    db.prepare('UPDATE packs SET name = coalesce(?, name), summary = coalesce(?, summary), updated_at = ? WHERE id = ?')
      .bind(manifest?.name ?? null, manifest?.summary ?? null, now, release.pack_id),
    auditStmt(c.env, c.var.auth.user.id, 'release.publish', release.id, { keyId: body.keyId }),
  ]);
  return c.json(releaseJson(await getRelease(c)));
});

adminPackRoutes.post('/releases/:id/yank', async (c) => {
  const release = await getRelease(c);
  if (release.status !== 'published') throw conflict('Chỉ thu hồi được bản đã phát hành.');
  const db = c.env.db;
  await db.batch([
    db.prepare("UPDATE pack_releases SET status = 'yanked', yanked_at = ? WHERE id = ?").bind(c.env.now(), release.id),
    auditStmt(c.env, c.var.auth.user.id, 'release.yank', release.id),
  ]);
  return c.json(releaseJson(await getRelease(c)));
});
