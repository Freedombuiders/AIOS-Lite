/**
 * Test kit for the CC-11 outbox/dispatcher tests. Synthetic fixtures only: a temp-file SQLite database
 * with two independent handles (two "workers"), the fake Care connector, no network, nothing is sent.
 * Not imported by production code.
 */

import type Database from 'better-sqlite3';
import { FakeCareConnector } from '../connectors/fake-connector.js';
import type { ConnectorCapabilities, DeliveryCommand, DeliveryResult } from '../../../_lib/care-kit/contract.js';
import { CareError } from '../../../_lib/care-kit/errors.js';
import type { CareAccountRecord, CareChannel, CareConversationRecord } from '../../../_lib/care-kit/types.js';
import type { CareStores } from '../persistence/index.js';
import { createEligibleAccount, TEST_KEY, twoHandleFixture, type TwoHandleFixture } from '../test-fixtures.js';
import { CareOutboxDispatcher, type DispatchGuard, type DispatcherOptions } from './dispatch.js';
import { CareOutboxService, type OutboxContent } from './outbox-service.js';

export { TEST_KEY };

export const allowAll: DispatchGuard = { evaluate: () => ({ allow: true }) };

export const chat = (text = 'hello customer'): OutboxContent => ({ kind: 'chat', text });
export const mail = (text = 'hello by mail', to = ['buyer@example.com'], extra: Partial<Extract<OutboxContent, { kind: 'email' }>> = {}): OutboxContent => ({
  kind: 'email',
  text,
  to,
  subject: 'Re: Hello',
  ...extra,
});

/** Fake connector whose dispatch can be scripted to fail BEFORE the provider is contacted. */
export class ScriptedConnector extends FakeCareConnector {
  public failures: CareError[] = [];
  public reconcileEvidence = true;
  /** When set, dispatch() reaches the provider and then never answers (a worker that dies mid-RPC). */
  public hangAfterAccept = false;
  /** Every dispatch() call the dispatcher made (reached the connector), whether or not the provider sent. */
  public readonly dispatchCalls: DeliveryCommand[] = [];

  async dispatch(command: DeliveryCommand): Promise<DeliveryResult> {
    this.dispatchCalls.push(command);
    const failure = this.failures.shift();
    if (failure) throw failure;
    const result = await super.dispatch(command);
    if (this.hangAfterAccept) return new Promise<DeliveryResult>(() => undefined);
    return result;
  }

  async reconcile(command: Parameters<FakeCareConnector['reconcile']>[0]): Promise<DeliveryResult> {
    if (!this.reconcileEvidence) {
      return { outcome: 'uncertain', error: 'No evidence available (scripted)' };
    }
    return super.reconcile(command);
  }
}

export interface Rig {
  fx: TwoHandleFixture;
  clock: { t: number };
  account: CareAccountRecord;
  conversation: CareConversationRecord;
  connector: ScriptedConnector;
  serviceA: CareOutboxService;
  serviceB: CareOutboxService;
  storesA: CareStores;
  storesB: CareStores;
  dispatcher: (worker: 'A' | 'B', over?: Partial<DispatcherOptions>) => CareOutboxDispatcher;
  addAccount: (channel?: CareChannel) => { account: CareAccountRecord; conversation: CareConversationRecord };
  close: () => void;
}

export function makeRig(opts: { channel?: CareChannel; capabilities?: Partial<ConnectorCapabilities> } = {}): Rig {
  const channel = opts.channel ?? 'zalo';
  const fx = twoHandleFixture();
  const clock = { t: Date.now() };
  const connector = new ScriptedConnector('fake', channel, opts.capabilities);
  const now = () => clock.t;

  const addAccount = (ch: CareChannel = channel) => {
    const account = createEligibleAccount(fx.storesA, { channel: ch });
    const conversation = fx.storesA.conversations.upsertConversation({
      accountId: account.id,
      externalKey: ch === 'email' ? 'thread:1' : 'peer:1',
      kind: ch === 'email' ? 'email_thread' : 'direct',
      title: 'Customer',
    });
    return { account, conversation };
  };
  const { account, conversation } = addAccount(channel);

  const serviceA = new CareOutboxService(fx.a, fx.storesA, { now });
  const serviceB = new CareOutboxService(fx.b, fx.storesB, { now });

  return {
    fx,
    clock,
    account,
    conversation,
    connector,
    serviceA,
    serviceB,
    storesA: fx.storesA,
    storesB: fx.storesB,
    dispatcher: (worker, over = {}) =>
      new CareOutboxDispatcher({
        stores: worker === 'A' ? fx.storesA : fx.storesB,
        guard: allowAll,
        resolveConnector: () => connector,
        workerId: `worker-${worker}`,
        leaseMs: 30_000,
        rpcTimeoutMs: 5_000,
        now,
        ...over,
      }),
    addAccount,
    close: () => fx.close(),
  };
}

export function count(db: Database.Database, table: string, where = '1=1', ...params: unknown[]): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`).get(...params) as { c: number }).c;
}

export async function expectCareError(fn: () => unknown, code: string, status?: number): Promise<CareError> {
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof CareError)) throw e;
    if (e.code !== code) throw new Error(`expected ${code}, got ${e.code}: ${e.message}`);
    if (status !== undefined && e.status !== status) throw new Error(`expected status ${status}, got ${e.status}`);
    return e;
  }
  throw new Error(`expected CareError ${code}, nothing thrown`);
}
