import crypto from 'node:crypto';

// AES-256-GCM with a key derived from AIOS_ENCRYPTION_KEY (any string). Format: v1:<iv b64>:<tag b64>:<data b64>.

export interface Cipher {
  enabled: boolean;
  encrypt(plain: string): string;
  decrypt(value: string): string;
}

export function createCipher(secret: string | undefined): Cipher {
  if (!secret) {
    return { enabled: false, encrypt: (s) => s, decrypt: (s) => s };
  }
  const key = crypto.createHash('sha256').update(`aios-lite:${secret}`).digest();
  return {
    enabled: true,
    encrypt(plain) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${data.toString('base64')}`;
    },
    decrypt(value) {
      if (!value.startsWith('v1:')) return value; // stored before encryption was enabled
      const [, iv, tag, data] = value.split(':');
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv!, 'base64'));
      d.setAuthTag(Buffer.from(tag!, 'base64'));
      return Buffer.concat([d.update(Buffer.from(data!, 'base64')), d.final()]).toString('utf8');
    },
  };
}
