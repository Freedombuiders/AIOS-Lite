import type { ModuleContext } from '../../../src/modules/sdk.js';
import type { CareConnector, NormalizedEvent } from '../../_lib/care-kit/index.js';
import { EmailCareConnector } from './connectors/email/email-connector.js';
import { createGmailTransport } from './connectors/email/gmail-transport.js';
import type { EmailTransport } from './connectors/email/transport.js';
import type { GmailApi } from './gmail.js';
import type { EmailStore } from './store.js';
import { signedEmailBody } from './sender.js';

export interface CareProvides {
  careChannels: {
    register(connector: CareConnector): void;
    unregister(id: string): void;
    ingest(event: NormalizedEvent): unknown | Promise<unknown>;
    getActiveEpoch(accountId: string): number;
    /** create/map the care account for a mailbox, reusing the mailbox id as the care account id */
    ensureAccount?(input: { id: string; channel: 'email'; connectorKind: string; label: string; address?: string }): { id: string; epoch: number };
  };
}

export function createEmailSync(ctx: ModuleContext, store: EmailStore, api: GmailApi, transport?: EmailTransport) {
  const care = () => ctx.modules.get<CareProvides>('care')?.careChannels;
  const connector = new EmailCareConnector({
    db: ctx.db,
    transport: transport ?? createGmailTransport(api),
    resolveAccount(id) {
      const a = store.getEmailAccount(id);
      if (!a || !a.sync_enabled || a.care_since == null) return null;
      return { target: { connectionId: a.connection_id, entityId: a.entity_id }, address: a.email_address,
        careSinceMs: Number(store.getEmailSetting(`activation_ms:${id}`)) || a.care_since * 1000, backfillDays: 0, seedCoveredSec: a.care_since };
    },
    getActiveEpoch(id) {
      const epoch = care()?.getActiveEpoch?.(id);
      if (!Number.isSafeInteger(epoch) || !epoch || epoch < 1) throw new Error('Chưa có phiên sở hữu hộp thư trong Care.');
      return epoch;
    },
  });
  const dispatch = connector.dispatch.bind(connector);
  const sendLanes = new Map<string, Promise<unknown>>();
  connector.dispatch = (cmd) => {
    const previous = sendLanes.get(cmd.accountId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
    const account = store.getEmailAccount(cmd.accountId);
    if (!ctx.settings.get<boolean>('enabled', false) || !account?.sync_enabled || account.status !== 'ACTIVE') {
      return { outcome: 'failed' as const, error: 'Hộp thư chưa bật hoặc đã mất kết nối.' };
    }
    const existing = connector.store.getAttemptByRequest(account.id, cmd.clientRequestId);
    if (!existing && (ctx.db.prepare("SELECT COUNT(*) AS n FROM email_connector_attempts WHERE account_id = ? AND state IN ('accepted', 'uncertain', 'prepared') AND first_rpc_at_ms >= ?").get(account.id, Date.now() - 86_400_000) as { n: number }).n >= account.daily_send_cap) {
      return { outcome: 'failed' as const, error: 'Đã đạt giới hạn gửi trong ngày.' };
    }
    const text = signedEmailBody(cmd.text, account.signature, ctx.outbound.sanitize);
    const result = await dispatch({ ...cmd, text });
    if (result.outcome === 'uncertain') ctx.attention.raise({ key: `gmail:send:${cmd.clientRequestId}`, title: 'Chưa xác định kết quả gửi Gmail', detail: 'Kiểm tra thư đã gửi trước khi gửi lại.', link: '/m/care/inbox', severity: 'warn' });
    return result;
    });
    sendLanes.set(cmd.accountId, run);
    void run.finally(() => { if (sendLanes.get(cmd.accountId) === run) sendLanes.delete(cmd.accountId); }).catch(() => undefined);
    return run;
  };
  let running = false;
  async function syncAccountNow(id: string) {
    const a = store.getEmailAccount(id);
    const registry = care();
    if (!ctx.settings.get<boolean>('enabled', false) || !a?.sync_enabled || !registry) return { accountId: id, fetched: 0, inserted: 0, skipped: 'Chưa bật đồng bộ hoặc Care chưa sẵn sàng.' };
    registry.ensureAccount?.({ id, channel: 'email', connectorKind: connector.kind, label: a.email_address, address: a.email_address });
    const result = await connector.sync({ accountId: id });
    const failedEventIds: string[] = [];
    let inserted = 0;
    for (const event of result.events) {
      try {
        const outcome = await registry.ingest(event);
        if (outcome && typeof outcome === 'object' && 'outcome' in outcome && outcome.outcome === 'failed') throw new Error('Care từ chối sự kiện.');
        inserted++;
      } catch { failedEventIds.push(event.eventId); }
    }
    connector.commit(id, result.commits, { failedEventIds });
    store.updateEmailAccount(id, { lastPollAt: Math.floor(Date.now() / 1000) });
    ctx.events.emit('synced', { accountId: id, inserted, failed: failedEventIds.length });
    if (failedEventIds.length) throw new Error('Care chưa lưu đủ thư; lần đồng bộ sau sẽ thử lại.');
    return { accountId: id, fetched: result.fetched, inserted };
  }
  async function poll() {
    if (running) return;
    running = true;
    try {
      for (const a of store.listEmailAccounts()) {
        if (!a.sync_enabled || a.status !== 'ACTIVE') continue;
        try { await syncAccountNow(a.id); ctx.attention.resolve(`gmail:sync:${a.id}`); }
        catch { ctx.attention.raise({ key: `gmail:sync:${a.id}`, title: 'Gmail chưa đồng bộ được', detail: 'Kiểm tra kết nối Gmail và tài khoản trong Care.', link: '/m/gmail', severity: 'warn' }); }
      }
    } finally { running = false; }
  }
  async function refreshAccountsFromComposio() {
    const connections = await api.listGmailConnections();
    for (const c of connections) {
      const existing = store.getEmailAccountByConnection(c.id);
      if (c.status !== 'ACTIVE') { if (existing) store.updateEmailAccount(existing.id, { status: 'EXPIRED' }); continue; }
      const profile = await api.fetchGmailProfile({ connectionId: c.id, entityId: c.entityId });
      if (!profile.emailAddress) continue;
      store.upsertEmailAccountFromConnection({ connectionId: c.id, entityId: c.entityId, emailAddress: profile.emailAddress, status: 'ACTIVE' });
    }
    for (const a of store.listEmailAccounts()) if (!connections.some(c => c.id === a.connection_id)) store.updateEmailAccount(a.id, { status: 'MISSING' });
    ctx.events.emit('accounts-changed', {});
    return store.listEmailAccounts();
  }
  return { connector, poll, syncAccountNow, refreshAccountsFromComposio };
}
export type EmailSync = ReturnType<typeof createEmailSync>;
