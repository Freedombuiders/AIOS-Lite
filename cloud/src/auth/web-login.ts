/**
 * Desktop sign-in: the core app on the owner's machine opens
 * /auth/web/start?return=http://127.0.0.1:<port>/…&state=<its state> in a
 * browser. Google calls /auth/web/callback; we verify the ID token, then send
 * the browser back to the local app with a one-time code (2 minutes, single
 * use, bound to the app's state). The app trades it at POST /auth/exchange.
 */
import { badRequest } from '../http/errors';
import { sha256, toBase64Url } from '../lib/encoding';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const PENDING_TTL_MS = 10 * 60_000;
export const LOGIN_CODE_TTL_MS = 2 * 60_000;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);

/** Only http://127.0.0.1:<port>/… or http://localhost:<port>/… with an explicit port. */
export function parseReturnUrl(raw: string | undefined): URL {
  const bad = badRequest('Địa chỉ trả về chỉ được là http://127.0.0.1:<cổng>/… hoặc http://localhost:<cổng>/….');
  if (!raw || raw.length > 500) throw bad;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw bad;
  }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname) || !url.port || url.username || url.password) throw bad;
  url.hash = '';
  return url;
}

/** The app's own CSRF state: echoed back with the code and required again at /auth/exchange. */
export function parseClientState(raw: string | undefined): string {
  if (!raw || !/^[A-Za-z0-9._~-]{8,200}$/.test(raw)) throw badRequest('Thiếu "state" hoặc "state" không hợp lệ (8 đến 200 ký tự chữ, số, ".", "_", "~", "-").');
  return raw;
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return toBase64Url(await sha256(verifier));
}

/** Appends query parameters to the local return URL. */
export function withParams(url: URL, params: Record<string, string>): string {
  const out = new URL(url.toString());
  for (const [k, v] of Object.entries(params)) out.searchParams.set(k, v);
  return out.toString();
}
