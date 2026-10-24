/** Freesound API v2 (sound effects). Token auth in the Authorization header; previews need no auth. */
import { readBytes, send, sendJson, type HttpOptions } from '../media-http.js';

export const FREESOUND_BASE_URL = 'https://freesound.org/apiv2';
export const CC0_FILTER = 'license:"Creative Commons 0"';

export interface FreesoundClientOptions extends HttpOptions { apiKey: string }

export interface FreesoundSound {
  id: number;
  name: string;
  url?: string;
  username?: string;
  duration?: number;
  license?: string;
  tags?: string[];
  description?: string;
  previews?: Record<string, string>;
}

const FIELDS = 'id,name,url,username,duration,license,tags,description,previews';

export interface SearchParams { query: string; pageSize?: number; minDuration?: number; maxDuration?: number; cc0Only?: boolean }

export function createFreesoundClient(opts: FreesoundClientOptions) {
  const headers = { Authorization: `Token ${opts.apiKey}` };
  const get = <T>(path: string, query: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') p.set(k, String(v));
    return sendJson<T>({ service: 'Freesound', secret: opts.apiKey, url: `${FREESOUND_BASE_URL}${path}?${p}`, headers }, opts);
  };
  return {
    /** Cheapest authenticated call, used by the connection test. */
    ping: () => get<{ count?: number }>('/search/text/', { query: 'ping', page_size: 1, fields: 'id' }),
    search: (p: SearchParams) => {
      const filters: string[] = [];
      if (p.cc0Only !== false) filters.push(CC0_FILTER);
      if (p.minDuration !== undefined || p.maxDuration !== undefined) filters.push(`duration:[${p.minDuration ?? 0} TO ${p.maxDuration ?? '*'}]`);
      return get<{ count?: number; results: FreesoundSound[] }>('/search/text/', {
        query: p.query, page_size: p.pageSize ?? 10, fields: FIELDS, filter: filters.join(' ') || undefined,
      });
    },
    sound: (id: string) => get<FreesoundSound>(`/sounds/${encodeURIComponent(id)}/`, { fields: FIELDS }),
    /** Downloads a preview mp3 (public CDN link taken from the API response). */
    async downloadPreview(url: string, maxBytes: number): Promise<Buffer> {
      const res = await send({ service: 'Freesound', secret: opts.apiKey, url, headers: { Accept: 'audio/mpeg' } }, opts);
      return readBytes(res, maxBytes, 'Freesound');
    },
  };
}
export type FreesoundClient = ReturnType<typeof createFreesoundClient>;

export const isCc0 = (license: string | undefined): boolean => /publicdomain\/zero|creative commons 0/i.test(license ?? '');
export const isCcBy = (license: string | undefined): boolean => /licenses\/by\/(3|4)\.0/i.test(license ?? '');
