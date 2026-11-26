import { describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { GOOGLE_CLIENT_ID, IOS_CLIENT_ID, T0, harness, idToken } from '../../test/helpers';
import { verifyGoogleIdToken } from './google';

async function verify(token: string, now = T0) {
  const h = await harness();
  return verifyGoogleIdToken(token, { keys: h.env.googleKeys, clientIds: h.env.config.googleClientIds, now });
}

describe('verifyGoogleIdToken', () => {
  it('accepts a valid token for any allowed client id', async () => {
    await expect(verify(await idToken())).resolves.toMatchObject({ sub: 'google-sub-1', email: 'lan@example.com' });
    await expect(verify(await idToken({ aud: IOS_CLIENT_ID }))).resolves.toMatchObject({ sub: 'google-sub-1' });
    await expect(verify(await idToken({ iss: 'accounts.google.com' }))).resolves.toBeTruthy();
  });

  it('rejects a token signed by another key', async () => {
    await expect(verify(await idToken({}, { foreignKey: true }))).rejects.toMatchObject({ status: 401 });
  });

  it('rejects a wrong audience', async () => {
    await expect(verify(await idToken({ aud: 'someone-else.apps.googleusercontent.com' }))).rejects.toMatchObject({ status: 401 });
  });

  it('rejects a wrong issuer', async () => {
    await expect(verify(await idToken({ iss: 'https://evil.example.com' }))).rejects.toMatchObject({ status: 401 });
  });

  it('rejects an expired token', async () => {
    const token = await idToken({}, { now: T0 - 2 * 3_600_000 });
    await expect(verify(token)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects an unverified email, including the string "false"', async () => {
    await expect(verify(await idToken({ email_verified: false }))).rejects.toMatchObject({ status: 401 });
    await expect(verify(await idToken({ email_verified: 'false' }))).rejects.toMatchObject({ status: 401 });
  });

  it('rejects a mismatched nonce when one is expected', async () => {
    const h = await harness();
    const opts = { keys: h.env.googleKeys, clientIds: [GOOGLE_CLIENT_ID], now: T0 };
    await expect(verifyGoogleIdToken(await idToken({ nonce: 'a' }), { ...opts, nonce: 'b' })).rejects.toMatchObject({ status: 401 });
    await expect(verifyGoogleIdToken(await idToken({ nonce: 'a' }), { ...opts, nonce: 'a' })).resolves.toBeTruthy();
  });

  it('rejects everything when no client id is configured', async () => {
    const h = await harness();
    await expect(verifyGoogleIdToken(await idToken(), { keys: h.env.googleKeys, clientIds: [], now: T0 })).rejects.toMatchObject({ status: 401 });
  });

  it('rejects an unsigned (alg none) token', async () => {
    const pair = await generateKeyPair('RS256', { extractable: true });
    const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'x' }] });
    const forged = 'eyJhbGciOiJub25lIn0.' + btoa(JSON.stringify({ sub: 'x' })) + '.';
    await expect(verifyGoogleIdToken(forged, { keys, clientIds: [GOOGLE_CLIENT_ID], now: T0 })).rejects.toMatchObject({ status: 401 });
  });
});
