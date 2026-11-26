/**
 * The app (mobile/) types what it reads from packages/api-types. Those types are
 * erased at run time, so this test checks the real responses carry exactly the
 * keys the types declare: a field added, renamed or dropped in a route fails
 * here (and in `npm run typecheck`, where the routes are annotated with the types).
 *
 * Each `Record<keyof T, true>` below stops compiling when T gains or loses a key,
 * so the key lists cannot drift from the types either.
 */
import { describe, expect, it } from 'vitest';
import type {
  ApiPack, ApiRelease, ApiSession, ApiUser, AuthResponse, MeResponse, PackDetail, PackFile, PackListItem, PackListResponse,
} from '../../../packages/api-types/src/index';
import { harness, idToken, type TestHarness } from '../../test/helpers';
import { goodPack, makeSigner, type Signer } from '../../test/packs';
import { sha256Hex } from '../lib/encoding';

const keys = <T extends object>(spec: Record<keyof T, true>): string[] => Object.keys(spec).sort();

const USER = keys<ApiUser>({ id: true, email: true, name: true, avatarUrl: true, role: true, status: true, createdAt: true, lastSeenAt: true });
const SESSION = keys<ApiSession>({ id: true, kind: true, label: true, createdAt: true, expiresAt: true, current: true });
const AUTH = keys<AuthResponse>({ token: true, user: true, session: true });
const ME = keys<MeResponse>({ user: true, sessions: true });
const RELEASE = keys<ApiRelease>({
  id: true, version: true, status: true, size: true, sha256: true, notesCount: true, keyId: true, minAppVersion: true,
  license: true, author: true, createdAt: true, publishedAt: true, yankedAt: true,
});
const PACK = keys<ApiPack>({ id: true, module: true, name: true, summary: true, industry: true, visibility: true, coverUrl: true, createdAt: true, updatedAt: true });
const LIST_ITEM = keys<PackListItem>({ ...Object.fromEntries(PACK.map((k) => [k, true])) as Record<keyof ApiPack, true>, latest: true });
const LIST = keys<PackListResponse>({ items: true });
const FILE = keys<PackFile>({ path: true, loai: true, sha256: true });
const DETAIL = keys<PackDetail>({
  ...Object.fromEntries(PACK.map((k) => [k, true])) as Record<keyof ApiPack, true>,
  license: true, author: true, latest: true, releases: true, files: true,
});

const sorted = (o: unknown) => Object.keys(o as object).sort();

async function publishSample(h: TestHarness, admin: string, signer: Signer) {
  expect((await h.call('POST', '/admin/packs', { token: admin, json: { id: 'tra-va-qua-tang-co-ban', module: 'learn', name: 'Trà', industry: 'tra' } })).status).toBe(201);
  const { zip } = await goodPack();
  const created = await (await h.call('POST', '/admin/packs/tra-va-qua-tang-co-ban/releases', { token: admin, json: { version: '1.0.0', size: zip.length } })).json() as { releaseId: string; uploadUrl: string };
  await h.env.blobs.put(decodeURIComponent(new URL(created.uploadUrl).pathname.slice(1)), zip, 'application/zip');
  expect((await h.call('POST', `/admin/releases/${created.releaseId}/finalize`, { token: admin })).status).toBe(200);
  const signature = await signer.sign('tra-va-qua-tang-co-ban', '1.0.0', await sha256Hex(zip));
  expect((await h.call('POST', `/admin/releases/${created.releaseId}/publish`, { token: admin, json: { signature, keyId: signer.keyId } })).status).toBe(200);
}

describe('API contract with packages/api-types', () => {
  it('sign-in, /me and the pack store answer with the declared keys', async () => {
    const signer = await makeSigner();
    const h = await harness({ vars: { PACK_SIGNING_KEYS: JSON.stringify({ [signer.keyId]: signer.publicKey }) } });
    const admin = (await h.login({ sub: 'boss', email: 'boss@example.com' })).token;
    await publishSample(h, admin, signer);

    const token = await idToken({ sub: 'lan', email: 'lan@example.com' }, { now: h.clock.now });
    const signIn = await h.call('POST', '/auth/google', { json: { idToken: token, kind: 'mobile', label: 'iPhone' } });
    expect(signIn.status).toBe(200);
    const auth = await signIn.json() as AuthResponse;
    expect(sorted(auth)).toEqual(AUTH);
    expect(sorted(auth.user)).toEqual(USER);
    expect(sorted(auth.session)).toEqual(SESSION);

    const me = await (await h.call('GET', '/me', { token: auth.token })).json() as MeResponse;
    expect(sorted(me)).toEqual(ME);
    expect(sorted(me.user)).toEqual(USER);
    expect(me.sessions.length).toBeGreaterThan(0);
    for (const s of me.sessions) expect(sorted(s)).toEqual(SESSION);

    const list = await (await h.call('GET', '/packs', { token: auth.token })).json() as PackListResponse;
    expect(sorted(list)).toEqual(LIST);
    expect(list.items).toHaveLength(1);
    expect(sorted(list.items[0])).toEqual(LIST_ITEM);
    expect(sorted(list.items[0].latest)).toEqual(RELEASE);

    const detail = await (await h.call('GET', '/packs/tra-va-qua-tang-co-ban', { token: auth.token })).json() as PackDetail;
    expect(sorted(detail)).toEqual(DETAIL);
    expect(sorted(detail.latest)).toEqual(RELEASE);
    expect(detail.releases.length).toBeGreaterThan(0);
    for (const r of detail.releases) expect(sorted(r)).toEqual(RELEASE);
    expect(detail.files.length).toBeGreaterThan(0);
    for (const f of detail.files) expect(sorted(f)).toEqual(FILE);
  });
});
