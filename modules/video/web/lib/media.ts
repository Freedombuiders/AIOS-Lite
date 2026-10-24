import { tokenizedSseUrl } from '@/lib/api';

/** Media URL with the dashboard token, for every <img>/<video> src served by the KOL or video modules. */
export function media(url: string | null | undefined): string {
  return url ? tokenizedSseUrl(url) : '';
}
