import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeContext } from './test-context.js';
import { gmailMessage } from './connectors/email/fake-transport.js';
let h: ReturnType<typeof makeContext>;
beforeEach(() => { h = makeContext(); }); afterEach(() => h.close());
it('feeds new Gmail messages to the Care registry and commits coverage', async () => {
  h.transport.deliver(gmailMessage({ sentAtMs: Date.now() - 30_000 }));
  expect(await h.sync.syncAccountNow(h.accountId)).toMatchObject({ inserted: 1 });
  expect(h.care.careChannels.ingest).toHaveBeenCalledWith(expect.objectContaining({ type: 'message.created', accountId: h.accountId }));
  expect(h.sync.connector.store.getMailbox(h.accountId)?.coveredSec).toBeGreaterThan(0);
});
it('does no provider work when the module is disabled or Care is missing', async () => {
  h.settings.set('enabled', false); await h.sync.poll(); expect(h.transport.listCalls).toHaveLength(0);
  h.settings.set('enabled', true); vi.spyOn(h.ctx.modules, 'get').mockReturnValue(undefined);
  expect(await h.sync.syncAccountNow(h.accountId)).toHaveProperty('skipped'); expect(h.transport.listCalls).toHaveLength(0);
});
it('refreshes using the entity id belonging to each connection', async () => {
  vi.mocked(h.api.listGmailConnections).mockResolvedValue([{ id: 'other', entityId: 'other-user', toolkit: 'gmail', status: 'ACTIVE', alias: null, authConfigId: 'ac' }]);
  await h.sync.refreshAccountsFromComposio();
  expect(h.api.fetchGmailProfile).toHaveBeenCalledWith({ connectionId: 'other', entityId: 'other-user' });
  expect(h.store.getEmailAccount(h.accountId)?.status).toBe('MISSING');
});
it('fails closed when Care has no authoritative ownership epoch', async () => {
  vi.mocked(h.care.careChannels.getActiveEpoch).mockReturnValue(0);
  await expect(h.sync.syncAccountNow(h.accountId)).rejects.toThrow('phiên sở hữu'); expect(h.transport.listCalls).toHaveLength(0);
});
