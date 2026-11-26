import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AuthResponse } from '../../../packages/api-types/src/index';
import type { AppEnv } from '../app-types';
import { verifyGoogleIdToken } from '../auth/google';
import { createSession, hashToken } from '../auth/session';
import {
  GOOGLE_AUTH_URL, GOOGLE_TOKEN_URL, LOGIN_CODE_TTL_MS, PENDING_TTL_MS,
  parseClientState, parseReturnUrl, pkceChallenge, withParams,
} from '../auth/web-login';
import { sessionJson, upsertGoogleUser, userJson, type GoogleProfile, type SessionKind, type UserRow } from '../db/users';
import { ApiError, badRequest, forbidden, notFound, readJson, unauthorized } from '../http/errors';
import { requireSession } from '../http/auth';
import { authRateLimit } from '../http/rate-limit';
import { newId, sha256Hex, toBase64Url } from '../lib/encoding';

const KINDS = ['mobile', 'machine', 'web'] as const;
const label = z.string().trim().max(100).optional();

const disabled = () => forbidden('Tài khoản đã bị khoá. Hãy liên hệ quản trị viên.');

async function signIn(c: Context<AppEnv>, profile: GoogleProfile): Promise<UserRow> {
  const user = await upsertGoogleUser(c.env, newId('usr', (n) => c.env.randomBytes(n)), profile);
  if (!user) throw new ApiError(500, 'internal', 'Không lưu được người dùng.');
  if (user.status !== 'active') throw disabled();
  return user;
}

async function issue(c: Context<AppEnv>, user: UserRow, kind: SessionKind, sessionLabel?: string) {
  const { token, session } = await createSession(c.env, user.id, kind, sessionLabel);
  c.env.log.info('session created', { userId: user.id, sessionId: session.id, kind });
  return c.json({ token, user: userJson(user), session: sessionJson(session, session.id) } satisfies AuthResponse);
}

function redirectUri(c: Context<AppEnv>): string {
  const base = c.env.config.publicUrl || new URL(c.req.url).origin;
  return `${base.replace(/\/+$/, '')}/auth/web/callback`;
}

function isLocalRequest(c: Context<AppEnv>): boolean {
  const host = new URL(c.req.url).hostname;
  return host === '127.0.0.1' || host === 'localhost';
}

export const authRoutes = new Hono<AppEnv>();

authRoutes.use('*', authRateLimit);

authRoutes.post('/google', async (c) => {
  const body = await readJson(c, z.object({ idToken: z.string().min(1).max(8192), kind: z.enum(KINDS), label }));
  const profile = await verifyGoogleIdToken(body.idToken, { keys: c.env.googleKeys, clientIds: c.env.config.googleClientIds, now: c.env.now() });
  return issue(c, await signIn(c, profile), body.kind, body.label);
});

