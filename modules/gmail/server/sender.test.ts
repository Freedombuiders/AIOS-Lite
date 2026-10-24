import { expect, it } from 'vitest';
import { makeContext } from './test-context.js';
import type { EmailDeliveryCommand } from '../../_lib/care-kit/index.js';
const command = (id: string): EmailDeliveryCommand => ({ kind: 'email', channel: 'email', accountId: id, clientRequestId: 'req-one', adapterRetryToken: 'token-one', actor: 'manual', purpose: 'care', ownerEpoch: 1, text: 'Xin chào', target: { externalConversationKey: 'gmail-thread', to: ['buyer@example.com'], subject: 'Re: Hỏi giá' } });
it('replies in the original thread with the configured signature exactly once', async () => {
  const h = makeContext();
  try {
    h.store.updateEmailAccount(h.accountId, { signature: 'Trân trọng, Shop' });
    const cmd = command(h.accountId);
    expect((await h.sync.connector.dispatch(cmd)).outcome).toBe('accepted');
    expect((await h.sync.connector.dispatch(cmd)).outcome).toBe('accepted');
    expect(h.transport.sendCalls).toHaveLength(1);
    expect(h.transport.sendCalls[0]).toMatchObject({ threadId: 'gmail-thread', body: 'Xin chào\n\nTrân trọng, Shop' });
  } finally { h.close(); }
});
it('refuses disabled mailboxes and enforces the account send cap', async () => {
  const h = makeContext();
  try {
    h.store.updateEmailAccount(h.accountId, { dailySendCap: 1 });
    await h.sync.connector.dispatch(command(h.accountId));
    expect((await h.sync.connector.dispatch({ ...command(h.accountId), clientRequestId: 'two', adapterRetryToken: 'token-two' })).outcome).toBe('failed');
    h.settings.set('enabled', false);
    expect((await h.sync.connector.dispatch(command(h.accountId))).outcome).toBe('failed'); expect(h.transport.sendCalls).toHaveLength(1);
  } finally { h.close(); }
});
