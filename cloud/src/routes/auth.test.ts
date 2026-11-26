import { describe, expect, it } from 'vitest';
import { GOOGLE_CLIENT_ID, errorCode, harness, idToken, type TestHarness } from '../../test/helpers';
import { LAST_SEEN_EVERY_MS, SESSION_TTL_MS } from '../auth/session';

const RETURN = 'http://127.0.0.1:4380/cloud/callback';

/** Runs /auth/web/start and returns the Google redirect's parameters. */
async function start(h: TestHarness, returnUrl = RETURN, state = 'app-state-123') {
  const res = await h.call('GET', `/auth/web/start?return=${encodeURIComponent(returnUrl)}&state=${state}`);
  return res;
}

/** A fake Google token endpoint that returns an ID token carrying the nonce it was asked for. */
function fakeGoogle(h: () => TestHarness, claims: Parameters<typeof idToken>[0] = {}) {
  const calls: URLSearchParams[] = [];
  let nonce = '';
  return {
    calls,
    setNonce: (n: string) => { nonce = n; },
    fetch: async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://oauth2.googleapis.com/token');
      calls.push(new URLSearchParams(String(init?.body)));
      return Response.json({ id_token: await idToken({ ...claims, nonce }, { now: h().clock.now }), access_token: 'unused' });
    },
  };
}

async function webLogin(h: TestHarness, google: ReturnType<typeof fakeGoogle>, state = 'app-state-123') {
  const startRes = await start(h, RETURN, state);
  expect(startRes.status).toBe(302);
  const googleUrl = new URL(startRes.headers.get('location')!);
  google.setNonce(googleUrl.searchParams.get('nonce')!);
  const cb = await h.call('GET', `/auth/web/callback?code=google-code&state=${googleUrl.searchParams.get('state')}`);
  expect(cb.status).toBe(302);
  return { googleUrl, back: new URL(cb.headers.get('location')!) };
}

describe('POST /auth/google', () => {
  it('creates a user and a session for a valid ID token', async () => {
    const h = await harness();
    const res = await h.call('POST', '/auth/google', { json: { idToken: await idToken(), kind: 'mobile', label: 'iPhone' } });
    expect(res.status).toBe(200);
    const body = await res.json() as { token: string; user: { email: string; role: string }; session: { kind: string; expiresAt: string } };
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.user).toMatchObject({ email: 'lan@example.com', role: 'user' });
    expect(new Date(body.session.expiresAt).getTime() - h.clock.now).toBe(SESSION_TTL_MS.mobile);
    const me = await h.call('GET', '/me', { token: body.token });
    expect(me.status).toBe(200);
  });

  it('stores only the SHA-256 of the session token', async () => {
    const h = await harness();
    const { token } = await h.login();
    const rows = await h.env.db.prepare('SELECT token_hash FROM sessions').all<{ token_hash: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0].token_hash).not.toContain(token);
    expect(rows.results[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['a foreign signature', () => idToken({}, { foreignKey: true })],
    ['a wrong audience', () => idToken({ aud: 'other.apps.googleusercontent.com' })],
    ['an expired token', () => idToken({}, { now: Date.UTC(2026, 10, 25) })],
    ['an unverified email', () => idToken({ email_verified: false })],
  ])('rejects %s', async (_name, make) => {
    const h = await harness();
    const res = await h.call('POST', '/auth/google', { json: { idToken: await make(), kind: 'mobile' } });
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('unauthorized');
    expect((await h.env.db.prepare('SELECT COUNT(*) AS n FROM sessions').first<{ n: number }>())!.n).toBe(0);
  });

  it('rejects an unknown session kind', async () => {
    const h = await harness();
    const res = await h.call('POST', '/auth/google', { json: { idToken: await idToken(), kind: 'tv' } });
    expect(res.status).toBe(400);
  });

  it('keeps one user when the same Google account signs in again with a new email', async () => {
    const h = await harness();
    const first = await h.login({ email: 'old@example.com' });
    const second = await h.login({ email: 'new@example.com', name: 'Lan mới' });
    expect(second.userId).toBe(first.userId);
    const users = await h.env.db.prepare('SELECT id, email, name FROM users').all();
    expect(users.results).toEqual([{ id: first.userId, email: 'new@example.com', name: 'Lan mới' }]);
  });

  it('makes a different Google account with the same email a different user', async () => {
    const h = await harness();
    const a = await h.login({ sub: 'sub-a', email: 'same@example.com' });
    const b = await h.login({ sub: 'sub-b', email: 'same@example.com' });
    expect(a.userId).not.toBe(b.userId);
  });

  it('makes an ADMIN_EMAILS address an admin', async () => {
    const h = await harness();
    const res = await h.call('POST', '/auth/google', { json: { idToken: await idToken({ email: 'Boss@Example.com', sub: 'boss' }), kind: 'web' } });
    expect((await res.json() as { user: { role: string } }).user.role).toBe('admin');
  });

  it('refuses a disabled user with 403', async () => {
    const h = await harness();
    const { userId } = await h.login();
    await h.env.db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(userId).run();
    const res = await h.call('POST', '/auth/google', { json: { idToken: await idToken(), kind: 'mobile' } });
    expect(res.status).toBe(403);
  });
});