authRoutes.get('/web/start', async (c) => {
  const returnUrl = parseReturnUrl(c.req.query('return'));
  const clientState = parseClientState(c.req.query('state'));
  const { googleWebClientId, googleWebClientSecret } = c.env.config;
  if (!googleWebClientId || !googleWebClientSecret) throw new ApiError(503, 'not_configured', 'Máy chủ chưa cấu hình đăng nhập Google trên web.');
  const random = () => toBase64Url(c.env.randomBytes(32));
  const googleState = random();
  const nonce = random();
  const verifier = random();
  await c.env.db.prepare(
    'INSERT INTO oauth_pending (state_hash, return_url, client_state, nonce, code_verifier, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(await sha256Hex(googleState), returnUrl.toString(), clientState, nonce, verifier, c.env.now() + PENDING_TTL_MS).run();
  const url = new URL(GOOGLE_AUTH_URL);
  url.search = new URLSearchParams({
    client_id: googleWebClientId,
    redirect_uri: redirectUri(c),
    response_type: 'code',
    scope: 'openid email profile',
    state: googleState,
    nonce,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return c.redirect(url.toString(), 302);
});

interface PendingRow { return_url: string; client_state: string; nonce: string; code_verifier: string; expires_at: number }

authRoutes.get('/web/callback', async (c) => {
  const googleState = c.req.query('state') ?? '';
  const stateHash = await sha256Hex(googleState);
  // Single use: the pending row is deleted whether or not the rest succeeds.
  const pending = await c.env.db.prepare('DELETE FROM oauth_pending WHERE state_hash = ? RETURNING *').bind(stateHash).first<PendingRow>();
  if (!pending || pending.expires_at <= c.env.now()) throw badRequest('Lượt đăng nhập không hợp lệ hoặc đã hết hạn. Hãy bắt đầu lại từ app.');
  const back = new URL(pending.return_url);
  const fail = (error: string) => c.redirect(withParams(back, { error, state: pending.client_state }), 302);

  const code = c.req.query('code');
  if (!code || c.req.query('error')) return fail('access_denied');

  const { googleWebClientId, googleWebClientSecret } = c.env.config;
  if (!googleWebClientId || !googleWebClientSecret) return fail('not_configured');
  let idToken: unknown;
  try {
    const res = await c.env.fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        code,
        client_id: googleWebClientId,
        client_secret: googleWebClientSecret,
        redirect_uri: redirectUri(c),
        grant_type: 'authorization_code',
        code_verifier: pending.code_verifier,
      }).toString(),
    });
    if (!res.ok) {
      c.env.log.warn('google token exchange failed', { status: res.status });
      return fail('google_error');
    }
    idToken = ((await res.json()) as { id_token?: unknown }).id_token;
  } catch {
    c.env.log.warn('google token exchange unreachable');
    return fail('google_error');
  }
  if (typeof idToken !== 'string') return fail('google_error');

  let user: UserRow;
  try {
    const profile = await verifyGoogleIdToken(idToken, {
      keys: c.env.googleKeys, clientIds: c.env.config.googleClientIds, now: c.env.now(), nonce: pending.nonce,
    });
    user = await signIn(c, profile);
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) return fail('account_disabled');
    if (err instanceof ApiError && err.status === 401) return fail('invalid_token');
    throw err;
  }
  const loginCode = toBase64Url(c.env.randomBytes(32));
  await c.env.db.prepare('INSERT INTO login_codes (code_hash, user_id, state, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await hashToken(loginCode), user.id, pending.client_state, c.env.now() + LOGIN_CODE_TTL_MS).run();
  return c.redirect(withParams(back, { code: loginCode, state: pending.client_state }), 302);
});

interface LoginCodeRow { user_id: string; state: string; expires_at: number; used_at: number | null }

authRoutes.post('/exchange', async (c) => {
  const body = await readJson(c, z.object({
    code: z.string().min(1).max(200),
    state: z.string().min(1).max(200),
    kind: z.enum(['machine', 'web']).default('machine'),
    label,
  }));
  const invalid = unauthorized('Mã đăng nhập không hợp lệ, đã dùng hoặc đã hết hạn.');
  const codeHash = await hashToken(body.code);
  const now = c.env.now();
  // Claim the code atomically: a second use, an expired code or a wrong state all fail, and a
  // wrong state burns the code so it cannot be retried.
  const row = await c.env.db.prepare(
    'UPDATE login_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL RETURNING user_id, state, expires_at, used_at',
  ).bind(now, codeHash).first<LoginCodeRow>();
  if (!row || row.expires_at <= now || row.state !== body.state) throw invalid;
  const user = await c.env.db.prepare('SELECT * FROM users WHERE id = ?').bind(row.user_id).first<UserRow>();
  if (!user) throw invalid;
  if (user.status !== 'active') throw disabled();
  return issue(c, user, body.kind, body.label);
});

authRoutes.post('/logout', requireSession, async (c) => {
  await c.env.db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .bind(c.env.now(), c.var.auth.session.id).run();
  return c.json({ ok: true });
});

/**
 * Local development only (DEV_MODE=1 and a localhost request): sign in as an
 * email without Google, so `wrangler dev` can be exercised end to end.
 * Anywhere else this route does not exist.
 */
authRoutes.post('/dev', async (c) => {
  if (!c.env.config.devMode || !isLocalRequest(c)) throw notFound('Không có đường này.');
  const body = await readJson(c, z.object({ email: z.string().email().max(200), name: z.string().max(100).optional(), kind: z.enum(KINDS).default('machine'), label }));
  const user = await signIn(c, { sub: `dev:${body.email.toLowerCase()}`, email: body.email.toLowerCase(), name: body.name });
  return issue(c, user, body.kind, body.label);
});
