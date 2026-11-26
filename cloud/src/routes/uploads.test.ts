import { describe, expect, it } from 'vitest';
import { errorCode, harness, type TestHarness } from '../../test/helpers';
import { runMaintenance } from '../services/maintenance';

const JPEG = (size: number) => { const b = new Uint8Array(size); b.set([0xff, 0xd8, 0xff, 0xe0]); return b; };
const PNG = (size: number) => { const b = new Uint8Array(size); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); return b; };
const MP4 = (size: number) => { const b = new Uint8Array(size); b.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]); return b; };
const MB = 1024 * 1024;

const keyOf = (url: string) => decodeURIComponent(new URL(url).pathname.slice(1));

interface Started { id: string; uploadUrl: string; headers: Record<string, string>; expiresAt: string }

async function start(h: TestHarness, token: string, json: { contentType: string; size: number; purpose: string }) {
  return h.call('POST', '/uploads', { token, json });
}

/** POST /uploads, "PUT" the bytes into the test bucket, then complete. */
async function upload(h: TestHarness, token: string, data: Uint8Array, contentType = 'image/jpeg', purpose = 'post-media', declared = data.length) {
  const res = await start(h, token, { contentType, size: declared, purpose });
  expect(res.status).toBe(201);
  const s = await res.json() as Started;
  await h.env.blobs.put(keyOf(s.uploadUrl), data, contentType);
  const done = await h.call('POST', `/uploads/${s.id}/complete`, { token });
  return { started: s, done };
}

async function setup(vars = {}) {
  const h = await harness({ vars });
  const a = await h.login({ sub: 'a', email: 'a@example.com' });
  const b = await h.login({ sub: 'b', email: 'b@example.com' });
  return { h, a, b };
}

