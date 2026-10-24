/**
 * Names and avatars for Care's inbox (the Zalo connector's `profiles` / `storedAvatarUrl` hooks), from this module's data.
 *
 * The open conversation is resolved by the daemon (`GET /threads/:id/profiles`: the nick's shared lookup budgets and
 * cache; it also stores the thread's avatar). Its answer is kept here for a while, so an inbox left open does not spend
 * the query budget again on every refresh. Without the daemon (stopped, nick offline) the stored zalo_threads rows answer:
 * the thread itself, and the senders who also have a 1-1 thread with the nick.
 */

import { callZaloDaemon } from './control.js';
import { getZaloThreadByExternal, type ZaloThreadRow } from './store.js';
import type { ZaloPeople, ZaloPerson } from './connectors/zalo/zalo-connector.js';

export const CARE_PROFILES_TTL_MS = 30 * 60_000;
const CACHE_MAX = 300;

export interface CareProfilesDeps {
  /** The daemon's answer for one zalo_threads row; null when it has none. Default: `GET /threads/:id/profiles`. */
  resolve?: (threadId: number) => Promise<ZaloPeople | null>;
  now?: () => number;
}

async function daemonProfiles(threadId: number): Promise<ZaloPeople | null> {
  try {
    const res = await callZaloDaemon<ZaloPeople>('GET', `/threads/${threadId}/profiles`, { timeoutMs: 30_000 });
    return res.status === 200 && res.data && typeof res.data === 'object' ? res.data : null;
  } catch {
    return null; // daemon not running or not answering
  }
}

const stored = (t: ZaloThreadRow | undefined): ZaloPerson => ({ name: t?.name ?? '', avatarUrl: t?.avatar_url ?? '' });

/** Field by field: the resolved value when it has one, else the stored one. */
const merge = (live: ZaloPerson | undefined, kept: ZaloPerson): ZaloPerson => ({
  name: live?.name || kept.name,
  avatarUrl: live?.avatarUrl || kept.avatarUrl,
});

const senderOf = (people: ZaloPeople | null, uid: string): ZaloPerson | undefined =>
  people?.senders && Object.prototype.hasOwnProperty.call(people.senders, uid) ? people.senders[uid] : undefined;

export function createCareProfiles(deps: CareProfilesDeps = {}) {
  const resolve = deps.resolve ?? daemonProfiles;
  const now = deps.now ?? Date.now;
  const cache = new Map<number, { at: number; value: ZaloPeople }>();
  const inflight = new Map<number, Promise<ZaloPeople | null>>();

  async function resolved(threadId: number): Promise<ZaloPeople | null> {
    const hit = cache.get(threadId);
    if (hit && now() - hit.at < CARE_PROFILES_TTL_MS) return hit.value;
    let pending = inflight.get(threadId);
    if (!pending) {
      pending = resolve(threadId).finally(() => inflight.delete(threadId));
      inflight.set(threadId, pending);
    }
    const value = await pending;
    if (!value) return hit?.value ?? null; // an expired answer still beats none
    cache.delete(threadId);
    cache.set(threadId, { at: now(), value });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as number);
    return value;
  }

  return {
    storedAvatarUrl(accountId: string, externalKey: string): string | null {
      return getZaloThreadByExternal(accountId, externalKey)?.avatar_url || null;
    },

    async profiles(accountId: string, externalKey: string, senderUids: string[]): Promise<ZaloPeople | null> {
      const thread = getZaloThreadByExternal(accountId, externalKey);
      if (!thread) return null;
      const live = await resolved(thread.id);
      const senders: Record<string, ZaloPerson> = {};
      for (const uid of senderUids) {
        const own = uid === thread.external_id ? thread : getZaloThreadByExternal(accountId, uid);
        const p = merge(senderOf(live, uid), own?.thread_type === 'user' ? stored(own) : stored(undefined));
        if (p.name || p.avatarUrl) senders[uid] = p;
      }
      return { thread: merge(live?.thread, stored(thread)), senders };
    },
  };
}
