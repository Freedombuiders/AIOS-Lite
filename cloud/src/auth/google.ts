/**
 * Verifies a Google ID token: signature against Google's published keys, `iss`
 * is Google, `aud` is one of our client ids, not expired, and the email is
 * verified. Any missing condition rejects. Only the identity is kept; Google
 * refresh or access tokens are never stored.
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { unauthorized } from '../http/errors';
import type { GoogleProfile } from '../db/users';

export const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

let remoteKeys: JWTVerifyGetKey | undefined;
/** Google's key set, fetched lazily and cached by jose for the isolate's lifetime. */
export function googleRemoteKeys(): JWTVerifyGetKey {
  remoteKeys ??= createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  return remoteKeys;
}

export interface VerifyOptions {
  keys: JWTVerifyGetKey;
  clientIds: string[];
  /** Milliseconds since epoch. */
  now: number;
  /** When set (web flow), the token's `nonce` must equal it. */
  nonce?: string;
}

export async function verifyGoogleIdToken(idToken: string, opts: VerifyOptions): Promise<GoogleProfile> {
  const reject = unauthorized('ID token Google không hợp lệ hoặc đã hết hạn.');
  if (opts.clientIds.length === 0 || typeof idToken !== 'string' || idToken.length > 8192) throw reject;
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(idToken, opts.keys, {
      issuer: GOOGLE_ISSUERS,
      audience: opts.clientIds,
      algorithms: ['RS256'],
      currentDate: new Date(opts.now),
      requiredClaims: ['exp', 'iat', 'sub'],
    }));
  } catch {
    throw reject;
  }
  if (payload.email_verified !== true && payload.email_verified !== 'true') throw reject;
  if (typeof payload.sub !== 'string' || !payload.sub || typeof payload.email !== 'string' || !payload.email) throw reject;
  if (opts.nonce !== undefined && payload.nonce !== opts.nonce) throw reject;
  return {
    sub: payload.sub,
    email: payload.email,
    name: typeof payload.name === 'string' ? payload.name : undefined,
    picture: typeof payload.picture === 'string' ? payload.picture : undefined,
  };
}
