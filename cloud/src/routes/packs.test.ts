import { describe, expect, it } from 'vitest';
import { errorCode, harness, type TestHarness } from '../../test/helpers';
import { goodPack, makeSigner, note, rawPack, type Signer } from '../../test/packs';
import { incomingKey } from '../db/packs';
import { sha256Hex } from '../lib/encoding';

/** The test presigner returns https://r2.test/<key>?put; "uploading" writes that key into the test bucket. */
async function putTo(h: TestHarness, url: string, data: Uint8Array) {
  const key = decodeURIComponent(new URL(url).pathname.slice(1));
  await h.env.blobs.put(key, data, 'application/zip');
}

async function setup() {
  const signer = await makeSigner();
  const h = await harness({ vars: { PACK_SIGNING_KEYS: JSON.stringify({ [signer.keyId]: signer.publicKey }) } });
  const admin = await h.login({ sub: 'boss', email: 'boss@example.com' });
  const user = await h.login({ sub: 'lan', email: 'lan@example.com' });
  return { h, signer, admin: admin.token, user: user.token, userId: user.userId };
}

async function createPack(h: TestHarness, admin: string, id = 'tra-va-qua-tang-co-ban', extra: Record<string, unknown> = {}) {
  const res = await h.call('POST', '/admin/packs', { token: admin, json: { id, module: 'learn', name: 'Trà', industry: 'tra', ...extra } });
  expect(res.status).toBe(201);
}

/** create release → upload → finalize → publish. Returns the finalize and publish responses. */
async function release(h: TestHarness, admin: string, signer: Signer, zip: Uint8Array, version = '1.0.0', id = 'tra-va-qua-tang-co-ban') {
  const created = await h.call('POST', `/admin/packs/${id}/releases`, { token: admin, json: { version, size: zip.length } });
  expect(created.status).toBe(201);
  const { releaseId, uploadUrl, headers } = await created.json() as { releaseId: string; uploadUrl: string; headers: Record<string, string> };
  expect(headers).toEqual({ 'content-type': 'application/zip', 'content-length': String(zip.length) });
  await putTo(h, uploadUrl, zip);
  const finalize = await h.call('POST', `/admin/releases/${releaseId}/finalize`, { token: admin });
  if (finalize.status !== 200) return { releaseId, finalize, publish: null };
  const signature = await signer.sign(id, version, await sha256Hex(zip));
  const publish = await h.call('POST', `/admin/releases/${releaseId}/publish`, { token: admin, json: { signature, keyId: signer.keyId } });
  return { releaseId, finalize, publish };
}

