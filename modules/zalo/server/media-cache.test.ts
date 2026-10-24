/**
 * Inbox v2: inbound Zalo media cache. Fake fetch only; files go to a throwaway data dir.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const store = { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'zalo-media-cache-')) };

import { setZaloDataDir } from './paths.js';
import { createZaloAccount,
  getZaloMediaCache,
  insertZaloMessage,
  upsertZaloThread,
} from './store.js';
import { _initTestDatabase } from './test-db.js';
import {
  getCachedZaloMedia,
  isAllowedZaloMediaUrl,
  MEDIA_CACHE_MAX_BYTES,
  MEDIA_CACHE_RETRY_SEC,
  ZALO_MEDIA_CACHE_DIR,
  zaloMediaUrls,
} from './media-cache.js';

setZaloDataDir(store.dir);

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const IMG = 'https://photo-zpl.zdn.vn/full.png';

afterAll(() => fs.rmSync(store.dir, { recursive: true, force: true }));

function ok(body: Buffer | string, type = 'image/png'): Response {
  return new Response(body, { status: 200, headers: { 'content-type': type } });
}

describe('zalo media cache', () => {
  let threadId: number;
  let seq = 0;
  let clock = 1_000_000;
  const now = () => clock;

  beforeEach(() => {
    _initTestDatabase();
    fs.rmSync(ZALO_MEDIA_CACHE_DIR, { recursive: true, force: true });
    const accountId = createZaloAccount('Nick').id;
    threadId = upsertZaloThread({ accountId, threadType: 'user', externalId: 'u1', name: 'An' }).id;
    clock = 1_000_000;
  });

  function message(body: unknown, contentType = 'image'): number {
    return insertZaloMessage({
      threadId, zaloMsgId: `m${++seq}`, senderType: 'customer', senderUid: 'c', senderName: 'An',
      body: typeof body === 'string' ? body : JSON.stringify(body), contentType, origin: 'live', sentAtMs: Date.now(),
    })!;
  }

  describe('url selection', () => {
    it('only accepts https Zalo CDN hosts', () => {
      for (const ok of [IMG, 'https://zdn.vn/a', 'https://f21-zpc.zdn.vn/f.pdf', 'https://x.zadn.vn/a']) expect(isAllowedZaloMediaUrl(ok)).toBe(true);
      for (const bad of [
        'http://photo.zdn.vn/a', 'https://zdn.vn.evil.com/a', 'https://evilzdn.vn/a', 'https://127.0.0.1/a',
        'https://u:p@photo.zdn.vn/a', 'https://photo.zdn.vn:8443/a', 'file:///etc/passwd', 'not a url',
      ]) expect(isAllowedZaloMediaUrl(bad)).toBe(false);
    });

    it('prefers the full-size link, skips unsafe ones and returns an album in order', () => {
      expect(zaloMediaUrls('image', JSON.stringify({ thumb: 'https://p.zdn.vn/t.jpg', hdUrl: 'https://p.zdn.vn/h.jpg' }))).toEqual(['https://p.zdn.vn/h.jpg']);
      expect(zaloMediaUrls('image', JSON.stringify({ hdUrl: 'https://evil.com/h.jpg', thumb: 'https://p.zdn.vn/t.jpg' }))).toEqual(['https://p.zdn.vn/t.jpg']);
      expect(zaloMediaUrls('image', JSON.stringify({ images: [{ hdUrl: 'https://p.zdn.vn/1.jpg' }, 'https://p.zdn.vn/2.jpg', { href: 'https://evil.com/3.jpg' }] })))
        .toEqual(['https://p.zdn.vn/1.jpg', 'https://p.zdn.vn/2.jpg']);
      expect(zaloMediaUrls('text', JSON.stringify({ hdUrl: IMG }))).toEqual([]);
      expect(zaloMediaUrls('link', JSON.stringify({ href: IMG }))).toEqual([]);
      expect(zaloMediaUrls('image', 'plain text')).toEqual([]);
    });
  });

  it('downloads once, stores the file and serves the copy afterwards', async () => {
    const id = message({ hdUrl: IMG });
    const fetchImpl = vi.fn(async () => ok(PNG));
    const first = await getCachedZaloMedia(id, 0, { fetchImpl: fetchImpl as unknown as typeof fetch, nowSec: now });
    expect(first).toMatchObject({ mime: 'image/png' });
    expect(first!.fileName).toMatch(/\.png$/);
    expect(first!.filePath.startsWith(ZALO_MEDIA_CACHE_DIR + path.sep)).toBe(true);
    expect(fs.readFileSync(first!.filePath)).toEqual(PNG);
    expect(getZaloMediaCache(id, 0)).toMatchObject({ error: '', size: PNG.length, mime: 'image/png' });
    const again = await getCachedZaloMedia(id, 0, { fetchImpl: fetchImpl as unknown as typeof fetch, nowSec: now });
    expect(again).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]).toEqual([IMG, expect.objectContaining({ redirect: 'manual' })]);
  });

  it('shares one download between concurrent viewers', async () => {
    const id = message({ hdUrl: IMG });
    const fetchImpl = vi.fn(async () => ok(PNG));
    const deps = { fetchImpl: fetchImpl as unknown as typeof fetch, nowSec: now };
    const [a, b] = await Promise.all([getCachedZaloMedia(id, 0, deps), getCachedZaloMedia(id, 0, deps)]);
    expect(a).toEqual(b);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refetches when the cached file vanished', async () => {
    const id = message({ hdUrl: IMG });
    const fetchImpl = vi.fn(async () => ok(PNG));
    const deps = { fetchImpl: fetchImpl as unknown as typeof fetch, nowSec: now };
    const first = await getCachedZaloMedia(id, 0, deps);
    fs.rmSync(first!.filePath);
    const second = await getCachedZaloMedia(id, 0, deps);
    expect(second).not.toBeNull();
    expect(fs.existsSync(second!.filePath)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('picks the album item by index and answers null past the end', async () => {
    const id = message({ images: ['https://p.zdn.vn/1.png', 'https://p.zdn.vn/2.png'] });
    const fetchImpl = vi.fn(async (_url: string) => ok(PNG));
    const deps = { fetchImpl: fetchImpl as unknown as typeof fetch, nowSec: now };
    expect(await getCachedZaloMedia(id, 1, deps)).not.toBeNull();
    expect(fetchImpl.mock.calls[0][0]).toBe('https://p.zdn.vn/2.png');
    expect(await getCachedZaloMedia(id, 2, deps)).toBeNull();
    expect(await getCachedZaloMedia(id, -1, deps)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never fetches outside the allowlist, for text messages or unknown ids', async () => {
    const fetchImpl = vi.fn(async () => ok(PNG));
    const deps = { fetchImpl: fetchImpl as unknown as typeof fetch, nowSec: now };
    expect(await getCachedZaloMedia(message({ hdUrl: 'https://evil.example.com/a.png' }), 0, deps)).toBeNull();
    expect(await getCachedZaloMedia(message('hello', 'text'), 0, deps)).toBeNull();
    expect(await getCachedZaloMedia(99_999, 0, deps)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('follows redirects only between allowlisted hosts', async () => {
    const good = message({ hdUrl: IMG });
    const hops = vi.fn(async (url: string) =>
      url === IMG ? new Response(null, { status: 302, headers: { location: 'https://other.zdn.vn/real.png' } }) : ok(PNG));
    expect(await getCachedZaloMedia(good, 0, { fetchImpl: hops as unknown as typeof fetch, nowSec: now })).not.toBeNull();
    expect(hops.mock.calls.map((c) => c[0])).toEqual([IMG, 'https://other.zdn.vn/real.png']);

    const bad = message({ hdUrl: 'https://p.zdn.vn/b.png' });
    const evil = vi.fn(async (url: string) =>
      url.includes('zdn.vn') ? new Response(null, { status: 302, headers: { location: 'https://evil.example.com/x.png' } }) : ok(PNG));
    expect(await getCachedZaloMedia(bad, 0, { fetchImpl: evil as unknown as typeof fetch, nowSec: now })).toBeNull();
    expect(evil).toHaveBeenCalledTimes(1);
    expect(getZaloMediaCache(bad, 0)?.error).toBe('host_not_allowed');
  });

  it('caps the download at 15 MB, by header and by streamed size', async () => {
    const byHeader = message({ hdUrl: IMG });
    const huge = vi.fn(async () => new Response(PNG, { headers: { 'content-type': 'image/png', 'content-length': String(MEDIA_CACHE_MAX_BYTES + 1) } }));
    expect(await getCachedZaloMedia(byHeader, 0, { fetchImpl: huge as unknown as typeof fetch, nowSec: now })).toBeNull();
    expect(getZaloMediaCache(byHeader, 0)?.error).toBe('too_large');

    const byStream = message({ hdUrl: 'https://p.zdn.vn/big.png' });
    const big = vi.fn(async () => ok(Buffer.concat([PNG, Buffer.alloc(MEDIA_CACHE_MAX_BYTES)])));
    expect(await getCachedZaloMedia(byStream, 0, { fetchImpl: big as unknown as typeof fetch, nowSec: now })).toBeNull();
    expect(getZaloMediaCache(byStream, 0)?.error).toBe('too_large');
    expect(fs.existsSync(ZALO_MEDIA_CACHE_DIR) ? fs.readdirSync(ZALO_MEDIA_CACHE_DIR) : []).toEqual([]);
  });

  it('refuses an "image" that is not an image', async () => {
    const id = message({ hdUrl: IMG });
    const html = vi.fn(async () => ok('<html>login</html>', 'text/html'));
    expect(await getCachedZaloMedia(id, 0, { fetchImpl: html as unknown as typeof fetch, nowSec: now })).toBeNull();
    expect(getZaloMediaCache(id, 0)?.error).toBe('not_image');
  });

  it('remembers a failure for an hour, then tries again', async () => {
    const id = message({ hdUrl: IMG });
    const fail = vi.fn(async () => new Response('gone', { status: 404 }));
    const deps = (f: ReturnType<typeof vi.fn>) => ({ fetchImpl: f as unknown as typeof fetch, nowSec: now });
    expect(await getCachedZaloMedia(id, 0, deps(fail))).toBeNull();
    expect(getZaloMediaCache(id, 0)).toMatchObject({ error: 'http_404', fetched_at: clock });
    clock += MEDIA_CACHE_RETRY_SEC - 1;
    expect(await getCachedZaloMedia(id, 0, deps(fail))).toBeNull();
    expect(fail).toHaveBeenCalledTimes(1);

    clock += 2;
    const good = vi.fn(async () => ok(PNG));
    expect(await getCachedZaloMedia(id, 0, deps(good))).not.toBeNull();
    expect(good).toHaveBeenCalledTimes(1);
    expect(getZaloMediaCache(id, 0)?.error).toBe('');
  });

  it('records a network error as a failure', async () => {
    const id = message({ hdUrl: IMG });
    const boom = vi.fn(async () => { throw new Error('socket hang up'); });
    expect(await getCachedZaloMedia(id, 0, { fetchImpl: boom as unknown as typeof fetch, nowSec: now })).toBeNull();
    expect(getZaloMediaCache(id, 0)?.error).toBe('fetch_failed');
  });

  it('keeps a file message under its own name and a neutral type', async () => {
    const id = message({ href: 'https://f21-zpc.zdn.vn/doc?x=1', title: 'Bảng giá.pdf' }, 'file');
    const fetchImpl = vi.fn(async () => ok('%PDF-1.4 data', 'application/pdf'));
    const got = await getCachedZaloMedia(id, 0, { fetchImpl: fetchImpl as unknown as typeof fetch, nowSec: now });
    expect(got).toMatchObject({ mime: 'application/pdf', fileName: 'Bảng giá.pdf' });
    expect(path.extname(got!.filePath)).toBe('.pdf');
  });
});
