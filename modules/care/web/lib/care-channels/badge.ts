// Sidebar badge of "Hộp thư chung": the number of conversations in the "Cần tôi" tab (`inboxCounts.byView.me` of
// GET /api/m/care/conversations?view=me&limit=1). One shared poller for every subscriber (30 s), paused while the tab is
// hidden, 0 while loading or on any error: the same shape as lib/attention-count.ts.

import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { apiGet } from '@/lib/api';
import { INBOX_BADGE_PATH, INBOX_BADGE_POLL_MS, meCountFrom } from './badge-view';
import type { CareInboxCountsDto } from '@modules/care/server/api/dto-inbox';

/** Poll only while the tab is visible (or when there is no document, e.g. tests). */
function shouldPoll(state: string | undefined): boolean {
  return state === undefined || state === 'visible';
}

export const careInboxCount = signal(0);

let subscribers = 0;
let timer: ReturnType<typeof setInterval> | null = null;

export async function refreshCareInboxCount(): Promise<void> {
  if (!shouldPoll(typeof document === 'undefined' ? undefined : document.visibilityState)) return;
  try {
    careInboxCount.value = meCountFrom(await apiGet<{ inboxCounts?: Partial<CareInboxCountsDto> }>(INBOX_BADGE_PATH));
  } catch {
    careInboxCount.value = 0;
  }
}

function onVisibility(): void {
  if (shouldPoll(document.visibilityState)) void refreshCareInboxCount();
}

function start(): void {
  subscribers += 1;
  if (subscribers > 1) return;
  void refreshCareInboxCount();
  timer = setInterval(() => void refreshCareInboxCount(), INBOX_BADGE_POLL_MS);
  document.addEventListener('visibilitychange', onVisibility);
}

function stop(): void {
  subscribers = Math.max(0, subscribers - 1);
  if (subscribers > 0) return;
  if (timer) clearInterval(timer);
  timer = null;
  document.removeEventListener('visibilitychange', onVisibility);
}

export function useCareInboxCount(): number {
  useEffect(() => {
    start();
    return stop;
  }, []);
  return careInboxCount.value;
}
