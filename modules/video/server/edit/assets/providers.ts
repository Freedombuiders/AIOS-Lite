// Asset Hub sources, searched in this order: the owner's footage for the project, the owner's library
// ("Kho của tôi"), Pexels videos, Pexels photos. Every candidate carries its licence, author and source link.
import { bestVideoFile } from '../../../../../src/integrations/pexels/commands.js';
import type { PexelsPhoto, PexelsVideo } from '../../../../../src/integrations/pexels/client.js';
import { DEFAULT_LICENSE, getLibrary, type LibraryAsset } from '../library/store.js';
import type { VideoAspect, VideoProject } from '../types.js';
import { hub } from './hub.js';
import { matchScore, terms } from './match.js';
import type { AssetCandidate, AssetLicense, AssetSource } from './types.js';

export const SOURCE_ORDER: readonly AssetSource[] = ['project', 'mine', 'pexels', 'pexels-photo'];

export interface AssetQuery {
  /** Short search words; English for the stock sources. */
  keywords: string[];
  /** The full description (matched against library captions, used again when scoring). */
  description?: string;
  /** Default video and image. */
  kinds?: AssetCandidate['kind'][];
  /** Frame of the video being made; default 9:16. */
  aspect?: VideoAspect;
  projectId?: string;
  /** Shortest usable stock clip, seconds (kept within 1..30). */
  minSec?: number;
  /** Per source. */
  limit?: number;
}

export interface AssetProvider {
  source: AssetSource;
  /** Why this source is skipped right now (no Pexels key…), or null when it can be searched. */
  unavailable(): string | null;
  search(q: AssetQuery): Promise<AssetCandidate[]>;
}

const STOCK_MIN_SEC = 1;
const STOCK_MAX_SEC = 30;
const DEFAULT_LIMIT = 6;

/** Height / width of each output frame. */
const RATIO: Record<VideoAspect, number> = { '9:16': 16 / 9, '4:5': 5 / 4, '1:1': 1, '16:9': 9 / 16 };
const ORIENTATION: Record<VideoAspect, 'portrait' | 'landscape' | 'square'> = { '9:16': 'portrait', '4:5': 'portrait', '1:1': 'square', '16:9': 'landscape' };

/** The picture is close to the output frame: within 15 % for video (no letterbox), 25 % for photos (cropped). */
export function fitsAspect(width: number | undefined, height: number | undefined, aspect: VideoAspect, tolerance: number): boolean {
  if (!width || !height) return false;
  return Math.abs(height / width / RATIO[aspect] - 1) <= tolerance;
}

const wantKinds = (q: AssetQuery) => q.kinds ?? ['video', 'image'];

// ── Library sources ──

/** A library file the hub may offer: present, enabled, not a mood alias of another track. */
export function usableAsset(a: LibraryAsset): boolean {
  return Boolean(a.file && a.available && a.enabled !== false && !a.aliasOf);
}

/** A sticker (emoji PNG of the starter pack, or a file tagged so): a graphic for the Đồ hoạ track, never a filler shot. */
export function isSticker(a: Pick<LibraryAsset, 'tags'>): boolean {
  return (a.tags ?? []).some((t) => t === 'sticker' || t === 'nhãn dán');
}

export function libraryLicense(a: LibraryAsset): AssetLicense {
  return {
    name: a.license || DEFAULT_LICENSE,
    ...(a.attribution ? { creator: a.attribution } : {}),
    ...(a.sourceUrl ? { sourceUrl: a.sourceUrl } : {}),
    // A credit line on a library file means the licence asks for it (CC-BY); Pexels only appreciates it.
    attributionRequired: Boolean(a.attribution) && !/pexels/i.test(a.license ?? ''),
  };
}

export function libraryCandidate(a: LibraryAsset, source: AssetSource, hint?: string): AssetCandidate {
  return {
    ref: a.id, source, kind: a.kind as AssetCandidate['kind'],
    caption: a.caption || hint || a.description || a.name,
    ...(a.durationSec ? { durationSec: a.durationSec } : {}),
    license: libraryLicense(a),
  };
}

const assetText = (a: LibraryAsset, hint?: string) => [hint, a.caption, a.name, a.description, a.mood, a.genre, ...(a.tags ?? [])].filter(Boolean).join(' ');

function loadProject(id: string | undefined): VideoProject | null {
  if (!id) return null;
  try { return hub().store.loadProject(id); } catch { return null; }
}

