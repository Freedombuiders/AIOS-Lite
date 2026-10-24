import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { errorBody } from '../../api/errors.js';
import type { IntegrationValues, IntegrationTestResult } from '../types.js';
import { composioClient, composioKey, keyFingerprint } from './client.js';
import { GOOGLE_SERVICES } from './google.js';

export interface OAuthProvider {
  createAuth(toolkit: string): Promise<string>;
  link(userId: string, authConfigId: string): Promise<{ id: string; redirectUrl?: string | null }>;
  account(id: string): Promise<{ id: string; status: string; toolkit: { slug: string }; isDisabled?: boolean }>;
}

/** The slice of the credential store the OAuth flow needs. */
export interface OAuthStore {
  load(id: string): IntegrationValues | null;
  save(id: string, values: IntegrationValues, result: IntegrationTestResult): void;
  remove(id: string): void;
}

const provider = (key: string): OAuthProvider => {
  const client = composioClient(key);
  const options = () => ({ signal: AbortSignal.timeout(20_000) });
  return {
    async createAuth(toolkit) {
      const configs = await client.authConfigs.list({ toolkit, isComposioManaged: true }, options());
      const existing = configs.items.find((c) => c.status === 'ENABLED' && c.toolkit.slug === toolkit);
      return existing?.id || (await client.authConfigs.create(toolkit, { type: 'use_composio_managed_auth', name: `AIOS ${toolkit}` }, options())).id;
    },
    link: (user, auth) => client.connectedAccounts.link(user, auth, undefined, options()),
    account: (id) => client.connectedAccounts.get(id, options()),
  };
};

export const pendingId = (id: string) => `oauth-pending-${id}`;
const TTL = 15 * 60_000;

export function registerIntegrationOAuthRoutes(app: Hono, io: OAuthStore, makeProvider = provider): void {
  const busy = new Set<string>();

  app.post('/api/integrations/:id/oauth/start', async (c) => {
    const id = c.req.param('id');
    const service = GOOGLE_SERVICES.find((s) => s.id === id);
    if (!service) return c.json(errorBody('not_found', 'Dịch vụ không hỗ trợ đăng nhập Google.'), 404);
    if (busy.has(id)) return c.json(errorBody('conflict', 'Đang chuẩn bị đăng nhập. Vui lòng chờ.'), 409);
    busy.add(id);
    try {
      const key = composioKey();
      const fingerprint = keyFingerprint(key);
      const prior = io.load(pendingId(id));
      if (prior && prior.key_fingerprint === fingerprint && Number(prior.expires_at) > Date.now()) {
        return c.json({ redirectUrl: prior.redirect_url });
      }
      const remote = makeProvider(key);
      const auth = await remote.createAuth(service.toolkit);
      // Unique user per attempt avoids adopting another installation's existing account.
      const user = `aios-${randomUUID()}`;
      const request = await remote.link(user, auth);
      const url = new URL(request.redirectUrl || '');
      if (url.protocol !== 'https:' || !(url.hostname === 'composio.dev' || url.hostname.endsWith('.composio.dev'))) throw new Error('Invalid redirect');
      if (keyFingerprint(composioKey()) !== fingerprint) throw new Error('Key changed');
      io.save(pendingId(id), { connection_id: request.id, user_id: user, redirect_url: url.href, key_fingerprint: fingerprint, expires_at: String(Date.now() + TTL) }, { ok: true, detail: 'Chờ đăng nhập' });
      return c.json({ redirectUrl: url.href });
    } catch {
      return c.json(errorBody('bad_request', 'Không mở được đăng nhập. Kiểm tra Composio API key ở mục Composio, sau đó thử lại.'), 400);
    } finally {
      busy.delete(id);
    }
  });

  app.post('/api/integrations/:id/oauth/check', async (c) => {
    const id = c.req.param('id');
    const service = GOOGLE_SERVICES.find((s) => s.id === id);
    if (!service) return c.json(errorBody('not_found', 'Dịch vụ không hợp lệ.'), 404);
    const pending = io.load(pendingId(id));
    if (!pending || Number(pending.expires_at) <= Date.now()) {
      return c.json(errorBody('conflict', 'Phiên đăng nhập chưa bắt đầu hoặc đã hết hạn. Bấm Đăng nhập Google để mở lại.'), 409);
    }
    try {
      const key = composioKey();
      if (pending.key_fingerprint !== keyFingerprint(key)) throw new Error('Key changed');
      const account = await makeProvider(key).account(pending.connection_id!);
      if (account.id !== pending.connection_id || account.toolkit.slug !== service.toolkit) throw new Error('Wrong account');
      if (account.status !== 'ACTIVE' || account.isDisabled) return c.json({ connected: false, status: account.status });
      // A disconnect or another start while the request was in flight must not restore access.
      if (io.load(pendingId(id))?.connection_id !== pending.connection_id || keyFingerprint(composioKey()) !== pending.key_fingerprint) throw new Error('Connection changed');
      io.save(id, { connection_id: account.id, user_id: pending.user_id!, key_fingerprint: pending.key_fingerprint! }, { ok: true, detail: 'Đã đăng nhập qua Composio.', accountLabel: service.name });
      io.remove(pendingId(id));
      return c.json({ connected: true });
    } catch {
      return c.json(errorBody('bad_request', 'Không xác nhận được tài khoản. Kiểm tra Composio và thử đăng nhập lại.'), 400);
    }
  });
}
