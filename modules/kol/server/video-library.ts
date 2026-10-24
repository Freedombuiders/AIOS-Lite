/**
 * KOL campaign video library, read from disk:
 *
 *   videos/personas/<folder>/<campaign>/metadata.json
 *   videos/personas/<folder>/<campaign>/variants/<file>.mp4
 *
 * Folders are named by slug ("tony-trieu"), while the dashboard knows a KOL by its
 * persona id (UUID). `resolveKolFolder` maps one to the other through the persona's
 * name or handle. Every path segment is checked against SAFE_SEGMENT so a URL can
 * never point outside the library.
 */
import { join } from 'path';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { kolVideosDir } from './config.js';
import { getPersona } from './personas.js';

export type VideoVariantKey = 'a' | 'b' | 'c';
export type VideoStatus = 'draft' | 'ready' | 'published';

export interface VideoAsset {
  id: string;
  variant: VideoVariantKey;
  name: string;
  filename: string;
  duration: number;
  resolution: string;
  aspectRatio: string;
  status: VideoStatus;
  script: string;
  tone: string;
  size: number;
  url: string;
}

export interface VideoLibraryIndex {
  campaign: string;
  title: string;
  description: string;
  kol: string;
  totalVariants: number;
  /** Variants planned in metadata whose video is not rendered yet. */
  pendingVariants: VideoVariantKey[];
  variants: VideoAsset[];
  metadata: {
    eventDate: string;
    eventLocation: string;
    targetAudience: string[];
  };
}

const VARIANT_KEYS: VideoVariantKey[] = ['a', 'b', 'c'];
const SAFE_SEGMENT = /^[a-z0-9][a-z0-9_-]{0,80}$/i;

function videosBase(): string {
  return kolVideosDir();
}

export function isSafeSegment(s: string): boolean {
  return typeof s === 'string' && SAFE_SEGMENT.test(s);
}

/** "Tony Trieu" → "tony-trieu", "Đào Thị Ngọc" → "dao-thi-ngoc". */
export function slugify(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function personaDir(folder: string): string {
  return join(videosBase(), 'personas', folder);
}

/** The library folder of a KOL given its persona id or folder slug, or null when it has none. */
export function resolveKolFolder(kolId: string): string | null {
  if (!isSafeSegment(kolId)) return null;
  if (existsSync(personaDir(kolId))) return kolId;
  let persona: { name: string; handle: string } | null = null;
  try {
    persona = getPersona(kolId);
  } catch {
    persona = null;
  }
  if (!persona) return null;
  const candidates = [slugify(persona.name), slugify(persona.handle ?? '')].filter(isSafeSegment);
  return candidates.find((c) => existsSync(personaDir(c))) ?? null;
}

function normalizeStatus(raw: unknown): VideoStatus {
  const s = String(raw ?? '').toLowerCase();
  if (s === 'published') return 'published';
  if (s === 'completed' || s === 'ready' || s === 'approved') return 'ready';
  return 'draft';
}

function readJson(path: string): Record<string, any> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

/** Absolute path of a rendered variant, or null. */
export function resolveVariantFile(kolId: string, campaignId: string, variant: string): string | null {
  if (!VARIANT_KEYS.includes(variant as VideoVariantKey) || !isSafeSegment(campaignId)) return null;
  const folder = resolveKolFolder(kolId);
  if (!folder) return null;
  const campaignPath = join(personaDir(folder), campaignId);
  const variantsPath = join(campaignPath, 'variants');
  if (!existsSync(variantsPath)) return null;

  const declared = readJson(join(campaignPath, 'metadata.json'))?.video_variants?.[variant]?.file;
  if (typeof declared === 'string' && /^[\w.-]+\.mp4$/i.test(declared) && existsSync(join(variantsPath, declared))) {
    return join(variantsPath, declared);
  }
  const found = readdirSync(variantsPath).find((f) => f.toLowerCase().endsWith('.mp4') && f.startsWith(`variant-${variant}`));
  return found ? join(variantsPath, found) : null;
}

export function getKolVideoLibrary(kolId: string, campaignId: string): VideoLibraryIndex | null {
  if (!isSafeSegment(campaignId)) return null;
  const folder = resolveKolFolder(kolId);
  if (!folder) return null;
  const metadata = readJson(join(personaDir(folder), campaignId, 'metadata.json'));
  if (!metadata) return null;

  const planned = (metadata.video_variants ?? {}) as Record<string, Record<string, unknown>>;
  const variants: VideoAsset[] = [];
  const pendingVariants: VideoVariantKey[] = [];

  for (const key of VARIANT_KEYS) {
    const data = planned[key];
    if (!data) continue;
    const file = resolveVariantFile(kolId, campaignId, key);
    if (!file) {
      pendingVariants.push(key);
      continue;
    }
    variants.push({
      id: `${folder}-${campaignId}-${key}`,
      variant: key,
      name: String(data.name ?? `Phiên bản ${key.toUpperCase()}`),
      filename: file.split('/').pop() ?? '',
      duration: Number(data.duration) || 0,
      resolution: String(data.resolution ?? ''),
      aspectRatio: String(data.aspect_ratio ?? ''),
      status: normalizeStatus(data.status),
      script: String(data.script ?? ''),
      tone: String(data.tone ?? ''),
      size: statSync(file).size,
      url: `/api/kol/videos/${encodeURIComponent(kolId)}/${encodeURIComponent(campaignId)}/${key}`,
    });
  }

  const index = readJson(join(personaDir(folder), 'campaigns-index.json'));
  const entry = Array.isArray(index?.campaigns) ? index.campaigns.find((c: any) => c?.id === campaignId) : null;

  return {
    campaign: campaignId,
    title: String(entry?.name ?? metadata.title ?? campaignId),
    description: String(metadata.description ?? entry?.description ?? ''),
    kol: folder,
    totalVariants: variants.length,
    pendingVariants,
    variants,
    metadata: {
      eventDate: String(metadata.event_date ?? ''),
      eventLocation: String(metadata.event_location ?? ''),
      targetAudience: Array.isArray(metadata.target_audience) ? metadata.target_audience.map(String) : [],
    },
  };
}

/** Campaign ids of a KOL that have a metadata.json, sorted. Empty when the KOL has no library. */
export function getAllKolCampaigns(kolId: string): string[] {
  const folder = resolveKolFolder(kolId);
  if (!folder) return [];
  try {
    return readdirSync(personaDir(folder))
      .filter((item) => isSafeSegment(item) && existsSync(join(personaDir(folder), item, 'metadata.json')))
      .sort();
  } catch {
    return [];
  }
}

export function listKolVideoLibraries(kolId: string): VideoLibraryIndex[] {
  return getAllKolCampaigns(kolId)
    .map((c) => getKolVideoLibrary(kolId, c))
    .filter((l): l is VideoLibraryIndex => l !== null);
}
