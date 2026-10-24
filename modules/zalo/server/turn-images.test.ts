import fs from 'fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ZaloMessageRow } from './store.js';
import { prepareTurnImages, zaloImageUrl } from './turn-images.js';

const png = Buffer.from('89504e470d0a1a0a', 'hex');
function image(id = 1, over: Partial<ZaloMessageRow> = {}): ZaloMessageRow {
  return {
    id, thread_id: 1, zalo_msg_id: String(id), cli_msg_id: null, sender_type: 'customer', sender_uid: 'c1', sender_name: 'An',
    body: JSON.stringify({ hdUrl: 'https://photo.zdn.vn/full.png', thumb: 'https://photo.zdn.vn/thumb.png' }),
    content_type: 'image', quote_json: null, mentions_json: null, origin: 'live', is_deleted: 0, sent_at: 0, created_at: 0, ...over,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('Zalo turn images', () => {
  it('prefers full resolution and rejects arbitrary, insecure or credentialled URLs', () => {
    expect(zaloImageUrl(image().body)).toBe('https://photo.zdn.vn/full.png');
    for (const href of ['https://127.0.0.1/x', 'https://zdn.vn.attacker.com/x', 'http://photo.zdn.vn/x', 'https://user:pass@photo.zdn.vn/x', 'https://photo.zdn.vn:444/x']) {
      expect(zaloImageUrl(JSON.stringify({ href }))).toBeNull();
    }
    expect(zaloImageUrl('broken')).toBeNull();
  });

  it('downloads a verified image, maps it to the message and removes its temporary files', async () => {
    const fetcher = vi.fn(async () => new Response(png, { headers: { 'content-type': 'image/png' } }));
    vi.stubGlobal('fetch', fetcher);
    const prepared = await prepareTurnImages([image()], new AbortController().signal);
    const localPath = prepared.context.split('\n').find((line) => line.startsWith('Tin #1: '))!.slice('Tin #1: '.length);
    try {
      expect(fs.readFileSync(localPath)).toEqual(png);
      expect(fetcher.mock.calls[0]).toEqual(['https://photo.zdn.vn/full.png', expect.objectContaining({ redirect: 'error' })]);
    } finally { prepared.cleanup(); }
    expect(fs.existsSync(localPath)).toBe(false);
  });

  it('caps images and ignores recalled and outbound images', async () => {
    const fetcher = vi.fn(async () => new Response(png));
    vi.stubGlobal('fetch', fetcher);
    const prepared = await prepareTurnImages([
      ...[1, 2, 3, 4, 5].map((id) => image(id)), image(6, { is_deleted: 1 }), image(7, { sender_type: 'self' }),
    ], new AbortController().signal);
    try {
      expect(fetcher).toHaveBeenCalledTimes(4);
      expect(prepared.context).not.toContain('Tin #1:');
      expect(prepared.context).toContain('Tin #5:');
    } finally { prepared.cleanup(); }
  });

  it('reports expired URLs, oversized responses and non-image payloads without inventing image content', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 403 }))
      .mockResolvedValueOnce(new Response(png, { headers: { 'content-length': String(9 * 1024 * 1024) } }))
      .mockResolvedValueOnce(new Response('not an image', { headers: { 'content-type': 'image/png' } })));
    const prepared = await prepareTurnImages([image(1), image(2), image(3)], new AbortController().signal);
    expect(prepared.context.match(/không tải được ảnh/g)).toHaveLength(3);
    prepared.cleanup();
  });

  it('avoids downloads when there is no image reader and propagates cancellation', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const prepared = await prepareTurnImages([image()], new AbortController().signal, false);
    expect(prepared.context).toContain('provider hiện tại không có công cụ đọc ảnh');
    expect(fetcher).not.toHaveBeenCalled();
    const abort = new AbortController();
    abort.abort(new Error('cancelled'));
    await expect(prepareTurnImages([image()], abort.signal)).rejects.toThrow('cancelled');
  });
});
