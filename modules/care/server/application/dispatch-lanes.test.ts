import { afterEach, describe, expect, it } from 'vitest';
import { createCareSchema } from '../persistence/schema.js';
import type { DispatchGuard } from './dispatch.js';
import { chat, count, expectCareError, makeRig, type Rig } from './dispatch-test-kit.js';

let rig: Rig;
afterEach(() => rig?.close());

const enqueue = (r: Rig, key: string, conversationId = r.conversation.id, text = `text ${key}`) =>
  r.serviceA.enqueue({ conversationId, clientRequestId: key, actor: 'manual', content: chat(text) }).intent;
const tick = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

describe('claiming (two workers, one lane per account)', () => {
  it('two workers racing for the same intent produce exactly one RPC', async () => {
    rig = makeRig();
    const intent = enqueue(rig, 'l-race-0000001');
    const reports = (await Promise.all([rig.dispatcher('A').dispatchDue(), rig.dispatcher('B').dispatchDue()])).flat();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ intentId: intent.id, result: 'sent' });
    expect(rig.connector.providerSendCount).toBe(1);
    expect(rig.connector.dispatchCalls).toHaveLength(1);
    expect(rig.storesA.outbox.listAttempts(intent.id)).toHaveLength(1);
  });

  it('the claim of one handle excludes every other handle, also for other conversations of the account', () => {
    rig = makeRig();
    const second = rig.storesA.conversations.upsertConversation({ accountId: rig.account.id, externalKey: 'peer:2', kind: 'direct', title: 'B' });
    enqueue(rig, 'l-lane-0000001');
    enqueue(rig, 'l-lane-0000002', second.id);

    const a = rig.storesA.outbox.claimDue({ workerId: 'wa', leaseDurationMs: 30_000, limit: 10, nowMs: rig.clock.t });
    const b = rig.storesB.outbox.claimDue({ workerId: 'wb', leaseDurationMs: 30_000, limit: 10, nowMs: rig.clock.t });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
    // the database itself refuses a second 'sending' row for an account
    expect(() => rig.fx.b.prepare(`UPDATE care_delivery_intents SET status = 'sending' WHERE client_request_id = ?`).run('l-lane-0000002')).toThrow(/UNIQUE/);
  });

  it('while one request is awaiting its ack the account is busy, other accounts keep moving', async () => {
    rig = makeRig();
    const other = rig.addAccount();
    const second = rig.storesA.conversations.upsertConversation({ accountId: rig.account.id, externalKey: 'peer:2', kind: 'direct', title: 'B' });
    enqueue(rig, 'l-busy-0000001');
    enqueue(rig, 'l-busy-0000002', second.id);
    rig.serviceA.enqueue({ conversationId: other.conversation.id, clientRequestId: 'l-busy-other-01', actor: 'manual', content: chat('other account') });

    rig.connector.setBehavior('delayed-ack');
    const running = rig.dispatcher('A', { rpcTimeoutMs: 600_000 }).dispatchDue({ accountIds: [rig.account.id] });
    await tick();

    // account 1 is occupied; B cannot start its second request, but account 2 is free
    expect(await rig.dispatcher('B').dispatchDue({ accountIds: [rig.account.id] })).toEqual([]);
    rig.connector.setBehavior('normal');
    const otherReports = await rig.dispatcher('B').dispatchDue({ accountIds: [other.account.id] });
    expect(otherReports.map((r) => r.result)).toEqual(['sent']);

    rig.connector.setBehavior('delayed-ack');
    rig.connector.releaseDelayedAck('l-busy-0000001', rig.account.id);
    await running;
    expect(rig.connector.providerSendCount).toBe(2);
  });
});

