/**
 * CARE-10 end to end: the real module (migrations, runtime, routes) loaded by the module manager over in-memory deps,
 * a fake connector registered through provides.careChannels, and a fake lean agent (autoFinish) behind runLean.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CareChannelsApi } from './module-runtime.js';
import { FakeCareConnector } from './connectors/fake-connector.js';
import { createModuleManager } from '../../../src/modules/manager.js';
import { createTestHarness, type TestHarness } from '../../../src/modules/test-deps.js';
import type { ModuleManager } from '../../../src/modules/contracts.js';
import { chatMessage } from './test-fixtures.js';

const MODULES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPLY = JSON.stringify({ action: 'reply', replies: [{ text: 'Dạ shop còn hàng ạ, anh/chị cần size nào ạ?' }], needsReview: false });

let h: TestHarness;
let mgr: ModuleManager;
let app: Hono;
let channels: CareChannelsApi;
let connector: FakeCareConnector;
let accountId: string;
let leanCalls: number;

const api = (method: string, url: string, body?: unknown) =>
  app.request(`/api/m/care${url}`, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const until = async (cond: () => boolean | Promise<boolean>, ms = 8_000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timed out waiting for condition');
};

async function boot(opts: { scopes?: string[]; mode?: 'draft' | 'auto'; settings?: Record<string, unknown> } = {}) {
  h = createTestHarness({ modulesDir: MODULES_DIR });
  mgr = createModuleManager(h.deps, { fromDist: false });
  (h.deps as { modules: ModuleManager }).modules = mgr;
  leanCalls = 0;
  h.fakes.state.autoFinish = () => {
    leanCalls += 1;
    return { status: 'done', output: REPLY };
  };
  await mgr.add('care', { installAgents: true });
  h.fakes.agents.get('cskh')!.access.modules.care = opts.scopes ?? ['inbox.read', 'customers.read', 'reply.draft', 'reply.send'];
  mgr.updateSettings('care', { autoDelaySeconds: 0, quietHoursStart: '00:00', quietHoursEnd: '00:00', ...opts.settings });
  app = new Hono();
  mgr.mount(app);
  channels = mgr.provides<{ careChannels: CareChannelsApi }>('care')!.careChannels;
  connector = new FakeCareConnector('fake', 'zalo');
  channels.register(connector);
  accountId = channels.ensureAccount({ id: 'shop-1', channel: 'zalo', connectorKind: 'fake', label: 'Zalo shop' }).id;
  const res = await api('POST', '/assignments', { scope: 'account', accountId, mode: opts.mode ?? 'draft', agentId: 'cskh', priority: 100 });
  expect(res.status).toBe(201);
}

async function inbound(text: string, key = 'peer:1') {
  const message = chatMessage({ id: accountId, channel: 'zalo' }, { externalConversationKey: key, text, sentAtMs: Date.now() });
  const ev = { type: 'message.created' as const, eventId: `ev-${message.nativeMessageId}`, accountId, timestampMs: message.sentAtMs, message };
  expect((await channels.ingest(ev)).outcome).toBe('stored');
  const conv = h.deps.db.prepare('SELECT id FROM care_conversations WHERE account_id = ? AND external_key = ?').get(accountId, key) as { id: string };
  expect((await channels.ingest(ev)).outcome).toBe('duplicate');
  return { conversationId: conv.id };
}

const drafts = async () => (await json<{ items: Array<{ id: string; payloadRevision: number; status: string; text: string }> }>(await api('GET', '/drafts?status=draft'))).items;

beforeEach(() => undefined);
afterEach(async () => {
  await mgr?.stop();
  h?.cleanup();
});

describe('care end to end (fake connector, fake lean agent)', () => {
  it('inbound -> lean run -> draft -> approve -> sent, and the owner sees it in attention', async () => {
    await boot();
    await inbound('Cho mình hỏi áo này còn không?');
    await until(async () => (await drafts()).length === 1);
    expect(leanCalls).toBe(1);
    expect(connector.providerSendCount).toBe(0); // the agent cannot send
    const [draft] = await drafts();
    expect(draft!.text).toContain('còn hàng');
    await until(() => [...h.fakes.attention.keys()].some((k) => k.includes('care:draft:')));
    const attention = [...h.fakes.attention.values()].find((a) => a.key.includes('care:draft:'))!;
    expect(attention.link).toMatch(/^\/m\/care\/inbox\//);

    const approve = await api('POST', `/drafts/${draft!.id}/approve`, { expectedRevision: draft!.payloadRevision });
    expect(approve.status).toBe(200);
    await until(() => connector.providerSendCount === 1);
    await until(async () => (await drafts()).length === 0);
    await until(() => ![...h.fakes.attention.keys()].some((k) => k.includes('care:draft:')), 12_000);
  }, 30_000);

  it('auto mode sends after the delay and the Undo (cancel) stops it', async () => {
    await boot({ mode: 'auto', settings: { autoDelaySeconds: 600 } });
    await inbound('Mình muốn đặt 2 cái');
    await until(async () => (await json<{ items: Array<{ status: string }> }>(await api('GET', '/runs'))).items.length > 0);
    const outbox = () => h.deps.db.prepare("SELECT id, status FROM care_delivery_intents WHERE account_id = ?").all(accountId) as Array<{ id: string; status: string }>;
    await until(() => outbox().length === 1);
    expect(outbox()[0]!.status).toBe('pending');
    expect(connector.providerSendCount).toBe(0);
    const cancel = await api('POST', `/outbox/${outbox()[0]!.id}/cancel`, {});
    expect(cancel.status).toBe(200);
    expect(outbox()[0]!.status).toBe('cancelled');
    await new Promise((r) => setTimeout(r, 1_500));
    expect(connector.providerSendCount).toBe(0);
  }, 30_000);

  it('auto mode really sends once the delay is zero', async () => {
    await boot({ mode: 'auto' });
    await inbound('Giá bao nhiêu vậy shop?');
    await until(() => connector.providerSendCount === 1);
    expect(leanCalls).toBe(1);
  }, 30_000);

  it('without reply.send the auto mode degrades to a draft', async () => {
    await boot({ mode: 'auto', scopes: ['inbox.read', 'customers.read', 'reply.draft'] });
    await inbound('Còn size M không ạ?');
    await until(async () => (await drafts()).length === 1);
    expect(connector.providerSendCount).toBe(0);
  }, 30_000);

  it('quiet hours turn an automatic reply into a draft', async () => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const start = new Date(now.getTime() - 3_600_000);
    const end = new Date(now.getTime() + 3_600_000);
    await boot({ mode: 'auto', settings: { quietHoursStart: `${pad(start.getHours())}:${pad(start.getMinutes())}`, quietHoursEnd: `${pad(end.getHours())}:${pad(end.getMinutes())}` } });
    await inbound('Shop ơi cho hỏi chút');
    await until(async () => (await drafts()).length === 1);
    expect(connector.providerSendCount).toBe(0);
  }, 30_000);

  it('a takeover stops the AI for that conversation', async () => {
    await boot();
    const first = await inbound('Xin chào shop', 'peer:7');
    await until(async () => (await drafts()).length === 1);
    expect(leanCalls).toBe(1);
    const take = await api('PUT', `/conversations/${first.conversationId}/takeover`, { on: true });
    expect(take.status).toBe(200);
    await inbound('Bạn ơi trả lời giúp mình với', 'peer:7');
    await new Promise((r) => setTimeout(r, 2_500));
    expect(leanCalls).toBe(1);
    expect(await drafts()).toHaveLength(1);
  }, 30_000);
});
