/**
 * Test harness: the real app on the in-memory D1 and R2 from the Workers test
 * pool, a controllable clock, a fake Google key set, a fake Google token
 * endpoint and a logger that records every line. Nothing reaches the network.
 */
import { env as bindings } from 'cloudflare:test';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from 'jose';
import { createApp } from '../src/app';
import { readConfig, type ConfigVars } from '../src/config';
import type { BlobStore, Env, FetchLike, Logger, SqlDb } from '../src/env';
import { r2BlobStore } from '../src/platform/workers';

export const GOOGLE_CLIENT_ID = 'web-client.apps.googleusercontent.com';
export const IOS_CLIENT_ID = 'ios-client.apps.googleusercontent.com';
export const T0 = Date.UTC(2026, 10, 26, 9, 0, 0);

let keys: { privateKey: CryptoKey; jwk: JWK } | undefined;
async function googleKey() {
  if (!keys) {
    const pair = await generateKeyPair('RS256', { extractable: true });
    keys = { privateKey: pair.privateKey, jwk: { ...(await exportJWK(pair.publicKey)), kid: 'test-kid', alg: 'RS256', use: 'sig' } };
  }
  return keys;
}

export interface IdTokenClaims {
  sub?: string; email?: string; email_verified?: boolean | string; name?: string; picture?: string;
  aud?: string; iss?: string; nonce?: string; expSec?: number;
}

/** Mints a Google-shaped ID token signed with the fake key (or a foreign key with `foreignKey`). */
export async function idToken(claims: IdTokenClaims = {}, opts: { now?: number; foreignKey?: boolean } = {}): Promise<string> {
  const now = Math.floor((opts.now ?? T0) / 1000);
  const key = opts.foreignKey ? (await generateKeyPair('RS256')).privateKey : (await googleKey()).privateKey;
  const payload: Record<string, unknown> = {
    email: claims.email ?? 'lan@example.com',
    email_verified: claims.email_verified ?? true,
    name: claims.name ?? 'Chị Lan',
    picture: claims.picture,
  };
  if (claims.nonce) payload.nonce = claims.nonce;
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
    .setIssuer(claims.iss ?? 'https://accounts.google.com')
    .setAudience(claims.aud ?? GOOGLE_CLIENT_ID)
    .setSubject(claims.sub ?? 'google-sub-1')
    .setIssuedAt(now)
    .setExpirationTime(claims.expSec ?? now + 3600)
    .sign(key);
}

export interface TestHarness {
  env: Env;
  clock: { now: number };
  logs: string[];
  /** Calls the app; `token` adds the Authorization header, `json` a JSON body. */
  call(method: string, path: string, opts?: { token?: string; json?: unknown; headers?: Record<string, string> }): Promise<Response>;
  /** Signs in through POST /auth/google and returns the session token and user id. */
  login(claims?: IdTokenClaims, kind?: string): Promise<{ token: string; userId: string }>;
}

/** Storage persists across tests in a file, so each harness starts from empty tables and an empty bucket. */
async function wipe(): Promise<void> {
  const { results } = await bindings.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf_%'",
  ).all<{ name: string }>();
  // Children before parents for foreign keys.
  const order = ['downloads', 'pack_releases', 'packs', 'uploads', 'sessions'];
  const names = results.map((r) => r.name);
  for (const name of [...order.filter((n) => names.includes(n)), ...names.filter((n) => !order.includes(n))]) {
    await bindings.DB.prepare(`DELETE FROM ${name}`).run();
  }
  for (;;) {
    const page = await bindings.BUCKET.list({ limit: 1000 });
    if (page.objects.length === 0) break;
    await bindings.BUCKET.delete(page.objects.map((o) => o.key));
  }
}

export async function harness(opts: { vars?: ConfigVars; fetch?: FetchLike; blobs?: Partial<BlobStore> } = {}): Promise<TestHarness> {
  await wipe();
  const clock = { now: T0 };
  const logs: string[] = [];
  const record = (level: string): Logger[keyof Logger] => (message, fields) => { logs.push(`${level} ${message} ${JSON.stringify(fields ?? {})}`); };
  const { jwk } = await googleKey();
  let counter = 0;
  const env: Env = {
    db: bindings.DB as unknown as SqlDb,
    blobs: {
      ...r2BlobStore(bindings.BUCKET),
      presignPut: async (key, o) => ({ url: `https://r2.test/${key}?put`, headers: { 'content-type': o.contentType, 'content-length': String(o.contentLength) } }),
      presignGet: async (key, exp) => `https://r2.test/${key}?get&exp=${exp}`,
      ...opts.blobs,
    },
    now: () => clock.now,
    randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
    fetch: opts.fetch ?? (async () => { throw new Error('network disabled in tests'); }),
    googleKeys: createLocalJWKSet({ keys: [jwk] }),
    config: readConfig({
      GOOGLE_CLIENT_IDS: `${IOS_CLIENT_ID},${GOOGLE_CLIENT_ID}`,
      GOOGLE_WEB_CLIENT_ID: GOOGLE_CLIENT_ID,
      GOOGLE_WEB_CLIENT_SECRET: 'test-secret',
      ADMIN_EMAILS: 'boss@example.com',
      AUTH_RATE_LIMIT: '1000',
      ...opts.vars,
    }),
    log: { info: record('info'), warn: record('warn'), error: record('error') },
  };
  const app = createApp();
  const call: TestHarness['call'] = async (method, path, o = {}) => {
    const headers: Record<string, string> = { 'cf-connecting-ip': `10.0.0.${++counter % 250}`, ...o.headers };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    if (o.json !== undefined) headers['content-type'] = 'application/json';
    const url = path.startsWith('http') ? path : `https://cloud.test${path}`;
    return app.request(url, { method, headers, body: o.json === undefined ? undefined : JSON.stringify(o.json) }, env);
  };
  const login: TestHarness['login'] = async (claims = {}, kind = 'mobile') => {
    const res = await call('POST', '/auth/google', { json: { idToken: await idToken(claims, { now: clock.now }), kind } });
    if (res.status !== 200) throw new Error(`login failed: ${res.status} ${await res.text()}`);
    const body = await res.json() as { token: string; user: { id: string } };
    return { token: body.token, userId: body.user.id };
  };
  return { env, clock, logs, call, login };
}

export async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}
