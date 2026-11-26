/**
 * Where signed upload and download URLs come from.
 *
 * - R2 (production): SigV4 URLs on R2's S3 endpoint. Bytes go straight between
 *   the client and R2; the Worker never relays them.
 * - Local dev (DEV_MODE on localhost, no R2 keys): `wrangler dev` cannot sign
 *   for real R2, so URLs point at /_dev/blobs on the local Worker, which reads
 *   and writes the local R2 simulation. That route exists only in dev mode.
 */
import type { BlobStore } from '../env';
import { encodeUtf8, toHex } from '../lib/encoding';
import { presignUrl } from './sigv4';

export type Presigner = Pick<BlobStore, 'presignPut' | 'presignGet'>;

export interface R2S3Settings {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const keyPath = (key: string) => key.split('/').map(encodeURIComponent).join('/');

export function r2S3Presigner(s: R2S3Settings, now: () => number): Presigner {
  const objectUrl = (key: string) => `https://${s.accountId}.r2.cloudflarestorage.com/${encodeURIComponent(s.bucket)}/${keyPath(key)}`;
  const common = { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey, region: 'auto' };
  return {
    async presignPut(key, o) {
      const headers = { 'content-type': o.contentType, 'content-length': String(o.contentLength) };
      const url = await presignUrl({ ...common, method: 'PUT', url: objectUrl(key), now: now(), expiresInSec: o.expiresInSec, headers });
      return { url, headers };
    },
    presignGet(key, expiresInSec) {
      return presignUrl({ ...common, method: 'GET', url: objectUrl(key), now: now(), expiresInSec });
    },
  };
}

/** Fixed: dev URLs only work on a localhost Worker with DEV_MODE on, so this is not a secret. */
const DEV_KEY = encodeUtf8('agenticos-cloud-dev-blobs');

export async function devSignature(method: string, key: string, exp: number, contentType = '', contentLength = ''): Promise<string> {
  const k = await crypto.subtle.importKey('raw', DEV_KEY, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', k, encodeUtf8([method, key, exp, contentType, contentLength].join('\n')))));
}

export function devPresigner(origin: string, now: () => number): Presigner {
  return {
    async presignPut(key, o) {
      const exp = now() + o.expiresInSec * 1000;
      const headers = { 'content-type': o.contentType, 'content-length': String(o.contentLength) };
      const sig = await devSignature('PUT', key, exp, o.contentType, String(o.contentLength));
      return { url: `${origin}/_dev/blobs/${keyPath(key)}?exp=${exp}&sig=${sig}`, headers };
    },
    async presignGet(key, expiresInSec) {
      const exp = now() + expiresInSec * 1000;
      return `${origin}/_dev/blobs/${keyPath(key)}?exp=${exp}&sig=${await devSignature('GET', key, exp)}`;
    },
  };
}
