/**
 * `GET /conversations/:id/profiles`: names and avatars of a chat conversation's people, from the account's connector
 * (Zalo: the other person of a 1-1 chat or the group, plus the recent customer senders). Display only and best effort:
 * 404 when the connector has no profiles or knows nothing of the conversation, and the inbox shows initials instead.
 *
 * `storedAvatarSource` gives the list rows the picture the connector already stored, without a provider call.
 * Only https links leave this file; the connector owns the host allowlist.
 */

import type { Hono } from 'hono';
import type { CareAccountRecord, CareConversationRecord } from '../../../_lib/care-kit/types.js';
import type { CareConnectorPerson, CareConnectorProfiles, ConnectorRegistry } from '../connectors/registry.js';
import type { CareStores } from '../persistence/index.js';
import type { CareApiContext } from './context.js';
import type { CareConversationProfilesDto, CarePersonDto } from './dto.js';
import { notFound } from './errors.js';
import { idParam } from './util.js';

const httpsOnly = (url: unknown): string => (typeof url === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(url) && url.length <= 2048 ? url : '');

const person = (p: CareConnectorPerson | undefined): CarePersonDto => ({
  name: typeof p?.name === 'string' ? p.name.trim().slice(0, 200) : '',
  avatarUrl: httpsOnly(p?.avatarUrl),
});

/** List-row picture of a conversation, from the connector's stored data. */
export function storedAvatarSource(stores: CareStores, connectors: ConnectorRegistry): (rec: CareConversationRecord) => string | null {
  const accounts = new Map<string, CareAccountRecord>();
  return (rec) => {
    let account = accounts.get(rec.accountId);
    if (!account) {
      account = stores.accounts.getAccount(rec.accountId) ?? undefined;
      if (!account) return null;
      accounts.set(account.id, account);
    }
    return httpsOnly(connectors.forAccount(account)?.storedAvatarUrl?.(account.id, rec.externalKey)) || null;
  };
}

export function registerProfileRoutes(sub: Hono, ctx: CareApiContext): void {
  sub.get('/conversations/:id/profiles', async (c) => {
    const m = ctx.model();
    const id = idParam(c.req.param('id'));
    const found = m.read(() => {
      const conv = m.stores.conversations.getConversation(id);
      if (!conv || !ctx.canReadSource(conv.accountId)) return null;
      const account = m.stores.accounts.getAccount(conv.accountId);
      return account ? { conv, account, senders: m.recentSenders(id) } : null;
    });
    const connector = found ? ctx.connectors?.forAccount(found.account) : null;
    if (!found || !connector?.profiles) throw notFound();

    let res: CareConnectorProfiles | null = null;
    try {
      res = await connector.profiles(found.account.id, found.conv.externalKey, found.senders.map((s) => s.nativeId));
    } catch {
      res = null; // a name lookup never fails the inbox
    }
    if (!res) throw notFound();

    // The connector answers by native sender ID; the inbox knows senders by identity.
    const senders: Record<string, CarePersonDto> = {};
    for (const s of found.senders) {
      const p = person(Object.prototype.hasOwnProperty.call(res.senders, s.nativeId) ? res.senders[s.nativeId] : undefined);
      if (p.name || p.avatarUrl) senders[s.identityId] = p;
    }
    const thread = person(res.thread);
    const body: CareConversationProfilesDto = { thread: { ...thread, name: thread.name || found.conv.title }, senders };
    return c.json(body);
  });
}
