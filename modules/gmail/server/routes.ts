import type { Hono } from 'hono';
import { z } from 'zod';
import type { ModuleContext } from '../../../src/modules/sdk.js';
import type { GmailApi } from './gmail.js';
import type { EmailStore } from './store.js';
import type { EmailSync } from './sync.js';
import { presentAccount } from './serialize.js';

export function registerEmailRoutes(app: Hono, ctx: ModuleContext, store: EmailStore, api: GmailApi, sync: EmailSync) {
  const accounts = () => store.listEmailAccounts().map(a => presentAccount(a, { sentToday: store.countEmailSentSince(a.id, Date.now() - 86_400_000), threadCount: 0, draftCount: 0 }));
  app.get('/accounts', c => c.json({ accounts: accounts() }));
  app.get('/status', c => c.json({ enabled: ctx.settings.get('enabled', false), composioKey: ctx.connections.has('composio'), intervalMs: 120_000 }));
  app.post('/enable', async c => {
    const body = z.object({ enabled: z.boolean() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Dữ liệu không hợp lệ.' }, 400);
    const wasEnabled = ctx.settings.get<boolean>('enabled', false);
    ctx.settings.set('enabled', body.data.enabled);
    if (body.data.enabled && !wasEnabled) for (const a of store.listEmailAccounts()) {
      ctx.db.prepare('DELETE FROM email_connector_mailboxes WHERE account_id = ?').run(a.id);
      store.setEmailSetting(`activation_ms:${a.id}`, String(Date.now()));
      store.updateEmailAccount(a.id, { careSince: Math.floor(Date.now() / 1000), syncCursor: null });
    }
    ctx.events.emit('settings-changed', { enabled: body.data.enabled });
    return c.json({ enabled: body.data.enabled });
  });
  app.post('/accounts/connect', async c => {
    try { return c.json(await api.startGmailConnect()); }
    catch { return c.json({ error: 'Không thể kết nối Gmail. Kiểm tra kết nối Composio.' }, 502); }
  });
  app.post('/accounts/refresh', async c => {
    try { await sync.refreshAccountsFromComposio(); return c.json({ accounts: accounts() }); }
    catch { return c.json({ error: 'Không thể làm mới tài khoản Gmail.' }, 502); }
  });
  app.patch('/accounts/:id', async c => {
    const id = c.req.param('id'), a = store.getEmailAccount(id);
    if (!a) return c.json({ error: 'Không tìm thấy tài khoản.' }, 404);
    const body = z.object({ syncEnabled: z.boolean().optional(), signature: z.string().max(1000).optional(), displayName: z.string().trim().max(100).optional(), dailySendCap: z.number().int().min(1).max(2000).optional() }).strict().safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Dữ liệu không hợp lệ.' }, 400);
    if (body.data.syncEnabled && !a.sync_enabled) ctx.db.prepare('DELETE FROM email_connector_mailboxes WHERE account_id = ?').run(id);
    if (body.data.syncEnabled && !a.sync_enabled) store.setEmailSetting(`activation_ms:${id}`, String(Date.now()));
    store.updateEmailAccount(id, { ...body.data, pollMinutes: 2, backfillDays: 0,
      ...(body.data.syncEnabled && !a.sync_enabled ? { careSince: Math.floor(Date.now() / 1000), syncCursor: null } : {}) });
    ctx.events.emit('accounts-changed', { accountId: id });
    return c.json({ accounts: accounts() });
  });
  app.delete('/accounts/:id', c => {
    const id = c.req.param('id');
    if (!store.getEmailAccount(id)) return c.json({ error: 'Không tìm thấy tài khoản.' }, 404);
    sync.connector.store.purgeAccount(id); store.deleteEmailAccount(id);
    ctx.events.emit('accounts-changed', { accountId: id });
    return c.json({ ok: true });
  });
  app.post('/accounts/:id/sync', async c => {
    if (!store.getEmailAccount(c.req.param('id'))) return c.json({ error: 'Không tìm thấy tài khoản.' }, 404);
    try { return c.json(await sync.syncAccountNow(c.req.param('id'))); }
    catch { return c.json({ error: 'Chưa đồng bộ được. Kiểm tra kết nối và tài khoản Care.' }, 502); }
  });
}
