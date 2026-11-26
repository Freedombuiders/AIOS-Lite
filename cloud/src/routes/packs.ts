/** Browsing and downloading packs, for any signed-in user. */
import { Hono } from 'hono';
import type { AppEnv } from '../app-types';
import {
  latestPublished, manifestOf, packJson, releaseJson, releasesOf, type PackRow, type ReleaseRow,
} from '../db/packs';
import { requireSession } from '../http/auth';
import { ApiError, badRequest, notFound, tooManyRequests } from '../http/errors';
import { PACK_ID, PACK_MODULES, compareSemver } from '../packs/format';

export const DOWNLOAD_URL_TTL_SEC = 5 * 60;
export const DOWNLOADS_PER_HOUR = 60;

export const packRoutes = new Hono<AppEnv>();

packRoutes.use('*', requireSession);

packRoutes.get('/', async (c) => {
  const module = c.req.query('module');
  const industry = c.req.query('industry')?.trim();
  const q = c.req.query('q')?.trim().toLowerCase();
  if (module && !(PACK_MODULES as readonly string[]).includes(module)) throw badRequest(`"module" chỉ nhận: ${PACK_MODULES.join(', ')}.`);
  const where = ["visibility = 'public'"];
  const args: unknown[] = [];
  if (module) { where.push('module = ?'); args.push(module); }
  if (industry) { where.push('industry = ?'); args.push(industry); }
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    where.push("(lower(name) LIKE ? ESCAPE '\\' OR lower(coalesce(summary, '')) LIKE ? ESCAPE '\\')");
    args.push(like, like);
  }
  const { results: packs } = await c.env.db.prepare(
    `SELECT * FROM packs WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT 200`,
  ).bind(...args).all<PackRow>();
  const releases = await releasesOf(c.env, packs.map((p) => p.id));
  const items = [];
  for (const p of packs) {
    const latest = latestPublished(releases.get(p.id) ?? []);
    if (!latest) continue;
    items.push({ ...(await packJson(c.env, p)), latest: releaseJson(latest) });
  }
  return c.json({ items });
});

/** `?have=id@ver,id@ver`: which installed packs have a newer release, and which installed versions were yanked. */
packRoutes.get('/updates', async (c) => {
  const have = (c.req.query('have') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (have.length > 200) throw badRequest('Tối đa 200 gói mỗi lần hỏi.');
  const wanted = new Map<string, string>();
  for (const entry of have) {
    const at = entry.lastIndexOf('@');
    const id = entry.slice(0, at);
    const version = entry.slice(at + 1);
    if (at <= 0 || !PACK_ID.test(id) || !version) throw badRequest(`"${entry.slice(0, 100)}" phải có dạng id@phiên-bản.`);
    wanted.set(id, version);
  }
  const releases = await releasesOf(c.env, [...wanted.keys()]);
  const items = [];
  for (const [id, version] of wanted) {
    const all = releases.get(id) ?? [];
    const latest = latestPublished(all);
    const mine = all.find((r) => r.version === version);
    const update = !!latest && compareSemver(latest.version, version) > 0;
    const yanked = mine?.status === 'yanked';
    if (update || yanked) {
      items.push({
        id,
        have: version,
        latest: latest?.version ?? null,
        update,
        yanked,
        ...(yanked ? { warning: `Bản ${version} của gói ${id} đã bị thu hồi. Nên cập nhật hoặc gỡ gói.` } : {}),
      });
    }
  }
  return c.json({ items });
});

packRoutes.get('/:id', async (c) => {
  const pack = await c.env.db.prepare('SELECT * FROM packs WHERE id = ?').bind(c.req.param('id')).first<PackRow>();
  if (!pack) throw notFound('Không tìm thấy gói.');
  const isAdmin = c.var.auth.user.role === 'admin';
  const all = (await releasesOf(c.env, [pack.id])).get(pack.id) ?? [];
  const visible = all
    .filter((r) => isAdmin || r.status === 'published' || r.status === 'yanked')
    .sort((a, b) => compareSemver(b.version, a.version));
  const latest = latestPublished(all);
  if (!latest && !isAdmin) throw notFound('Không tìm thấy gói.');
  const manifest = latest ? manifestOf(latest) : null;
  return c.json({
    ...(await packJson(c.env, pack)),
    license: manifest?.license ?? null,
    author: manifest?.author ?? null,
    latest: latest ? releaseJson(latest) : null,
    releases: visible.map(releaseJson),
    files: manifest?.files.map((f) => ({ path: f.path, loai: f.loai ?? null, sha256: f.sha256 })) ?? [],
  });
});

packRoutes.post('/:id/releases/:version/download', async (c) => {
  const user = c.var.auth.user;
  const release = await c.env.db.prepare('SELECT * FROM pack_releases WHERE pack_id = ? AND version = ?')
    .bind(c.req.param('id'), c.req.param('version')).first<ReleaseRow>();
  if (!release || (release.status !== 'published' && release.status !== 'yanked')) throw notFound('Không tìm thấy bản phát hành.');
  if (release.status === 'yanked') throw new ApiError(410, 'gone', 'Bản này đã bị thu hồi. Hãy tải bản mới hơn.');
  const now = c.env.now();
  const recent = await c.env.db.prepare('SELECT COUNT(*) AS n FROM downloads WHERE user_id = ? AND at > ?')
    .bind(user.id, now - 3_600_000).first<{ n: number }>();
  if ((recent?.n ?? 0) >= DOWNLOADS_PER_HOUR) throw tooManyRequests(`Bạn đã tải ${DOWNLOADS_PER_HOUR} lượt trong một giờ. Hãy thử lại sau.`);
  await c.env.db.prepare('INSERT INTO downloads (user_id, release_id, at) VALUES (?, ?, ?)').bind(user.id, release.id, now).run();
  return c.json({
    url: await c.env.blobs.presignGet(release.r2_key, DOWNLOAD_URL_TTL_SEC),
    expiresAt: new Date(now + DOWNLOAD_URL_TTL_SEC * 1000).toISOString(),
    sha256: release.sha256,
    signature: release.signature,
    keyId: release.key_id,
    size: release.size,
  });
});