describe('uploads', () => {
  it('rejects a file type outside the list before issuing an upload URL', async () => {
    const { h, a } = await setup();
    for (const contentType of ['image/gif', 'text/html', 'application/zip', 'image/svg+xml']) {
      const res = await start(h, a.token, { contentType, size: 100, purpose: 'post-media' });
      expect(res.status, contentType).toBe(400);
    }
    expect((await h.env.db.prepare('SELECT COUNT(*) AS n FROM uploads').first<{ n: number }>())!.n).toBe(0);
  });

  it('enforces 10 MB for images and 200 MB for videos', async () => {
    const { h, a } = await setup({ UPLOAD_QUOTA_BYTES: String(1024 * MB) });
    expect((await start(h, a.token, { contentType: 'image/png', size: 10 * MB + 1, purpose: 'post-media' })).status).toBe(400);
    expect((await start(h, a.token, { contentType: 'image/png', size: 10 * MB, purpose: 'post-media' })).status).toBe(201);
    expect((await start(h, a.token, { contentType: 'video/mp4', size: 200 * MB + 1, purpose: 'post-media' })).status).toBe(400);
    expect((await start(h, a.token, { contentType: 'video/mp4', size: 200 * MB, purpose: 'post-media' })).status).toBe(201);
    expect((await start(h, a.token, { contentType: 'video/mp4', size: 100, purpose: 'avatar' })).status).toBe(400);
  });

  it('uploads, completes with a 24-hour read URL, lists and deletes', async () => {
    const { h, a } = await setup();
    const { started, done } = await upload(h, a.token, JPEG(2048));
    expect(started.headers).toEqual({ 'content-type': 'image/jpeg', 'content-length': '2048' });
    expect(new Date(started.expiresAt).getTime() - h.clock.now).toBe(10 * 60_000);
    const key = keyOf(started.uploadUrl);
    expect(key).toBe(`u/${a.userId}/post-media/${started.id}.jpg`);
    expect(done.status).toBe(200);
    const body = await done.json() as { id: string; url: string; expiresAt: string };
    expect(keyOf(body.url)).toBe(key);
    expect(body.url).toContain('exp=86400');
    expect(new Date(body.expiresAt).getTime() - h.clock.now).toBe(24 * 3_600_000);

    const list = await (await h.call('GET', '/uploads?purpose=post-media', { token: a.token })).json() as { items: { id: string; status: string; size: number; deleteAt: string }[] };
    expect(list.items).toEqual([expect.objectContaining({ id: started.id, status: 'ready', size: 2048 })]);
    expect(new Date(list.items[0].deleteAt).getTime() - h.clock.now).toBe(7 * 24 * 3_600_000);

    expect((await h.call('DELETE', `/uploads/${started.id}`, { token: a.token })).status).toBe(200);
    expect(await h.env.blobs.head(key)).toBeNull();
    expect((await (await h.call('GET', '/uploads', { token: a.token })).json() as { items: unknown[] }).items).toHaveLength(0);
  });

  it('fails complete and deletes the object when 1 MB was declared but 5 MB uploaded', async () => {
    const { h, a } = await setup();
    const { started, done } = await upload(h, a.token, JPEG(5 * MB), 'image/jpeg', 'post-media', 1 * MB);
    expect(done.status).toBe(400);
    expect(await h.env.blobs.head(keyOf(started.uploadUrl))).toBeNull();
    const row = await h.env.db.prepare('SELECT status FROM uploads WHERE id = ?').bind(started.id).first<{ status: string }>();
    expect(row!.status).toBe('deleted');
  });

  it('fails complete when the bytes are not the declared type', async () => {
    const { h, a } = await setup();
    const { started, done } = await upload(h, a.token, JPEG(100), 'image/png');
    expect(done.status).toBe(400);
    expect(await h.env.blobs.head(keyOf(started.uploadUrl))).toBeNull();
    const fake = new TextEncoder().encode('<html>not an image</html>');
    expect((await upload(h, a.token, fake, 'image/jpeg')).done.status).toBe(400);
  });

  it('accepts png, webp and mp4 by their first bytes', async () => {
    const { h, a } = await setup();
    const webp = new Uint8Array(64); webp.set(new TextEncoder().encode('RIFF\0\0\0\0WEBP'));
    expect((await upload(h, a.token, PNG(64), 'image/png')).done.status).toBe(200);
    expect((await upload(h, a.token, webp, 'image/webp')).done.status).toBe(200);
    expect((await upload(h, a.token, MP4(64), 'video/mp4')).done.status).toBe(200);
  });

  it('refuses an upload past the quota, counting pending uploads', async () => {
    const { h, a, b } = await setup({ UPLOAD_QUOTA_BYTES: String(3 * MB) });
    expect((await start(h, a.token, { contentType: 'image/jpeg', size: 2 * MB, purpose: 'post-media' })).status).toBe(201);
    const over = await start(h, a.token, { contentType: 'image/jpeg', size: 2 * MB, purpose: 'post-media' });
    expect(over.status).toBe(403);
    expect(await errorCode(over)).toBe('quota_exceeded');
    expect((await start(h, a.token, { contentType: 'image/jpeg', size: 1 * MB, purpose: 'post-media' })).status).toBe(201);
    // Another user has their own quota.
    expect((await start(h, b.token, { contentType: 'image/jpeg', size: 2 * MB, purpose: 'post-media' })).status).toBe(201);
  });

  it('keeps users out of each other\'s files', async () => {
    const { h, a, b } = await setup();
    const { started } = await upload(h, a.token, JPEG(100));
    const pending = await (await start(h, a.token, { contentType: 'image/jpeg', size: 100, purpose: 'post-media' })).json() as Started;
    expect((await h.call('DELETE', `/uploads/${started.id}`, { token: b.token })).status).toBe(404);
    expect((await h.call('POST', `/uploads/${started.id}/complete`, { token: b.token })).status).toBe(404);
    expect((await h.call('POST', `/uploads/${pending.id}/complete`, { token: b.token })).status).toBe(404);
    expect((await (await h.call('GET', '/uploads', { token: b.token })).json() as { items: unknown[] }).items).toHaveLength(0);
    expect(await h.env.blobs.head(keyOf(started.uploadUrl))).not.toBeNull();
  });

  it('daily cleanup deletes expired post media and stale pending uploads, never avatars', async () => {
    const { h, a } = await setup();
    const post = await upload(h, a.token, JPEG(100));
    const avatar = await upload(h, a.token, PNG(100), 'image/png', 'avatar');
    const stale = await (await start(h, a.token, { contentType: 'image/jpeg', size: 100, purpose: 'post-media' })).json() as Started;
    await h.env.blobs.put(keyOf(stale.uploadUrl), JPEG(100));

    h.clock.now += 2 * 3_600_000;
    const fresh = await (await start(h, a.token, { contentType: 'image/jpeg', size: 100, purpose: 'post-media' })).json() as Started;
    expect((await runMaintenance(h.env)).uploads).toBe(1);
    expect(await h.env.blobs.head(keyOf(stale.uploadUrl))).toBeNull();
    expect(await h.env.blobs.head(keyOf(post.started.uploadUrl))).not.toBeNull();

    h.clock.now += 7 * 24 * 3_600_000;
    await runMaintenance(h.env);
    expect(await h.env.blobs.head(keyOf(post.started.uploadUrl))).toBeNull();
    expect(await h.env.blobs.head(keyOf(avatar.started.uploadUrl))).not.toBeNull();
    const status = async (id: string) => (await h.env.db.prepare('SELECT status FROM uploads WHERE id = ?').bind(id).first<{ status: string }>())?.status;
    expect(await status(post.started.id)).toBe('deleted');
    expect(await status(fresh.id)).toBe('deleted');
    expect(await status(avatar.started.id)).toBe('ready');
  });

  it('replaces the old avatar with the new one', async () => {
    const { h, a } = await setup();
    const first = await upload(h, a.token, PNG(100), 'image/png', 'avatar');
    const second = await upload(h, a.token, JPEG(100), 'image/jpeg', 'avatar');
    expect(second.done.status).toBe(200);
    expect(await h.env.blobs.head(keyOf(first.started.uploadUrl))).toBeNull();
    expect(await h.env.blobs.head(keyOf(second.started.uploadUrl))).not.toBeNull();
  });

  it('lets only admins upload pack covers, and a new cover replaces the old', async () => {
    const h = await harness();
    const admin = await h.login({ sub: 'boss', email: 'boss@example.com' });
    const user = await h.login({ sub: 'u', email: 'u@example.com' });
    expect((await start(h, user.token, { contentType: 'image/png', size: 100, purpose: 'pack-cover' })).status).toBe(403);
    await h.call('POST', '/admin/packs', { token: admin.token, json: { id: 'goi-mau', module: 'learn', name: 'Gói mẫu' } });
    const c1 = await upload(h, admin.token, PNG(100), 'image/png', 'pack-cover');
    const set1 = await h.call('PATCH', '/admin/packs/goi-mau', { token: admin.token, json: { coverUploadId: c1.started.id } });
    expect(keyOf((await set1.json() as { coverUrl: string }).coverUrl)).toBe(keyOf(c1.started.uploadUrl));
    const c2 = await upload(h, admin.token, PNG(100), 'image/png', 'pack-cover');
    await h.call('PATCH', '/admin/packs/goi-mau', { token: admin.token, json: { coverUploadId: c2.started.id } });
    expect(await h.env.blobs.head(keyOf(c1.started.uploadUrl))).toBeNull();
    expect(await h.env.blobs.head(keyOf(c2.started.uploadUrl))).not.toBeNull();
    expect((await h.call('PATCH', '/admin/packs/goi-mau', { token: admin.token, json: { coverUploadId: 'upl_nope' } })).status).toBe(400);
  });

  it('DELETE /me removes every object under u/<userId>/ and nobody else\'s', async () => {
    const { h, a, b } = await setup();
    const mine = await upload(h, a.token, JPEG(100));
    const avatar = await upload(h, a.token, PNG(100), 'image/png', 'avatar');
    const theirs = await upload(h, b.token, JPEG(100));
    await h.env.blobs.put(`u/${a.userId}/post-media/stray.jpg`, JPEG(10));
    expect((await h.call('DELETE', '/me', { token: a.token })).status).toBe(200);
    expect((await h.env.blobs.list(`u/${a.userId}/`)).keys).toEqual([]);
    expect(await h.env.blobs.head(keyOf(mine.started.uploadUrl))).toBeNull();
    expect(await h.env.blobs.head(keyOf(avatar.started.uploadUrl))).toBeNull();
    expect(await h.env.blobs.head(keyOf(theirs.started.uploadUrl))).not.toBeNull();
    expect((await h.env.db.prepare('SELECT COUNT(*) AS n FROM uploads WHERE user_id = ?').bind(a.userId).first<{ n: number }>())!.n).toBe(0);
  });

  it('needs a session', async () => {
    const { h } = await setup();
    expect((await h.call('POST', '/uploads', { json: { contentType: 'image/jpeg', size: 1, purpose: 'post-media' } })).status).toBe(401);
  });
});
