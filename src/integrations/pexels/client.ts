/** Pexels API (stock video and photos). The key goes in the Authorization header. */
import { sendJson, type HttpOptions } from '../media-http.js';

export const PEXELS_BASE_URL = 'https://api.pexels.com';

export interface PexelsClientOptions extends HttpOptions { apiKey: string }

export interface PexelsVideoFile { id?: number; quality?: string; file_type?: string; width?: number; height?: number; link: string }
export interface PexelsVideo {
  id: number; url: string; image?: string; duration: number; width: number; height: number;
  user?: { name?: string; url?: string };
  video_files?: PexelsVideoFile[];
}
export interface PexelsPhoto {
  id: number; url: string; width: number; height: number; photographer?: string; alt?: string; avg_color?: string;
  src?: Record<string, string>;
}

export interface SearchParams {
  query: string;
  orientation?: 'landscape' | 'portrait' | 'square';
  size?: 'large' | 'medium' | 'small';
  perPage?: number;
  page?: number;
}

function qs(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') p.set(k, String(v));
  return p.toString();
}

export function createPexelsClient(opts: PexelsClientOptions) {
  const get = <T>(path: string, query: Record<string, string | number | undefined>) => sendJson<T>({
    service: 'Pexels', secret: opts.apiKey, url: `${PEXELS_BASE_URL}${path}?${qs(query)}`, headers: { Authorization: opts.apiKey },
  }, opts);
  const search = (p: SearchParams) => ({ query: p.query, orientation: p.orientation, size: p.size, per_page: p.perPage, page: p.page });
  return {
    /** Cheapest authenticated call, used by the connection test. */
    curated: () => get<{ photos: PexelsPhoto[] }>('/v1/curated', { per_page: 1 }),
    searchVideos: (p: SearchParams) => get<{ videos: PexelsVideo[]; total_results?: number }>('/videos/search', search(p)),
    searchPhotos: (p: SearchParams) => get<{ photos: PexelsPhoto[]; total_results?: number }>('/v1/search', search(p)),
  };
}
export type PexelsClient = ReturnType<typeof createPexelsClient>;
