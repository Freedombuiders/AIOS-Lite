import { describe, expect, it, vi } from 'vitest';
import type { IngestContext } from './ingest.js';
import { resolveSticker, stickerId } from './stickers.js';

describe('stored stickers', () => {
  it('accepts real stored IDs including category zero, rejects malformed IDs', () => {
    expect(stickerId('{"id":3,"catId":0,"type":7}')).toBe(3);
    expect(stickerId('{"id":"50367","catId":12556}')).toBe(50367);
    for (const body of ['plain', '{}', '{"id":-1}', '{"id":true}', '{"id":1.2}']) expect(stickerId(body)).toBeNull();
  });
  it('resolves SDK metadata once for concurrent and repeated calls', async () => {
    const lookup = vi.fn().mockResolvedValue([{ id: 50367, stickerUrl: 'https://cdn.example/sticker.png', stickerWebpUrl: 'https://cdn.example/sticker.webp' }]);
    const ctx = { accountId: 'cache-test', api: { getStickersDetail: lookup } } as unknown as IngestContext;
    const values = await Promise.all([resolveSticker(ctx, 50367), resolveSticker(ctx, 50367)]);
    expect(values[0]).toEqual({ staticUrl: 'https://cdn.example/sticker.png', webpUrl: 'https://cdn.example/sticker.webp' });
    await resolveSticker(ctx, 50367);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith([50367]);
  });
  it('rejects missing/unsafe URLs and lets subsequent requests retry', async () => {
    const lookup = vi.fn().mockResolvedValueOnce([{ stickerUrl: 'javascript:alert(1)' }]).mockResolvedValueOnce([{ stickerUrl: 'https://cdn.example/ok.png' }]);
    const ctx = { accountId: 'retry-test', api: { getStickersDetail: lookup } } as unknown as IngestContext;
    await expect(resolveSticker(ctx, 1)).rejects.toThrow('Không tìm thấy');
    await expect(resolveSticker(ctx, 1)).resolves.toMatchObject({ staticUrl: 'https://cdn.example/ok.png' });
  });
});
