/** Fixtures for the care API tests. Synthetic data, isolated SQLite, no network, not imported by production code. */

import { Hono } from 'hono';
import type { CareAccountRecord, NormalizedMessage } from '../../../_lib/care-kit/types.js';
import { createTestCareDatabase, type CareStores } from '../persistence/index.js';
import { TEST_KEY, createEligibleAccount, chatMessage, emailMessage, twoHandleFixture } from '../test-fixtures.js';
import { setRuntimeSwitch } from '../runtime/switches.js';
import { registerCareRoutes, type CareApiDeps, type CareApiHandle } from './index.js';

export const T0 = 1_700_000_000_000;

export interface ApiFixture {
  app: Hono;
  handle: CareApiHandle;
  stores: CareStores;
  db: ReturnType<typeof createTestCareDatabase>['rawDbForTestIsolationOnly'];
  gate: { canRead: boolean };
  clock: { now: number };
  errors: unknown[];
  close(): void;
  get(path: string, init?: RequestInit): Promise<Response>;
  send(method: string, path: string, body?: unknown): Promise<Response>;
}

export function makeApi(deps: Partial<CareApiDeps> = {}): ApiFixture {
  const t = createTestCareDatabase(':memory:', TEST_KEY);
  return wrapApi(t.stores, t.rawDbForTestIsolationOnly, deps, () => t.close());
}

