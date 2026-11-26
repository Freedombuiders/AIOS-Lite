/** Ed25519 pack signatures, verified with Web Crypto against the configured public keys. */
import { fromBase64 } from '../lib/encoding';
import { signingMessage } from './format';

export async function verifyPackSignature(opts: {
  publicKeys: Record<string, string>;
  keyId: string;
  signature: string;
  packId: string;
  version: string;
  sha256: string;
}): Promise<boolean> {
  const pub = opts.publicKeys[opts.keyId];
  if (!pub) return false;
  try {
    const raw = fromBase64(pub);
    const sig = fromBase64(opts.signature);
    if (raw.length !== 32 || sig.length !== 64) return false;
    const key = await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, sig, signingMessage(opts.packId, opts.version, opts.sha256));
  } catch {
    return false;
  }
}
