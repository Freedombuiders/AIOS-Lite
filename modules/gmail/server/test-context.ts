import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { vi } from 'vitest';
import type { ModuleContext } from '../../../src/modules/sdk.js';
import { createEmailStore } from './store.js';
import { createEmailSync, type CareProvides } from './sync.js';
import type { GmailApi } from './gmail.js';
import { FakeEmailTransport } from './connectors/email/fake-transport.js';
export function makeContext() {
  const db = new Database(':memory:'); db.exec(readFileSync(new URL('../migrations/001_init.sql', import.meta.url), 'utf8'));
  const settings = new Map<string, unknown>([['enabled', true]]);
  const care: CareProvides = { careChannels: { register: vi.fn(), unregister: vi.fn(), ingest: vi.fn(async () => ({ outcome: 'created' })), getActiveEpoch: vi.fn(() => 1) } };
  const ctx = { id: 'gmail', db, dataDir: '/tmp/gmail-test', crypto: { encrypt: (s: string) => s, decrypt: (s: string) => s }, settings: { get: (k: string, fallback: unknown) => settings.get(k) ?? fallback, set: (k: string, v: unknown) => settings.set(k, v) }, modules: { get: () => care, isEnabled: () => true }, schedule: { every: vi.fn(() => vi.fn()) }, connections: { secret: () => 'fake-key', has: () => true }, events: { emit: vi.fn() }, attention: { raise: vi.fn(), resolve: vi.fn() }, log: { info: vi.fn(), warn: vi.fn() }, outbound: { sanitize: (s: string) => s } } as unknown as ModuleContext;
  const store = createEmailStore(db, ctx.crypto), transport = new FakeEmailTransport();
  const api = { listGmailConnections: vi.fn(async () => []), fetchGmailProfile: vi.fn(async () => ({ emailAddress: 'shop@example.com' })), startGmailConnect: vi.fn(async () => ({ redirectUrl: 'https://example.com/oauth' })) } as unknown as GmailApi;
  const sync = createEmailSync(ctx, store, api, transport);
  const a = store.upsertEmailAccountFromConnection({ connectionId: 'ca_test', entityId: 'user', emailAddress: 'shop@example.com', status: 'ACTIVE' });
  store.updateEmailAccount(a.id, { syncEnabled: true, careSince: Math.floor(Date.now() / 1000) - 600 });
  return { ctx, db, store, api, sync, transport, care, accountId: a.id, settings, close: () => db.close() };
}