describe('ordering and fairness', () => {
  it('requests of one conversation go out in order, one per tick', async () => {
    rig = makeRig();
    enqueue(rig, 'o-order-000001', rig.conversation.id, 'first');
    enqueue(rig, 'o-order-000002', rig.conversation.id, 'second');
    enqueue(rig, 'o-order-000003', rig.conversation.id, 'third');
    const d = rig.dispatcher('A');
    for (let i = 0; i < 4; i += 1) await d.dispatchDue();
    expect(rig.connector.dispatchedCommands.map((c) => c.text)).toEqual(['first', 'second', 'third']);
    expect(rig.connector.providerSendCount).toBe(3);
  });

  it('an unresolved earlier request blocks later ones of the SAME conversation (no reordering), not other conversations', async () => {
    rig = makeRig();
    const other = rig.storesA.conversations.upsertConversation({ accountId: rig.account.id, externalKey: 'peer:2', kind: 'direct', title: 'B' });
    enqueue(rig, 'o-block-000001', rig.conversation.id, 'first');
    enqueue(rig, 'o-block-000002', rig.conversation.id, 'second');
    enqueue(rig, 'o-block-000003', other.id, 'other chat');

    rig.connector.setBehavior('accepted-lost-ack');
    await rig.dispatcher('A').dispatchDue(); // first -> uncertain
    rig.connector.setBehavior('normal');
    const d = rig.dispatcher('A');
    await d.dispatchDue();
    await d.dispatchDue();
    expect(rig.connector.dispatchCalls.map((c) => c.text)).toEqual(['first', 'other chat']);
    expect(rig.serviceA.getByRequest(rig.account.id, 'o-block-000002')!.status).toBe('pending');

    // once the first one is reconciled the second follows
    await d.reconcile(rig.serviceA.getByRequest(rig.account.id, 'o-block-000001')!.id);
    await d.dispatchDue();
    expect(rig.connector.dispatchCalls.map((c) => c.text)).toEqual(['first', 'other chat', 'second']);
  });

  it('a busy account cannot starve the others (round robin over accounts)', async () => {
    rig = makeRig();
    const y = rig.addAccount();
    const z = rig.addAccount();
    const names = new Map<string, string>([
      [rig.account.id, 'X'],
      [y.account.id, 'Y'],
      [z.account.id, 'Z'],
    ]);
    const conversations = new Map([
      ['X', rig.conversation.id],
      ['Y', y.conversation.id],
      ['Z', z.conversation.id],
    ]);
    // X floods first, then Y and Z each ask once
    for (let i = 1; i <= 3; i += 1) enqueue(rig, `fair-x-${i}`.padEnd(12, '0'), conversations.get('X'));
    enqueue(rig, 'fair-y-1'.padEnd(12, '0'), conversations.get('Y'));
    enqueue(rig, 'fair-z-1'.padEnd(12, '0'), conversations.get('Z'));

    const served: string[] = [];
    const d = rig.dispatcher('A');
    for (let i = 0; i < 5; i += 1) {
      const [report] = await d.dispatchDue({ limit: 1 });
      served.push(names.get(report.accountId)!);
    }
    expect(served).toEqual(['X', 'Y', 'Z', 'X', 'X']);
    expect(rig.connector.providerSendCount).toBe(5);
  });
});

