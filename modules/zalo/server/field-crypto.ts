// Field encryption for zalo_* rows. Same AES-256-GCM format as the core cipher (v1:<iv>:<tag>:<data>), so rows written by the
// AIOS process (ctx.crypto) and by the daemon child process (key from AIOS_ENCRYPTION_KEY) read each other.
import crypto from 'node:crypto';
import { moduleCompat, readEnvFile } from './compat.js';

interface Cipher {
  encrypt(plain: string): string;
  decrypt(value: string): string;
}

let override: Cipher | null = null;
let envCipher: Cipher | null | undefined;

function fromSecret(secret: string): Cipher {
  const key = crypto.createHash('sha256').update(`aios-lite:${secret}`).digest();
  return {
    encrypt(plain) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${data.toString('base64')}`;
    },
    decrypt(value) {
      if (!value.startsWith('v1:')) return value;
      const [, iv, tag, data] = value.split(':');
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv!, 'base64'));
      d.setAuthTag(Buffer.from(tag!, 'base64'));
      return Buffer.concat([d.update(Buffer.from(data!, 'base64')), d.final()]).toString('utf8');
    },
  };
}

/** Test/daemon hook: force a cipher (null restores the default lookup). */
export function setFieldCipher(c: Cipher | null): void {
  override = c;
  envCipher = undefined;
}

function cipher(): Cipher | null {
  if (override) return override;
  const ctx = moduleCompat('zalo');
  if (ctx) return ctx.crypto;
  if (envCipher === undefined) {
    const secret = readEnvFile(['AIOS_ENCRYPTION_KEY']).AIOS_ENCRYPTION_KEY;
    envCipher = secret ? fromSecret(secret) : null;
  }
  return envCipher;
}

export function encryptField(plain: string): string {
  return cipher()?.encrypt(plain) ?? plain;
}

export function decryptField(value: string): string {
  return cipher()?.decrypt(value) ?? value;
}
