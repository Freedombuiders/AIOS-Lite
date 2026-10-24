import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmailTransportError } from './transport.js';
import { makeEmailHarness, inbound, syncOnce, MIN, type EmailHarness } from './test-harness.js';
let h: EmailHarness;
afterEach(() => h?.close());
describe('Gmail mailbox coverage', () => {
  it('only ingests messages strictly after activation, excluding automated mail', async () => {
    h = makeEmailHarness();
    h.transport.deliver(inbound(h, { gmailMessageId: 'old' }, 7200));
    h.transport.deliver(inbound(h, { gmailMessageId: 'edge', sentAtMs: h.cfg.careSinceMs! }));
    h.transport.deliver(inbound(h, { gmailMessageId: 'new' }));
    h.transport.deliver(inbound(h, { gmailMessageId: 'bot', headers: { 'auto-submitted': 'auto-replied' } }));
    const r = await syncOnce(h);
    expect(r.events.filter(e => e.type === 'message.created').map(e => e.type === 'message.created' && e.message.nativeMessageId)).toEqual(['new']);
  });
  it('retains Reply-To separately from the sender identity and attachment metadata', async () => {
    h = makeEmailHarness(); h.transport.deliver(inbound(h, { fromEmail: 'buyer@example.com', replyTo: 'billing@example.com', attachments: [{ filename: 'a.pdf', mimeType: 'application/pdf', size: 10, attachmentId: 'a' }] }));
    const r = await syncOnce(h), e = r.events.find(e => e.type === 'message.created');
    expect(e?.type === 'message.created' && e.message).toMatchObject({ senderIdentityKey: 'buyer@example.com', metadata: { replyTo: 'billing@example.com', attachments: [{ id: 'a', fileName: 'a.pdf' }] } });
  });
  it('advances coverage only after durable ingestion and safely replays after restart', async () => {
    h = makeEmailHarness(); h.transport.deliver(inbound(h));
    const r = await h.connector.sync({ accountId: h.accountId });
    expect(h.connector.store.getMailbox(h.accountId)?.coveredSec).toBeNull();
    h.restart(); const again = await syncOnce(h);
    expect(again.events).toEqual(r.events);
    expect(h.connector.store.getMailbox(h.accountId)?.coveredSec).toBe(Math.floor(h.clock.ms / 1000));
  });
  it('retries an event whose ingestion failed without advancing past its page', async () => {
    h = makeEmailHarness(); h.transport.deliver(inbound(h));
    const spy = vi.spyOn(h.ingest, 'ingestNormalizedEvent').mockImplementation(() => { throw new Error('disk'); });
    const r = await syncOnce(h); expect(r.failedEventIds).toHaveLength(1);
    expect(h.connector.store.getMailbox(h.accountId)?.coveredSec).toBeNull();
    spy.mockRestore(); expect((await syncOnce(h)).outcomes).toEqual(['created']);
  });
  it('resumes a bounded window across multiple pages', async () => {
    h = makeEmailHarness({ maxPagesPerSync: 1 });
    for (let i = 0; i < 60; i++) h.transport.deliver(inbound(h, { gmailMessageId: `m${i}` }, i + 1));
    expect((await syncOnce(h)).hasMore).toBe(true);
    const end = h.connector.store.getMailbox(h.accountId)!.window!.endSec;
    h.advance(MIN); await syncOnce(h);
    expect(h.connector.store.getMailbox(h.accountId)).toMatchObject({ coveredSec: end, window: null });
    expect(h.events).toHaveLength(60);
  });
  it('does not call a provider for a disabled account configuration', async () => {
    h = makeEmailHarness({ resolveAccount: () => null });
    await expect(h.connector.sync({ accountId: h.accountId })).rejects.toMatchObject({ code: 'ACCOUNT_FROZEN' });
    expect(h.transport.listCalls).toHaveLength(0);
  });
  it('persists rate-limit cooldown across connector restart', async () => {
    h = makeEmailHarness(); h.transport.listFailures.push(new EmailTransportError('rate_limited', 'limit'));
    await expect(syncOnce(h)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    h.restart(); await expect(syncOnce(h)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(h.transport.listCalls).toHaveLength(1);
  });
  it('rejects checkpoints from another channel', async () => {
    h = makeEmailHarness(); await expect(h.connector.sync({ accountId: h.accountId, checkpoint: { namespace: 'zalo_chat', cursor: 'x' } })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
  });
});