/** The footage the owner attached in Dựng nhanh, best text match first (all of it is offered). */
const projectProvider: AssetProvider = {
  source: 'project',
  unavailable: () => null,
  async search(q) {
    const project = loadProject(q.projectId);
    const attached = project?.quick?.assets ?? [];
    if (attached.length === 0) return [];
    const kinds = wantKinds(q);
    const byId = new Map(getLibrary(hub().root).map((a) => [a.id, a]));
    const want = terms([q.description, ...q.keywords].filter(Boolean).join(' '));
    return attached
      .map(({ assetId, hint }) => ({ a: byId.get(assetId), hint }))
      .filter((x): x is { a: LibraryAsset; hint: string | undefined } => Boolean(x.a && usableAsset(x.a) && kinds.includes(x.a.kind as AssetCandidate['kind'])))
      .map((x) => ({ ...x, score: matchScore(want, terms(assetText(x.a, x.hint))) }))
      .sort((x, y) => y.score - x.score)
      .slice(0, q.limit ?? DEFAULT_LIMIT)
      .map((x) => libraryCandidate(x.a, 'project', x.hint));
  },
};

/** Kho của tôi: library files whose caption/name/tags share words with the query. */
const mineProvider: AssetProvider = {
  source: 'mine',
  unavailable: () => null,
  async search(q) {
    const kinds = wantKinds(q);
    const attached = new Set((loadProject(q.projectId)?.quick?.assets ?? []).map((x) => x.assetId));
    const want = terms([q.description, ...q.keywords].filter(Boolean).join(' '));
    const minSec = Math.max(STOCK_MIN_SEC, Math.min(STOCK_MAX_SEC, q.minSec ?? 0));
    return getLibrary(hub().root)
      .filter((a) => usableAsset(a) && kinds.includes(a.kind as AssetCandidate['kind']) && !attached.has(a.id) && !isSticker(a))
      .filter((a) => a.kind !== 'video' || !a.durationSec || a.durationSec >= minSec)
      .map((a) => ({ a, score: matchScore(want, terms(assetText(a))) }))
      .filter((x) => x.score > 0)
      .sort((x, y) => y.score - x.score || (y.a.quality ?? 0.5) - (x.a.quality ?? 0.5))
      .slice(0, q.limit ?? DEFAULT_LIMIT)
      .map((x) => libraryCandidate(x.a, 'mine'));
  },
};

// ── Pexels ──

/** What a stock candidate needs for its download, kept from the search (refs are short ids). */
export interface StockItem {
  kind: 'video' | 'image';
  link: string;
  ext: string;
  pageUrl: string;
  by?: string;
  title: string;
}

const STOCK_MEMORY = 500;
const stockItems = new Map<string, StockItem>();

function remember(ref: string, item: StockItem): void {
  stockItems.delete(ref);
  stockItems.set(ref, item);
  if (stockItems.size > STOCK_MEMORY) stockItems.delete(stockItems.keys().next().value!);
}

export const stockItem = (ref: string): StockItem | undefined => stockItems.get(ref);

/** "https://www.pexels.com/video/woman-drinking-coffee-3195394/" → "woman drinking coffee". */
export function titleFromPexelsUrl(url: string): string {
  const m = /\/(?:video|photo)\/([^/]+?)-\d+\/?$/.exec(url);
  return m ? m[1].replace(/-/g, ' ') : '';
}

export const pexelsLicense = (by: string | undefined, pageUrl: string): AssetLicense =>
  ({ name: 'Pexels License', ...(by ? { creator: by } : {}), sourceUrl: pageUrl, attributionRequired: false });

const NO_KEY = 'Chưa có API key Pexels (Integrations › Pexels): bỏ qua nguồn Pexels.';
const searchText = (q: AssetQuery) => q.keywords.map((k) => k.trim()).filter(Boolean).join(' ') || q.description?.trim() || '';

