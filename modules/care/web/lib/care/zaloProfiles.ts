// Names and avatars of a Zalo conversation's people: GET /api/m/care/conversations/:id/profiles (legacy-owned Zalo only).

import { useFetch } from '@/lib/useFetch';
import type { CareApiChannel } from './dto';

export interface ZaloPerson { name: string; avatarUrl: string }
export interface ZaloProfiles {
  thread: ZaloPerson;
  senders: Record<string, ZaloPerson>;
}

/** Zalo only; other channels (and conversations the legacy module does not own: 404) yield null. */
export function useZaloProfiles(conversationId: string, channel: CareApiChannel): ZaloProfiles | null {
  const path = channel === 'zalo' ? `/api/m/care/conversations/${encodeURIComponent(conversationId)}/profiles` : null;
  return useFetch<ZaloProfiles>(path, 120_000).data;
}
