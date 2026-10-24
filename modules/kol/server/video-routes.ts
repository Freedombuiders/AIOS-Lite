/**
 * /api/kol/videos — campaign videos of a KOL (see video-library.ts for the disk layout).
 *
 *   GET /:kolId                        → { kolId, campaigns: VideoLibraryIndex[] } (empty list when none)
 *   GET /:kolId/:campaignId            → VideoLibraryIndex, 404 when the campaign does not exist
 *   GET /:kolId/:campaignId/:variant   → the mp4, with Range support
 */
import { Hono } from 'hono';
import { serveFile } from './serve-file.js';
import { getKolVideoLibrary, listKolVideoLibraries, resolveVariantFile } from './video-library.js';

const router = new Hono();

router.get('/:kolId/:campaignId/:variant', (c) => {
  const { kolId, campaignId, variant } = c.req.param();
  const file = resolveVariantFile(kolId, campaignId, variant);
  if (!file) return c.json({ error: 'Không tìm thấy video.' }, 404);
  return serveFile(c, file);
});

router.get('/:kolId/:campaignId', (c) => {
  const { kolId, campaignId } = c.req.param();
  const library = getKolVideoLibrary(kolId, campaignId);
  if (!library) return c.json({ error: 'Không tìm thấy chiến dịch video.' }, 404);
  return c.json(library);
});

router.get('/:kolId', (c) => {
  const { kolId } = c.req.param();
  return c.json({ kolId, campaigns: listKolVideoLibraries(kolId) });
});

export default router;