describe('cancel races (AC-019)', () => {
  it('cancel before the claim: never claimed, never sent', async () => {
    rig = makeRig();
    const intent = enqueue(rig, 'c-before-00001');
    expect(rig.serviceB.cancel(intent.id).cancelled).toBe(true);
    expect(await rig.dispatcher('A').dispatchDue()).toEqual([]);
    expect(rig.connector.dispatchCalls).toHaveLength(0);
  });

  it('cancel while the claim is still in the guard (no attempt yet) wins: no RPC', async () => {
    rig = makeRig();
    const intent = enqueue(rig, 'c-guard-000001');
    const guard: DispatchGuard = {
      evaluate: async () => {
        const result = rig.serviceB.cancel(intent.id);
        expect(result.cancelled).toBe(true);
        return { allow: true };
      },
    };
    const [report] = await rig.dispatcher('A', { guard }).dispatchDue();
    expect(report).toMatchObject({ result: 'lost_claim', rpc: false });
    expect(rig.connector.dispatchCalls).toHaveLength(0);
    expect(rig.serviceA.get(intent.id)!.status).toBe('cancelled');
    expect(rig.storesA.outbox.listAttempts(intent.id)).toHaveLength(0);
  });

  it('cancel after the attempt exists loses: the request is underway and still completes', async () => {
    rig = makeRig();
    const intent = enqueue(rig, 'c-after-000001');
    const attemptedThenCancel = rig.connector.dispatch.bind(rig.connector);
    let cancelResult: ReturnType<typeof rig.serviceB.cancel> | undefined;
    rig.connector.dispatch = async (command) => {
      cancelResult = rig.serviceB.cancel(intent.id); // arrives while the RPC is in flight
      return attemptedThenCancel(command);
    };
    const [report] = await rig.dispatcher('A').dispatchDue();
    expect(cancelResult).toMatchObject({ cancelled: false, hint: 'request_underway' });
    expect(report.result).toBe('sent');
    expect(rig.connector.providerSendCount).toBe(1);
  });

  it('a retry_wait request can still be cancelled before it goes out again', async () => {
    rig = makeRig();
    const intent = enqueue(rig, 'c-retrywait-01');
    const { CareError } = await import('../../../_lib/care-kit/errors.js');
    rig.connector.failures.push(new CareError('RATE_LIMITED', 'slow', 429));
    await rig.dispatcher('A').dispatchDue();
    expect(rig.serviceA.get(intent.id)!.status).toBe('retry_wait');
    expect(rig.serviceA.cancel(intent.id).cancelled).toBe(true);
    rig.clock.t += 3_600_000;
    expect(await rig.dispatcher('A').dispatchDue()).toEqual([]);
    expect(rig.connector.providerSendCount).toBe(0);
  });
});

describe('immutability and schema', () => {
  it('a request that was attempted keeps its payload and token; a sent one cannot be edited or approved again', async () => {
    rig = makeRig();
    const intent = enqueue(rig, 'i-immutable-01');
    await rig.dispatcher('A').dispatchDue();
    await expectCareError(() => rig.serviceA.editDraft(intent.id, { expectedRevision: 1, content: chat('changed') }), 'CONFIGURATION_CONFLICT', 409);
    const after = rig.serviceA.get(intent.id)!;
    expect(after.payload.text).toBe(`text i-immutable-01`);
    expect(after.adapterRetryToken).toBe(intent.adapterRetryToken);
    expect(after.payloadHash).toBe(intent.payloadHash);
  });

  it('an unattempted pending request can be pulled back for edit; one with a failed attempt cannot', async () => {
    rig = makeRig();
    const pending = enqueue(rig, 'i-edit-pending1');
    const edited = rig.serviceA.editDraft(pending.id, { expectedRevision: 1, content: chat('new text') });
    expect(edited).toMatchObject({ status: 'draft', payloadRevision: 2 });
    expect(await rig.dispatcher('A').dispatchDue()).toEqual([]); // a draft is never dispatched

    const { CareError } = await import('../../../_lib/care-kit/errors.js');
    const retrying = enqueue(rig, 'i-edit-retrying', rig.storesA.conversations.upsertConversation({ accountId: rig.account.id, externalKey: 'peer:3', kind: 'direct', title: 'C' }).id);
    rig.connector.failures.push(new CareError('RATE_LIMITED', 'slow', 429));
    await rig.dispatcher('A').dispatchDue();
    await expectCareError(() => rig.serviceA.editDraft(retrying.id, { expectedRevision: 1, content: chat('x') }), 'CONFIGURATION_CONFLICT', 409);
  });

  it('the additive schema can be applied again and again', () => {
    rig = makeRig();
    enqueue(rig, 'i-schema-000001');
    createCareSchema(rig.fx.a);
    createCareSchema(rig.fx.b);
    expect(count(rig.fx.a, 'care_delivery_intents')).toBe(1);
    const indexes = (rig.fx.a.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_care_delivery%'`).all() as Array<{ name: string }>).map((i) => i.name);
    expect(indexes).toEqual(expect.arrayContaining(['idx_care_delivery_one_sending', 'idx_care_delivery_token', 'idx_care_delivery_due']));
  });
});