const pexelsVideoProvider: AssetProvider = {
  source: 'pexels',
  unavailable: () => (hub().pexels() ? null : NO_KEY),
  async search(q) {
    const client = hub().pexels();
    const query = searchText(q);
    if (!client || !query || !wantKinds(q).includes('video')) return [];
    const aspect = q.aspect ?? '9:16';
    const minSec = Math.max(STOCK_MIN_SEC, Math.min(STOCK_MAX_SEC, q.minSec ?? STOCK_MIN_SEC));
    const r = await client.searchVideos({ query, orientation: ORIENTATION[aspect], perPage: 30 });
    const out: AssetCandidate[] = [];
    for (const v of (r.videos ?? []) as PexelsVideo[]) {
      if (!(v.duration >= minSec && v.duration <= STOCK_MAX_SEC)) continue;
      const file = bestVideoFile(v.video_files);
      if (!file?.link) continue;
      const width = file.width || v.width;
      const height = file.height || v.height;
      if (!fitsAspect(width, height, aspect, 0.15)) continue;
      const ref = `pexels:video:${v.id}`;
      const title = titleFromPexelsUrl(v.url);
      remember(ref, { kind: 'video', link: file.link, ext: 'mp4', pageUrl: v.url, by: v.user?.name, title: title || query });
      out.push({
        ref, source: 'pexels', kind: 'video', caption: title || query,
        ...(v.image ? { thumbUrl: v.image } : {}), durationSec: v.duration, width, height,
        license: pexelsLicense(v.user?.name, v.url),
      });
      if (out.length >= (q.limit ?? DEFAULT_LIMIT)) break;
    }
    return out;
  },
};

const photoExt = (url: string) => {
  const ext = /\.([a-z0-9]+)(?:\?|$)/i.exec(new URL(url).pathname)?.[1]?.toLowerCase() ?? 'jpeg';
  return ['jpg', 'jpeg', 'png', 'webp'].includes(ext) ? ext : 'jpeg';
};

const pexelsPhotoProvider: AssetProvider = {
  source: 'pexels-photo',
  unavailable: () => (hub().pexels() ? null : NO_KEY),
  async search(q) {
    const client = hub().pexels();
    const query = searchText(q);
    if (!client || !query || !wantKinds(q).includes('image')) return [];
    const aspect = q.aspect ?? '9:16';
    const r = await client.searchPhotos({ query, orientation: ORIENTATION[aspect], perPage: 30 });
    const out: AssetCandidate[] = [];
    for (const ph of (r.photos ?? []) as PexelsPhoto[]) {
      const link = ph.src?.large2x ?? ph.src?.large ?? ph.src?.original;
      if (!link || !fitsAspect(ph.width, ph.height, aspect, 0.25)) continue;
      const ref = `pexels:photo:${ph.id}`;
      const title = ph.alt?.trim() || titleFromPexelsUrl(ph.url) || query;
      remember(ref, { kind: 'image', link, ext: photoExt(link), pageUrl: ph.url, by: ph.photographer, title });
      const thumb = ph.src?.medium ?? ph.src?.small ?? ph.src?.tiny;
      out.push({
        ref, source: 'pexels-photo', kind: 'image', caption: title,
        ...(thumb ? { thumbUrl: thumb } : {}), width: ph.width, height: ph.height,
        license: pexelsLicense(ph.photographer, ph.url),
      });
      if (out.length >= (q.limit ?? DEFAULT_LIMIT)) break;
    }
    return out;
  },
};

export const PROVIDERS: Record<AssetSource, AssetProvider> = {
  project: projectProvider, mine: mineProvider, pexels: pexelsVideoProvider, 'pexels-photo': pexelsPhotoProvider,
};

/** One source's results, or why it gave none (skipped, failed). */
export async function searchSource(source: AssetSource, q: AssetQuery): Promise<{ candidates: AssetCandidate[]; note?: string }> {
  const provider = PROVIDERS[source];
  const skip = provider.unavailable();
  if (skip) return { candidates: [], note: skip };
  try {
    return { candidates: await provider.search(q) };
  } catch (err) {
    return { candidates: [], note: `Không tìm được ở nguồn ${source}: ${(err as Error).message.slice(0, 200)}` };
  }
}

/** Every source in order; notes say which were skipped or failed (a missing Pexels key is not an error). */
export async function searchAssets(q: AssetQuery, sources: readonly AssetSource[] = SOURCE_ORDER): Promise<{ candidates: AssetCandidate[]; notes: string[] }> {
  const candidates: AssetCandidate[] = [];
  const notes = new Set<string>();
  for (const source of sources) {
    const r = await searchSource(source, q);
    candidates.push(...r.candidates);
    if (r.note) notes.add(r.note);
  }
  return { candidates, notes: [...notes] };
}
