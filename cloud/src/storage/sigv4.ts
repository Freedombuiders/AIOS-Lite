/**
 * AWS Signature Version 4 query signing ("presigned URLs") on Web Crypto, for
 * R2's S3-compatible endpoint. Written from the public SigV4 specification.
 * Every header passed in `headers` is signed, so the client must send it with
 * exactly that value (R2 rejects the upload otherwise).
 */
import { encodeUtf8, sha256Hex, toHex } from '../lib/encoding';

export interface PresignInput {
  method: 'GET' | 'PUT' | 'HEAD' | 'DELETE';
  /** Full URL without query, e.g. https://<account>.r2.cloudflarestorage.com/<bucket>/<key>. */
  url: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service?: string;
  /** Milliseconds since epoch. */
  now: number;
  expiresInSec: number;
  /** Extra headers to sign (lower-case names). `host` is always signed. */
  headers?: Record<string, string>;
}

/** RFC 3986 encoding as SigV4 wants it: only A-Z a-z 0-9 - _ . ~ stay as they are. */
export function uriEncode(text: string, keepSlash = false): string {
  let out = '';
  for (const byte of encodeUtf8(text)) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(ch) || (keepSlash && ch === '/')) out += ch;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, encodeUtf8(data)));
}

function amzDate(ms: number): { stamp: string; day: string } {
  const stamp = new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return { stamp, day: stamp.slice(0, 8) };
}

export async function presignUrl(input: PresignInput): Promise<string> {
  const service = input.service ?? 's3';
  const url = new URL(input.url);
  const { stamp, day } = amzDate(input.now);
  const scope = `${day}/${input.region}/${service}/aws4_request`;

  const headers: Record<string, string> = { host: url.host };
  for (const [k, v] of Object.entries(input.headers ?? {})) headers[k.toLowerCase()] = String(v).trim();
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(';');

  const query: [string, string][] = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${input.accessKeyId}/${scope}`],
    ['X-Amz-Date', stamp],
    ['X-Amz-Expires', String(input.expiresInSec)],
    ['X-Amz-SignedHeaders', signedHeaders],
  ];
  const canonicalQuery = query
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  // The path is already percent-encoded by URL; decode then re-encode the SigV4 way.
  const canonicalPath = uriEncode(decodeURIComponent(url.pathname), true);
  const canonicalRequest = [
    input.method,
    canonicalPath,
    canonicalQuery,
    names.map((n) => `${n}:${headers[n]}\n`).join(''),
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, await sha256Hex(canonicalRequest)].join('\n');

  let key = await hmac(encodeUtf8(`AWS4${input.secretAccessKey}`), day);
  key = await hmac(key, input.region);
  key = await hmac(key, service);
  key = await hmac(key, 'aws4_request');
  const signature = toHex(await hmac(key, stringToSign));

  return `${url.origin}${canonicalPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