describe('sessions', () => {
  it('expire: web after 12 hours, machine after 90 days', async () => {
    const h = await harness();
    const web = await h.login({}, 'web');
    const machine = await h.login({}, 'machine');
    h.clock.now += SESSION_TTL_MS.web + 1;
    expect((await h.call('GET', '/me', { token: web.token })).status).toBe(401);
    expect((await h.call('GET', '/me', { token: machine.token })).status).toBe(200);
    h.clock.now += SESSION_TTL_MS.machine;
    expect((await h.call('GET', '/me', { token: machine.token })).status).toBe(401);
  });

  it('writes last_seen_at at most once every 5 minutes', async () => {
    const h = await harness();
    const { token, userId } = await h.login();
    const seen = async () => (await h.env.db.prepare('SELECT last_seen_at FROM users WHERE id = ?').bind(userId).first<{ last_seen_at: number }>())!.last_seen_at;
    await h.call('GET', '/me', { token });
    const first = await seen();
    expect(first).toBe(h.clock.now);
    h.clock.now += LAST_SEEN_EVERY_MS - 1000;
    await h.call('GET', '/me', { token });
    expect(await seen()).toBe(first);
    h.clock.now += 2000;
    await h.call('GET', '/me', { token });
    expect(await seen()).toBe(h.clock.now);
  });

  it('rejects a missing or unknown token', async () => {
    const h = await harness();
    expect((await h.call('GET', '/me')).status).toBe(401);
    expect((await h.call('GET', '/me', { token: 'nope' })).status).toBe(401);
  });

  it('logout revokes only the current session', async () => {
    const h = await harness();
    const a = await h.login();
    const b = await h.login();
    expect(await (await h.call('POST', '/auth/logout', { token: a.token })).json()).toEqual({ ok: true });
    expect((await h.call('GET', '/me', { token: a.token })).status).toBe(401);
    expect((await h.call('GET', '/me', { token: b.token })).status).toBe(200);
  });
});

