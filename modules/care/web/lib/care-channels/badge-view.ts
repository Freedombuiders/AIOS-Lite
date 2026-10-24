// Pure half of the "Hộp thư chung" sidebar badge (the poller is in badge.ts). Kept free of browser imports so vitest runs it.

import type { CareInboxCountsDto } from '@modules/care/server/api/dto-inbox';

export const INBOX_BADGE_POLL_MS = 30_000;
export const INBOX_BADGE_PATH = '/api/m/care/conversations?view=me&limit=1';

/** The "Cần tôi" number out of a conversations payload; anything unexpected counts as 0. */
export function meCountFrom(payload: { inboxCounts?: Partial<CareInboxCountsDto> | null } | null | undefined): number {
  const n = payload?.inboxCounts?.byView?.me;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
