// Names and avatars of a Zalo conversation's people: GET /api/m/care/conversations/:id/profiles (from the Zalo module).

import { useFetch } from '@/lib/useFetch';
import type { CareApiChannel, CareConversationProfilesDto, CarePersonDto } from './dto';

export type ZaloPerson = CarePersonDto;
/** `senders` is keyed by the message's `senderIdentityId`. */
export type ZaloProfiles = CareConversationProfilesDto;

/** Zalo only; other channels (and conversations the Zalo module does not know: 404) yield null. */
export function useZaloProfiles(conversationId: string, channel: CareApiChannel): ZaloProfiles | null {
  const path = channel === 'zalo' ? `/api/m/care/conversations/${encodeURIComponent(conversationId)}/profiles` : null;
  return useFetch<ZaloProfiles>(path, 120_000).data;
}