describe('desktop sign-in (/auth/web/*)', () => {
  it('goes start → Google → callback → exchange and yields a machine session', async () => {
    let h!: TestHarness;
    const google = fakeGoogle(() => h);
    h = await harness({ fetch: google.fetch });
    const { googleUrl, back } = await webLogin(h, google);

    expect(googleUrl.origin + googleUrl.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(googleUrl.searchParams.get('client_id')).toBe(GOOGLE_CLIENT_ID);
    expect(googleUrl.searchParams.get('redirect_uri')).toBe('https://cloud.test/auth/web/callback');
    expect(googleUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(google.calls[0].get('code_verifier')).toBeTruthy();
    expect(google.calls[0].get('client_secret')).toBe('test-secret');

    expect(back.origin + back.pathname).toBe(RETURN);
    expect(back.searchParams.get('state')).toBe('app-state-123');
    const code = back.searchParams.get('code')!;
    const res = await h.call('POST', '/auth/exchange', { json: { code, state: 'app-state-123', label: 'Máy ở tiệm' } });
    expect(res.status).toBe(200);
    const body = await res.json() as { token: string; session: { kind: string; label: string } };
    expect(body.session).toMatchObject({ kind: 'machine', label: 'Máy ở tiệm' });
    expect((await h.call('GET', '/me', { token: body.token })).status).toBe(200);
  });

  it.each([
    'https://evil.example.com/cb',
    'http://evil.example.com:4380/cb',
    'http://127.0.0.1.evil.com:4380/cb',
    'http://127.0.0.1/cb',
    'https://127.0.0.1:4380/cb',
    'http://user:pw@127.0.0.1:4380/cb',
    'javascript:alert(1)',
  ])('rejects return=%s', async (url) => {
    const h = await harness();
    const res = await start(h, url);
    expect(res.status).toBe(400);
    expect((await h.env.db.prepare('SELECT COUNT(*) AS n FROM oauth_pending').first<{ n: number }>())!.n).toBe(0);
  });

  it('accepts localhost with a port', async () => {
    const h = await harness();
    expect((await start(h, 'http://localhost:5173/x?y=1')).status).toBe(302);
  });

  it('requires a usable state', async () => {
    const h = await harness();
    expect((await start(h, RETURN, 'short')).status).toBe(400);
  });

  it('refuses a one-time code used twice', async () => {
    let h!: TestHarness;
    const google = fakeGoogle(() => h);
    h = await harness({ fetch: google.fetch });
    const { back } = await webLogin(h, google);
    const code = back.searchParams.get('code')!;
    expect((await h.call('POST', '/auth/exchange', { json: { code, state: 'app-state-123' } })).status).toBe(200);
    const again = await h.call('POST', '/auth/exchange', { json: { code, state: 'app-state-123' } });
    expect(again.status).toBe(401);
  });

  it('refuses a code with the wrong state, and burns it', async () => {
    let h!: TestHarness;
    const google = fakeGoogle(() => h);
    h = await harness({ fetch: google.fetch });
    const { back } = await webLogin(h, google);
    const code = back.searchParams.get('code')!;
    expect((await h.call('POST', '/auth/exchange', { json: { code, state: 'other-state-xyz' } })).status).toBe(401);
    expect((await h.call('POST', '/auth/exchange', { json: { code, state: 'app-state-123' } })).status).toBe(401);
  });

  it('refuses a code older than 2 minutes', async () => {
    let h!: TestHarness;
    const google = fakeGoogle(() => h);
    h = await harness({ fetch: google.fetch });
    const { back } = await webLogin(h, google);
    h.clock.now += 2 * 60_000 + 1;
    const res = await h.call('POST', '/auth/exchange', { json: { code: back.searchParams.get('code'), state: 'app-state-123' } });
    expect(res.status).toBe(401);
  });

  it('refuses a callback whose state was already used', async () => {
    let h!: TestHarness;
    const google = fakeGoogle(() => h);
    h = await harness({ fetch: google.fetch });
    const startRes = await start(h);
    const googleUrl = new URL(startRes.headers.get('location')!);
    google.setNonce(googleUrl.searchParams.get('nonce')!);
    const path = `/auth/web/callback?code=c&state=${googleUrl.searchParams.get('state')}`;
    expect((await h.call('GET', path)).status).toBe(302);
    expect((await h.call('GET', path)).status).toBe(400);
  });

  it('refuses an ID token whose nonce does not match the login', async () => {
    let h!: TestHarness;
    const google = fakeGoogle(() => h);
    h = await harness({ fetch: google.fetch });
    const startRes = await start(h);
    const googleUrl = new URL(startRes.headers.get('location')!);
    google.setNonce('replayed-nonce');
    const cb = await h.call('GET', `/auth/web/callback?code=c&state=${googleUrl.searchParams.get('state')}`);
    const back = new URL(cb.headers.get('location')!);
    expect(back.searchParams.get('error')).toBe('invalid_token');
    expect(back.searchParams.get('code')).toBeNull();
  });

  it('sends a disabled user back with an error and no code', async () => {
    let h!: TestHarness;
    const google = fakeGoogle(() => h);
    h = await harness({ fetch: google.fetch });
    const { userId } = await h.login();
    await h.env.db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(userId).run();
    const { back } = await webLogin(h, google);
    expect(back.searchParams.get('error')).toBe('account_disabled');
    expect(back.searchParams.get('code')).toBeNull();
  });

  it('never logs session tokens, ID tokens or one-time codes', async () => {
    let h!: TestHarness;
    const google = fakeGoogle(() => h);
    h = await harness({ fetch: google.fetch });
    const { back } = await webLogin(h, google);
    const code = back.searchParams.get('code')!;
    const res = await h.call('POST', '/auth/exchange', { json: { code, state: 'app-state-123' } });
    const { token } = await res.json() as { token: string };
    const direct = await idToken();
    await h.call('POST', '/auth/google', { json: { idToken: direct, kind: 'mobile' } });
    const all = h.logs.join('\n');
    expect(h.logs.length).toBeGreaterThan(0);
    for (const secret of [code, token, direct, 'test-secret']) expect(all).not.toContain(secret);
  });
});

describe('rate limit on /auth/*', () => {
  it('returns 429 after the limit for one IP, other IPs unaffected', async () => {
    const h = await harness({ vars: { AUTH_RATE_LIMIT: '3' } });
    const ip = { 'cf-connecting-ip': '203.0.113.7' };
    for (let i = 0; i < 3; i++) expect((await h.call('POST', '/auth/exchange', { json: { code: 'x', state: 'y' }, headers: ip })).status).toBe(401);
    const blocked = await h.call('POST', '/auth/exchange', { json: { code: 'x', state: 'y' }, headers: ip });
    expect(blocked.status).toBe(429);
    expect(await errorCode(blocked)).toBe('rate_limited');
    expect((await h.call('POST', '/auth/exchange', { json: { code: 'x', state: 'y' }, headers: { 'cf-connecting-ip': '203.0.113.8' } })).status).toBe(401);
    h.clock.now += 60_000;
    expect((await h.call('POST', '/auth/exchange', { json: { code: 'x', state: 'y' }, headers: ip })).status).toBe(401);
  });
});

describe('POST /auth/dev', () => {
  it('does not exist unless DEV_MODE is on and the request is local', async () => {
    const off = await harness();
    expect((await off.call('POST', 'http://127.0.0.1:8787/auth/dev', { json: { email: 'a@b.co' } })).status).toBe(404);
    const on = await harness({ vars: { DEV_MODE: '1' } });
    expect((await on.call('POST', 'https://cloud.example.com/auth/dev', { json: { email: 'a@b.co' } })).status).toBe(404);
    const local = await on.call('POST', 'http://127.0.0.1:8787/auth/dev', { json: { email: 'a@b.co' } });
    expect(local.status).toBe(200);
  });
});