export function wrapApi(
  stores: CareStores,
  db: ApiFixture['db'],
  deps: Partial<CareApiDeps> = {},
  closeDb: () => void = () => undefined,
  opts: { moduleOn?: boolean } = {},
): ApiFixture {
  // Care is opt-in: the dispatch gate denies everything until the module switch is on.
  if (opts.moduleOn !== false) setRuntimeSwitch(db, 'module', true, { actor: 'test' });
  const gate = { canRead: true };
  const clock = { now: T0 };
  const errors: unknown[] = [];
  // The module framework serves the care sub-app under /api/m/care; the tests mount it the same way.
  const mount = new Hono();
  const app = new Hono();
  const handle = registerCareRoutes(mount, {
    stores,
    db,
    canRead: () => gate.canRead,
    now: () => clock.now,
    sse: { pollMs: 0, heartbeatMs: 10_000, ...deps.sse },
    onError: (e) => errors.push(e),
    ...deps,
  });
  app.route('/api/m/care', mount);
  const send = (method: string, path: string, body?: unknown): Promise<Response> =>
    Promise.resolve(
      app.request(path, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  return {
    app,
    handle,
    stores,
    db,
    gate,
    clock,
    errors,
    close() {
      handle.close();
      closeDb();
    },
    get: (path, init) => Promise.resolve(app.request(path, init)),
    send,
  };
}

export function zaloAccount(stores: CareStores, label = 'Zalo shop'): CareAccountRecord {
  return createEligibleAccount(stores, { channel: 'zalo', label, nativeAccountId: `zalo-${label}` });
}

export function emailAccount(stores: CareStores, label = 'Mailbox'): CareAccountRecord {
  return createEligibleAccount(stores, { channel: 'email', connectorKind: 'gmail', label, nativeAccountId: `mail-${label}` });
}

export interface SeedMsg {
  dir?: 'in' | 'out';
  role?: NormalizedMessage['senderRole'];
  at: number;
  text?: string;
  quote?: string;
}

let uniq = 0;

/** Chat conversation with the given messages; the projection is recomputed once at the end. */
export function seedChat(
  stores: CareStores,
  account: CareAccountRecord,
  key: string,
  title: string,
  msgs: SeedMsg[],
  kind: 'direct' | 'group' | 'email_thread' = 'direct',
) {
  const conv = stores.conversations.upsertConversation({ accountId: account.id, externalKey: key, kind, title });
  for (const m of msgs) {
    uniq += 1;
    const dir = m.dir ?? 'in';
    stores.messages.insertMessage(
      chatMessage(account, {
        externalConversationKey: key,
        nativeMessageId: `${key}-${uniq}`,
        direction: dir,
        senderRole: m.role ?? (dir === 'in' ? 'customer' : 'operator'),
        sentAtMs: m.at,
        text: m.text ?? `message ${uniq}`,
      }),
      conv.id,
    );
  }
  return stores.conversations.recomputeProjection(conv.id);
}

export function seedEmail(
  stores: CareStores,
  account: CareAccountRecord,
  key: string,
  title: string,
  msgs: Array<SeedMsg & { subject?: string; from?: string }>,
) {
  const conv = stores.conversations.upsertConversation({ accountId: account.id, externalKey: key, kind: 'email_thread', title });
  for (const m of msgs) {
    uniq += 1;
    const dir = m.dir ?? 'in';
    stores.messages.insertMessage(
      emailMessage(account, {
        externalConversationKey: key,
        nativeMessageId: `${key}-${uniq}`,
        direction: dir,
        senderRole: m.role ?? (dir === 'in' ? 'customer' : 'operator'),
        sentAtMs: m.at,
        text: m.text ?? `mail body ${uniq}`,
        metadata: {
          type: 'email',
          subject: m.subject ?? 'Subject',
          from: m.from ?? 'buyer@example.com',
          to: ['shop@example.com'],
        },
      }),
      conv.id,
    );
  }
  return stores.conversations.recomputeProjection(conv.id);
}

export function appendEvent(stores: CareStores, accountId: string, conversationId: string | null, n: number, payload: Record<string, unknown> = {}) {
  return stores.events.appendEvent({
    eventId: `evt-${n}-${Math.random().toString(36).slice(2)}`,
    accountId,
    conversationId,
    eventType: 'message.created',
    payload,
  });
}

const pendingReads = new WeakMap<object, Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>>>();

/**
 * Reads a streaming response until `done(text)` is true, the stream ends, or the timeout elapses.
 * A read that outlives a timeout is kept per reader, so no chunk is ever swallowed between calls.
 */
export async function readStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  done: (text: string) => boolean,
  timeoutMs = 1500,
): Promise<{ text: string; ended: boolean }> {
  const dec = new TextDecoder();
  let text = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (done(text)) return { text, ended: false };
    const pending = pendingReads.get(reader) ?? reader.read();
    pendingReads.set(reader, pending);
    const r = await Promise.race([
      pending,
      new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), Math.max(deadline - Date.now(), 1))),
    ]);
    if (r === 'timeout') break;
    pendingReads.delete(reader);
    if (r.done) return { text, ended: true };
    text += dec.decode(r.value, { stream: true });
  }
  return { text, ended: false };
}

export function sseEvents(text: string): Array<{ id: string | null; event: string; data: any }> {
  return text
    .split('\n\n')
    .map((b) => b.trim())
    .filter((b) => b.includes('event:'))
    .map((b) => {
      const id = /^id: (.*)$/m.exec(b)?.[1] ?? null;
      const event = /^event: (.*)$/m.exec(b)![1];
      const data = JSON.parse(/^data: (.*)$/m.exec(b)![1]);
      return { id, event, data };
    });
}

/** Temp-file database (two WAL handles, like main + daemon) behind the API, with an ingest pipeline on handle A. */
export function makeFileApi(
  deps: Partial<CareApiDeps> | ((fx: ReturnType<typeof twoHandleFixture>) => Partial<CareApiDeps>) = {},
  opts: { moduleOn?: boolean } = {},
) {
  const fx = twoHandleFixture();
  const api = wrapApi(fx.storesA, fx.a, typeof deps === 'function' ? deps(fx) : deps, () => fx.close(), opts);
  const put = (m: NormalizedMessage) => fx.ingestA.ingestNormalizedMessage(m, undefined, 1);
  return { ...api, fx, put };
}
