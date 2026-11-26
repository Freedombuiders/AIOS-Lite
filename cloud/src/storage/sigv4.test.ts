import { describe, expect, it } from 'vitest';
import { presignUrl, uriEncode } from './sigv4';

describe('presignUrl', () => {
  it('matches the published SigV4 query-signing example (S3 GET test.txt)', async () => {
    const url = await presignUrl({
      method: 'GET',
      url: 'https://examplebucket.s3.amazonaws.com/test.txt',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      now: Date.UTC(2013, 4, 24, 0, 0, 0),
      expiresInSec: 86400,
    });
    expect(url).toBe(
      'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256'
      + '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request'
      + '&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host'
      + '&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
  });

  it('signs extra headers so they cannot be changed by the uploader', async () => {
    const base = {
      method: 'PUT' as const, url: 'https://acc.r2.cloudflarestorage.com/bucket/u/1/post-media/a.jpg',
      accessKeyId: 'k', secretAccessKey: 's', region: 'auto', now: Date.UTC(2026, 10, 26), expiresInSec: 600,
    };
    const a = await presignUrl({ ...base, headers: { 'content-type': 'image/jpeg', 'content-length': '100' } });
    const b = await presignUrl({ ...base, headers: { 'content-type': 'image/jpeg', 'content-length': '101' } });
    expect(new URL(a).searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
    expect(new URL(a).searchParams.get('X-Amz-Signature')).not.toBe(new URL(b).searchParams.get('X-Amz-Signature'));
  });

  it('encodes the way SigV4 requires', () => {
    expect(uriEncode('a b/ç~*', true)).toBe('a%20b/%C3%A7~%2A');
    expect(uriEncode('a/b')).toBe('a%2Fb');
  });
});