describe('pack store', () => {
  it('runs a valid pack through create, upload, finalize, publish, list and download', async () => {
    const { h, signer, admin, user } = await setup();
    await createPack(h, admin);
    const { zip } = await goodPack();
    const { finalize, publish } = await release(h, admin, signer, zip);
    expect(finalize.status).toBe(200);
    expect(await finalize.json()).toMatchObject({ status: 'draft', notesCount: 2, sha256: await sha256Hex(zip) });
    expect(publish!.status).toBe(200);
    expect(await publish!.json()).toMatchObject({ status: 'published', keyId: signer.keyId });

    const list = await (await h.call('GET', '/packs?module=learn', { token: user })).json() as { items: { id: string; name: string; latest: { version: string; license: string } }[] };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ id: 'tra-va-qua-tang-co-ban', name: 'Trà và quà tặng: bộ khởi đầu', latest: { version: '1.0.0', license: 'CC-BY-4.0' } });
    expect((await (await h.call('GET', '/packs?q=TRÀ', { token: user })).json() as { items: unknown[] }).items).toHaveLength(1);
    expect((await (await h.call('GET', '/packs?module=dream', { token: user })).json() as { items: unknown[] }).items).toHaveLength(0);

    const detail = await (await h.call('GET', '/packs/tra-va-qua-tang-co-ban', { token: user })).json() as { license: string; files: { path: string; loai: string | null }[] };
    expect(detail.license).toBe('CC-BY-4.0');
    expect(detail.files.map((f) => f.path)).toContain('notes/bai-hoc/video-huong-dan-ngan.md');

    const dl = await h.call('POST', '/packs/tra-va-qua-tang-co-ban/releases/1.0.0/download', { token: user });
    expect(dl.status).toBe(200);
    const body = await dl.json() as { url: string; sha256: string; signature: string; keyId: string; size: number; expiresAt: string };
    expect(body).toMatchObject({ sha256: await sha256Hex(zip), keyId: signer.keyId, size: zip.length });
    expect(new Date(body.expiresAt).getTime() - h.clock.now).toBe(5 * 60_000);
    const stored = await h.env.blobs.get(decodeURIComponent(new URL(body.url).pathname.slice(1)));
    expect(await sha256Hex(stored!)).toBe(body.sha256);
    // The upload landed in incoming/ and was moved; nothing is left there.
    expect((await h.env.blobs.list('incoming/')).keys).toEqual([]);
  });

  it('rejects publish with a wrong signature, an unknown key, or another pack\'s signature', async () => {
    const { h, signer, admin } = await setup();
    await createPack(h, admin);
    const { zip } = await goodPack();
    const created = await (await h.call('POST', '/admin/packs/tra-va-qua-tang-co-ban/releases', { token: admin, json: { version: '1.0.0', size: zip.length } })).json() as { releaseId: string; uploadUrl: string };
    await putTo(h, created.uploadUrl, zip);
    expect((await h.call('POST', `/admin/releases/${created.releaseId}/finalize`, { token: admin })).status).toBe(200);
    const sha = await sha256Hex(zip);
    const other = await makeSigner('k-other');
    for (const json of [
      { signature: await other.sign('tra-va-qua-tang-co-ban', '1.0.0', sha), keyId: signer.keyId },
      { signature: await signer.sign('tra-va-qua-tang-co-ban', '1.0.0', sha), keyId: 'unknown' },
      { signature: await signer.sign('goi-khac', '1.0.0', sha), keyId: signer.keyId },
      { signature: await signer.sign('tra-va-qua-tang-co-ban', '1.0.1', sha), keyId: signer.keyId },
      { signature: 'not-base64!!', keyId: signer.keyId },
    ]) {
      const res = await h.call('POST', `/admin/releases/${created.releaseId}/publish`, { token: admin, json });
      expect(res.status).toBe(400);
    }
    const list = await (await h.call('GET', '/packs', { token: admin })).json() as { items: unknown[] };
    expect(list.items).toHaveLength(0);
  });

  it('rejects a zip with notes/../../x.md at finalize, deletes the upload and names the file', async () => {
    const { h, signer, admin } = await setup();
    await createPack(h, admin);
    const zip = await rawPack({ 'notes/../../x.md': note('bai-hoc') }, { manifest: { version: '1.0.0' } });
    const { releaseId, finalize } = await release(h, admin, signer, zip);
    expect(finalize.status).toBe(400);
    const err = await finalize.json() as { error: { code: string; message: string; details: { file: string } } };
    expect(err.error.details.file).toBe('notes/../../x.md');
    expect(err.error.message).toContain('notes/../../x.md');
    expect(await h.env.blobs.head(incomingKey(releaseId))).toBeNull();
    // The version is free again for a corrected upload.
    const { zip: fixed } = await goodPack();
    expect((await release(h, admin, signer, fixed)).publish!.status).toBe(200);
  });

  it.each([
    ['an undeclared file', () => rawPack({ 'notes/a.md': note('bai-hoc'), 'notes/b.md': note('bai-hoc') }, { declare: [{ path: 'notes/a.md', loai: 'bai-hoc' }] }), 'notes/b.md'],
    ['a SHA-256 mismatch', () => rawPack({ 'notes/a.md': note('bai-hoc') }, { declare: [{ path: 'notes/a.md', loai: 'bai-hoc', sha256: 'f'.repeat(64) }] }), 'notes/a.md'],
    ['a customer note in a learn pack', () => rawPack({ 'notes/khach-hang/chi-lan.md': note('khach-hang') }), 'notes/khach-hang/chi-lan.md'],
  ])('rejects %s at finalize', async (_name, make, file) => {
    const { h, signer, admin } = await setup();
    await createPack(h, admin);
    const { finalize, publish } = await release(h, admin, signer, await make());
    expect(finalize.status).toBe(400);
    expect(publish).toBeNull();
    expect((await finalize.json() as { error: { details: { file: string } } }).error.details.file).toBe(file);
  });

  it('keeps a published release immutable', async () => {
    const { h, signer, admin } = await setup();
    await createPack(h, admin);
    const { zip } = await goodPack();
    const { releaseId } = await release(h, admin, signer, zip);
    expect((await h.call('POST', `/admin/releases/${releaseId}/finalize`, { token: admin })).status).toBe(409);
    expect((await h.call('POST', `/admin/releases/${releaseId}/publish`, { token: admin, json: { signature: 'x', keyId: 'k' } })).status).toBe(409);
    const again = await h.call('POST', '/admin/packs/tra-va-qua-tang-co-ban/releases', { token: admin, json: { version: '1.0.0', size: 10 } });
    expect(again.status).toBe(409);
  });

  it('does not let a normal user call admin routes', async () => {
    const { h, user } = await setup();
    const calls: [string, string, unknown][] = [
      ['POST', '/admin/packs', { id: 'x-pack', module: 'learn', name: 'x' }],
      ['PATCH', '/admin/packs/x-pack', { name: 'y' }],
      ['POST', '/admin/packs/x-pack/releases', { version: '1.0.0', size: 10 }],
      ['POST', '/admin/releases/rel_x/finalize', undefined],
      ['POST', '/admin/releases/rel_x/publish', { signature: 'a', keyId: 'b' }],
      ['POST', '/admin/releases/rel_x/yank', undefined],
    ];
    for (const [method, path, json] of calls) {
      const res = await h.call(method, path, { token: user, json });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });

  it('hides a yanked release from /packs but warns holders in /packs/updates', async () => {
    const { h, signer, admin, user } = await setup();
    await createPack(h, admin);
    const v1 = await release(h, admin, signer, (await goodPack()).zip, '1.0.0');
    expect((await h.call('POST', `/admin/releases/${v1.releaseId}/yank`, { token: admin })).status).toBe(200);
    expect((await (await h.call('GET', '/packs', { token: user })).json() as { items: unknown[] }).items).toHaveLength(0);
    const updates = await (await h.call('GET', '/packs/updates?have=tra-va-qua-tang-co-ban@1.0.0', { token: user })).json() as { items: { yanked: boolean; update: boolean; warning: string }[] };
    expect(updates.items).toEqual([expect.objectContaining({ id: 'tra-va-qua-tang-co-ban', have: '1.0.0', yanked: true, update: false, latest: null })]);
    expect(updates.items[0].warning).toContain('thu hồi');
    expect((await h.call('POST', '/packs/tra-va-qua-tang-co-ban/releases/1.0.0/download', { token: user })).status).toBe(410);

    await release(h, admin, signer, (await goodPack({ version: '1.1.0' })).zip, '1.1.0');
    const after = await (await h.call('GET', '/packs/updates?have=tra-va-qua-tang-co-ban@1.0.0,khong-co@1.0.0', { token: user })).json() as { items: unknown[] };
    expect(after.items).toEqual([expect.objectContaining({ latest: '1.1.0', update: true, yanked: true })]);
    const current = await (await h.call('GET', '/packs/updates?have=tra-va-qua-tang-co-ban@1.1.0', { token: user })).json() as { items: unknown[] };
    expect(current.items).toEqual([]);
    expect((await h.call('GET', '/packs/updates?have=bad', { token: user })).status).toBe(400);
  });

  it('keeps unlisted packs out of the list but reachable by id', async () => {
    const { h, signer, admin, user } = await setup();
    await createPack(h, admin, 'tra-va-qua-tang-co-ban', { visibility: 'unlisted' });
    await release(h, admin, signer, (await goodPack()).zip);
    expect((await (await h.call('GET', '/packs', { token: user })).json() as { items: unknown[] }).items).toHaveLength(0);
    expect((await h.call('GET', '/packs/tra-va-qua-tang-co-ban', { token: user })).status).toBe(200);
  });

  it('hides drafts from normal users', async () => {
    const { h, admin, user } = await setup();
    await createPack(h, admin);
    expect((await h.call('GET', '/packs/tra-va-qua-tang-co-ban', { token: user })).status).toBe(404);
    expect((await h.call('GET', '/packs/tra-va-qua-tang-co-ban', { token: admin })).status).toBe(200);
    expect((await h.call('POST', '/packs/tra-va-qua-tang-co-ban/releases/1.0.0/download', { token: user })).status).toBe(404);
  });

  it('records each download and caps a user at 60 per hour', async () => {
    const { h, signer, admin, user, userId } = await setup();
    await createPack(h, admin);
    await release(h, admin, signer, (await goodPack()).zip);
    const path = '/packs/tra-va-qua-tang-co-ban/releases/1.0.0/download';
    for (let i = 0; i < 60; i++) expect((await h.call('POST', path, { token: user })).status).toBe(200);
    const blocked = await h.call('POST', path, { token: user });
    expect(blocked.status).toBe(429);
    expect(await errorCode(blocked)).toBe('rate_limited');
    expect((await h.env.db.prepare('SELECT COUNT(*) AS n FROM downloads WHERE user_id = ?').bind(userId).first<{ n: number }>())!.n).toBe(60);
    expect((await h.call('POST', path, { token: admin })).status).toBe(200);
    h.clock.now += 3_600_001;
    expect((await h.call('POST', path, { token: user })).status).toBe(200);
  });

  it('requires a signed-in user to browse', async () => {
    const { h } = await setup();
    expect((await h.call('GET', '/packs')).status).toBe(401);
  });

  it('refuses a release bigger than 20 MB before issuing an upload URL', async () => {
    const { h, admin } = await setup();
    await createPack(h, admin);
    const res = await h.call('POST', '/admin/packs/tra-va-qua-tang-co-ban/releases', { token: admin, json: { version: '1.0.0', size: 20 * 1024 * 1024 + 1 } });
    expect(res.status).toBe(400);
  });
});
