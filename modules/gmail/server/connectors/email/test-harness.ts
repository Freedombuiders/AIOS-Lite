import Database from 'better-sqlite3';
import { EmailCareConnector, type EmailConnectorOptions, type EmailAccountConfig, type EmailSyncResult } from './email-connector.js';
import { FakeEmailTransport, gmailMessage } from './fake-transport.js';
import { ensureEmailConnectorSchema } from './store.js';
import type { EmailDeliveryCommand, NormalizedEvent, SyncCommand } from '../../../../_lib/care-kit/index.js';
import type { GmailMessage } from './transport.js';
export { gmailMessage };
export const T0_MS = Date.UTC(2027, 0, 15, 8), MIN = 60_000;
export function makeEmailHarness(over: Partial<EmailConnectorOptions> & { cfg?: Partial<EmailAccountConfig>; address?: string } = {}) {
  const db = new Database(':memory:'); ensureEmailConnectorSchema(db);
  const clock = { ms: T0_MS }, accountId = 'test-mailbox';
  const account = { id: accountId, ownerEpoch: 1, healthStatus: 'healthy' };
  const transport = new FakeEmailTransport(); transport.profileAddress = over.address ?? 'shop@example.com'; transport.clock = { nowMs: clock.ms };
  const cfg: EmailAccountConfig = { target: { connectionId: 'ca_test', entityId: 'entity_test' }, address: transport.profileAddress, careSinceMs: T0_MS - 60 * MIN, backfillDays: 2, ...over.cfg };
  const build = (extra: Partial<EmailConnectorOptions> = {}) => new EmailCareConnector({ db, transport, resolveAccount: () => cfg, getActiveEpoch: () => account.ownerEpoch, now: () => clock.ms, ...over, ...extra });
  const seen = new Set<string>();
  const events: NormalizedEvent[] = [];
  const h = { db, accountId, account, transport, clock, cfg, connector: build(), events,
    stores: { accounts: { getAccount: () => account } },
    ingest: { ingestNormalizedEvent(e: NormalizedEvent) { if (seen.has(e.eventId)) return { outcome: 'duplicate_event' }; seen.add(e.eventId); events.push(e); return { outcome: 'created' }; } },
    advance(ms: number) { clock.ms += ms; transport.clock.nowMs = clock.ms; },
    restart(extra: Partial<EmailConnectorOptions> = {}) { h.connector = build(extra); return h.connector; },
    close() { db.close(); },
  };
  return h;
}
export type EmailHarness = ReturnType<typeof makeEmailHarness>;
export function inbound(h: EmailHarness, over: Partial<GmailMessage> = {}, ageSec = 30) { return gmailMessage({ sentAtMs: h.clock.ms - ageSec * 1000, ...over }); }
export function ingestAll(h: EmailHarness, res: Pick<EmailSyncResult, 'events'>) {
  const outcomes: string[] = [], failedEventIds: string[] = [];
  for (const e of res.events) { try { outcomes.push(h.ingest.ingestNormalizedEvent(e).outcome); } catch { failedEventIds.push(e.eventId); } }
  return { outcomes, failedEventIds };
}
export async function syncOnce(h: EmailHarness, command: Partial<SyncCommand> = {}) {
  const res = await h.connector.sync({ accountId: h.accountId, ...command });
  const report = ingestAll(h, res); h.connector.commit(h.accountId, res.commits, report);
  return { ...res, ...report };
}
let seq = 0;
export function emailCmd(h: EmailHarness, over: Partial<EmailDeliveryCommand> & { token?: string } = {}): EmailDeliveryCommand {
  const { token, ...rest } = over; seq++;
  return { kind: 'email', channel: 'email', clientRequestId: `req-${seq}`, accountId: h.accountId,
    target: { externalConversationKey: 't-thread-1', to: ['buyer@example.com'], subject: 'Re: Question about my order', replyToMessageId: 'm-orig', inReplyToHeader: '<orig@mail.example.com>' },
    text: 'Your parcel ships tomorrow.', purpose: 'care', actor: 'manual', ownerEpoch: h.account.ownerEpoch, adapterRetryToken: token ?? `care-token-${seq}`, ...rest };
}
