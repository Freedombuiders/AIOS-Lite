import { describe, expect, it } from 'vitest';
import { harness } from '../../test/helpers';
import { devPresigner, r2S3Presigner } from './presign';

describe('r2S3Presigner', () => {
  it('signs PUT with content-type and content-length, and GET with an expiry, on the R2 S3 endpoint', async () => {
    const p = r2S3Presigner({ accountId: 'acc123', bucket: 'agenticos-cloud', accessKeyId: 'AK', secretAccessKey: 'SK' }, () => Date.UTC(2026, 10, 26));
    const put = await p.presignPut('u/usr_1/post-media/upl_1.jpg', { contentType: 'image/jpeg', contentLength: 1234, expiresInSec: 600 });
    const url = new URL(put.url);
    expect(url.origin).toBe('https://acc123.r2.cloudflarestorage.com');
    expect(url.pathname).toBe('/agenticos-cloud/u/usr_1/post-media/upl_1.jpg');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
    expect(url.searchParams.get('X-Amz-Credential')).toBe('AK/20261126/auto/s3/aws4_request');
    expect(put.headers).toEqual({ 'content-type': 'image/jpeg', 'content-length': '1234' });
    const get = new URL(await p.presignGet('packs/x/1.0.0.zip', 300));
    expect(get.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(get.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(get.toString()).not.toContain('SK');
  });
});

describe('dev blob URLs', () => {
  it('round-trip on a local dev Worker and refuse tampering', async () => {
    const h = await harness({ vars: { DEV_MODE: '1' } });
    const p = devPresigner('http://127.0.0.1:8787', () => h.clock.now);
    const put = await p.presignPut('incoming/x.zip', { contentType: 'application/zip', contentLength: 3, expiresInSec: 60 });
    const body = new Uint8Array([1, 2, 3]);
    expect((await h.call('PUT', put.url, { headers: put.headers, body })).status).toBe(200);
    const wrongType = await h.call('PUT', put.url, { headers: { ...put.headers, 'content-type': 'text/html' }, body });
    expect(wrongType.status).toBe(403);
    const get = await p.presignGet('incoming/x.zip', 60);
    const res = await h.call('GET', get);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(body);
    expect((await h.call('GET', get.replace('incoming%2F', 'incoming/').replace('x.zip', 'y.zip'))).status).toBe(403);
    h.clock.now += 61_000;
    expect((await h.call('GET', get)).status).toBe(403);
  });

  it('do not exist outside dev mode or off localhost', async () => {
    const off = await harness();
    const p = devPresigner('http://127.0.0.1:8787', () => off.clock.now);
    expect((await off.call('GET', await p.presignGet('a', 60))).status).toBe(404);
    const on = await harness({ vars: { DEV_MODE: '1' } });
    const remote = devPresigner('https://cloud.example.com', () => on.clock.now);
    expect((await on.call('GET', await remote.presignGet('a', 60))).status).toBe(404);
  });
});
