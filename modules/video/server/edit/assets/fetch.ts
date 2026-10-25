// Brings a chosen candidate into the library: a library ref is returned as is, a Pexels clip or photo is
// downloaded and added (addFile) with its licence, credit line and page link. A clip already downloaded
// (same Pexels page) is reused.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { addFile, findAsset, getLibrary, LibraryError, libraryTmpDir, slugOf, type LibraryAsset } from '../library/store.js';
import { hub } from './hub.js';
import { stockItem, usableAsset } from './providers.js';

export async function fetchCandidate(ref: string, opts: { keywords?: string[] } = {}): Promise<{ asset: LibraryAsset; downloaded: boolean }> {
  const h = hub();
  if (!ref.startsWith('pexels:')) {
    const asset = findAsset(h.root, ref);
    if (!asset || !usableAsset(asset)) throw new LibraryError(404, 'Không tìm thấy file này trong kho.', 'not_found');
    return { asset, downloaded: false };
  }
  const item = stockItem(ref);
  if (!item) throw new LibraryError(404, 'Không còn thông tin của cảnh này. Tìm lại rồi chọn.', 'stale_ref');
  const existing = getLibrary(h.root).find((a) => a.sourceUrl === item.pageUrl && usableAsset(a));
  if (existing) return { asset: existing, downloaded: false };

  fs.mkdirSync(libraryTmpDir(h.root), { recursive: true });
  const temp = path.join(libraryTmpDir(h.root), `pexels-${randomUUID()}.${item.ext}`);
  try {
    try {
      await h.download(item.link, temp);
    } catch (err) {
      throw new LibraryError(422, `Không tải được từ Pexels: ${(err as Error).message.slice(0, 200)}`, 'download_failed');
    }
    const id = ref.split(':')[2] ?? '';
    const asset = await addFile(h.root, {
      kind: item.kind, tempPath: temp, fileName: `pexels-${slugOf(item.title).slice(0, 50) || 'stock'}-${id}.${item.ext}`,
      meta: {
        name: item.title.slice(0, 120), description: item.title.slice(0, 1000),
        tags: ['pexels', ...(opts.keywords ?? []).map((k) => k.trim().slice(0, 40)).filter(Boolean).slice(0, 6)],
        license: 'Pexels License', attribution: `${item.kind === 'video' ? 'Video' : 'Ảnh'}: ${item.by ?? 'Pexels'} · Pexels`, sourceUrl: item.pageUrl,
      },
    });
    return { asset, downloaded: true };
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
