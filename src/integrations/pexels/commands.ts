/**
 * Pexels commands for `integration-cli pexels <command>`. Output is compact JSON:
 * only what an editor needs to choose a clip or photo. Nothing is downloaded here:
 * Pexels' licence allows use in a video but not rebuilding a stock library from it.
 */
import { IntegrationUsageError, type IntegrationCommand, type IntegrationCommandContext, type ParsedArgs } from '../types.js';
import { assertFlags, enumFlag, numFlag, requireText } from '../arg-helpers.js';
import type { FetchImpl } from '../media-http.js';
import { createPexelsClient, type PexelsClient, type PexelsVideo, type PexelsVideoFile } from './client.js';

export interface PexelsCommandDeps { fetchImpl?: FetchImpl; sleepImpl?: (ms: number) => Promise<void> }

const ORIENTATIONS = ['landscape', 'portrait', 'square'] as const;

function clientFor(ctx: IntegrationCommandContext, deps: PexelsCommandDeps): PexelsClient {
  const apiKey = ctx.values.api_key?.trim();
  if (!apiKey) throw new IntegrationUsageError('Chưa có API key Pexels. Chủ nhập ở trang Integrations.');
  return createPexelsClient({ apiKey, signal: ctx.signal, fetchImpl: deps.fetchImpl, sleepImpl: deps.sleepImpl });
}

/** The mp4 closest to full HD without going far above it. */
export function bestVideoFile(files: PexelsVideoFile[] | undefined): PexelsVideoFile | undefined {
  const mp4 = (files ?? []).filter((f) => f.link && (f.file_type ?? 'video/mp4') === 'video/mp4');
  if (mp4.length === 0) return undefined;
  const score = (f: PexelsVideoFile) => {
    const long = Math.max(f.width ?? 0, f.height ?? 0);
    return long === 0 ? 1e9 : Math.abs(long - 1920);
  };
  return [...mp4].sort((a, b) => score(a) - score(b))[0];
}

function compactVideo(v: PexelsVideo) {
  const file = bestVideoFile(v.video_files);
  return {
    id: String(v.id), pageUrl: v.url, durationSec: v.duration, width: v.width, height: v.height,
    by: v.user?.name, thumbnail: v.image,
    file: file ? { quality: file.quality, width: file.width, height: file.height, link: file.link } : undefined,
  };
}

const SEARCH_FLAGS = ['orientation', 'limit'];

function searchParams(args: ParsedArgs) {
  return {
    query: requireText(args, 'từ khoá tìm', 'videos search "coffee shop" --orientation portrait'),
    orientation: enumFlag(args, 'orientation', ORIENTATIONS),
    perPage: numFlag(args, 'limit', { min: 1, max: 40, int: true }) ?? 10,
  };
}

export function buildPexelsCommands(deps: PexelsCommandDeps = {}): IntegrationCommand[] {
  return [
    {
      name: 'videos search',
      access: 'read',
      usage: '<query> [--orientation landscape|portrait|square] [--min-duration s] [--max-duration s] [--limit n]',
      description: 'Search Pexels stock videos. Returns id, page URL, duration, size, author, thumbnail and the best mp4 link (about 1080p).',
      async run(ctx, args) {
        assertFlags(args, [...SEARCH_FLAGS, 'min-duration', 'max-duration']);
        const p = searchParams(args);
        const min = numFlag(args, 'min-duration', { min: 0 });
        const max = numFlag(args, 'max-duration', { min: 0 });
        const res = await clientFor(ctx, deps).searchVideos({ ...p, perPage: min !== undefined || max !== undefined ? 40 : p.perPage });
        const videos = (res.videos ?? [])
          .filter((v) => (min === undefined || v.duration >= min) && (max === undefined || v.duration <= max))
          .slice(0, p.perPage)
          .map(compactVideo);
        return { query: p.query, total: res.total_results ?? videos.length, videos };
      },
    },
    {
      name: 'photos search',
      access: 'read',
      usage: '<query> [--orientation landscape|portrait|square] [--limit n]',
      description: 'Search Pexels stock photos. Returns id, page URL, size, photographer, alt text and image links (large, original).',
      async run(ctx, args) {
        assertFlags(args, SEARCH_FLAGS);
        const p = searchParams(args);
        const res = await clientFor(ctx, deps).searchPhotos(p);
        return {
          query: p.query,
          total: res.total_results ?? (res.photos ?? []).length,
          photos: (res.photos ?? []).map((ph) => ({
            id: String(ph.id), pageUrl: ph.url, width: ph.width, height: ph.height, by: ph.photographer, alt: ph.alt,
            large: ph.src?.large2x ?? ph.src?.large, original: ph.src?.original,
          })),
        };
      },
    },
  ];
}

export const pexelsCommands: IntegrationCommand[] = buildPexelsCommands();
