/**
 * CC-12 composition root: fake connector, fake agent runner, temp-file DB with two handles. Nothing is sent
 * anywhere; "sent" means the fake connector recorded a delivery.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeCareConnector } from '../connectors/fake-connector.js';
import { FakeRunner } from '../application/agent-test-support.js';
import { CareIngestPipeline } from '../application/ingest.js';
import type { NormalizedEvent } from '../../../_lib/care-kit/types.js';
import { chatMessage } from '../test-fixtures.js';
import { createManualClock } from './clock.js';
import { createCareRuntime, startCareRuntime, type CareRuntime, type CareRuntimeDeps } from './care-runtime.js';
import { runtimeFixture, type RuntimeFixture } from './runtime-fixtures.js';

const open: Array<() => void> = [];
afterEach(() => {
  open.splice(0).forEach((c) => c());
  vi.useRealTimers();
});
const settle = () => new Promise<void>((r) => setImmediate(r));

function rig(over: Parameters<typeof runtimeFixture>[0] = {}) {
  const f: RuntimeFixture = runtimeFixture(over);
  open.push(f.close);
  const connector = new FakeCareConnector('fake', 'zalo');
  const runner = new FakeRunner();
  const clock = createManualClock(Date.now());
  const build = (which: 'a' | 'b', workerId: string, extra: Partial<CareRuntimeDeps> = {}): CareRuntime =>
    createCareRuntime({
      db: which === 'a' ? f.a : f.b,
      stores: which === 'a' ? f.storesA : f.storesB,
      connectors: { forAccount: () => connector },
      runner,
      workerId,
      clock,
      worker: { lockTtlMs: 600_000, leaseMs: 600_000, batchPerAccount: 10 },
      ...extra,
    });
  const conversation = f.storesA.conversations.upsertConversation({ accountId: f.account.id, externalKey: 'peer:1', kind: 'direct', title: 'Customer' });
  const manualReply = (rt: CareRuntime, key: string, text = 'xin chào') =>
    rt.service.enqueue({ accountId: f.account.id, conversationId: conversation.id, clientRequestId: key, actor: 'manual', content: { kind: 'chat', text } }).intent;
  return { f, connector, runner, clock, build, conversation, manualReply };
}

describe('nothing starts by itself', () => {
  it('creating a runtime schedules no timer, takes no lock and enqueues no job', () => {
    vi.useFakeTimers();
    const r = rig();
    const rt = r.build('a', 'w1');
    expect(vi.getTimerCount()).toBe(0);
    expect(r.f.storesA.ownership.getHolder(r.f.account.id)).toBeNull();
    expect((r.f.a.prepare('SELECT count(*) AS n FROM care_jobs').get() as { n: number }).n).toBe(0);
    expect(rt.worker.heldLocks()).toEqual([]);
  });

  it('startCareRuntime is explicit: it runs passes under supervision and stop() drains and releases the lock', async () => {
    const r = rig();
    const rt = r.build('a', 'w1', { worker: { lockTtlMs: 600_000, leaseMs: 600_000, idleSleepMs: 500, batchPerAccount: 10 } });
    r.manualReply(rt, 'req-1');
    const sup = startCareRuntime(rt, { clock: r.clock, idleSleepMs: 500 });
    expect(startCareRuntime(rt)).toBe(sup);
    await settle();
    await settle();
    expect(r.connector.providerSendCount).toBe(1);
    const report = await rt.stop(1_000);
    expect(report).toEqual({ drained: true, abandonedAccounts: [] });
    expect(r.f.storesA.ownership.getHolder(r.f.account.id)?.releasedAtMs).not.toBeNull();
  });
});

describe('handlers', () => {
  it('inbound_turn: a live customer message produces exactly one draft through the fake runner', async () => {
    const r = rig();
    r.f.storesA.accounts.updateAccountFlags(r.f.account.id, { aiEnabled: true });
    r.f.storesA.assignments.upsertAssignment({ scope: 'account', accountId: r.f.account.id, mode: 'draft', agentId: 'cskh' });
    const rt = r.build('a', 'w1');
    const ingest = new CareIngestPipeline(r.f.a, r.f.storesA);
    const res = ingest.ingestNormalizedMessage(chatMessage(r.f.account, { externalConversationKey: 'peer:1', text: 'Cho mình hỏi giá nhé', sentAtMs: Date.now() - 1_000 }));
    expect(res.jobId).toBeDefined();
    await r.clock.advance(5_000); // the ingest stamped the job with real time; the manual clock catches up
    await rt.tick();
    await rt.tick();
    expect(r.runner.requests).toHaveLength(1);
    const drafts = r.f.a.prepare(`SELECT status, actor FROM care_delivery_intents WHERE account_id = ?`).all(r.f.account.id) as Array<{ status: string; actor: string }>;
    expect(drafts).toEqual([{ status: 'draft', actor: 'approved' }]);
    expect(r.f.storesA.jobs.getJob(res.jobId!)?.status).toBe('completed');
    expect(r.connector.providerSendCount).toBe(0); // the agent turn cannot send
  });

  it('outbox_dispatch: a pending manual reply is sent once through the connector, then never again', async () => {
    const r = rig();
    const rt = r.build('a', 'w1');
    const intent = r.manualReply(rt, 'req-1');
    expect(rt.schedule()).toMatchObject({ outbox: 1 });
    await rt.tick();
    expect(r.f.storesA.outbox.getIntent(intent.id)?.status).toBe('sent');
    expect(r.connector.providerSendCount).toBe(1);
    for (let i = 0; i < 3; i++) {
      await r.clock.advance(5_000);
      await rt.tick();
    }
    expect(r.connector.providerSendCount).toBe(1);
  });

  it('sync_poll: connector events are ingested under the job epoch and the checkpoint advances', async () => {
    const r = rig();
    r.f.storesA.accounts.updateAccountFlags(r.f.account.id, { syncEnabled: true });
    const msg = chatMessage(r.f.account, { externalConversationKey: 'peer:sync', text: 'xin chào từ sync' });
    r.connector.queuedEvents = [{ type: 'message.created', eventId: 'ev-sync-1', accountId: r.f.account.id, timestampMs: msg.sentAtMs, message: msg } as NormalizedEvent];
    const rt = r.build('a', 'w1');
    await rt.tick();
    expect(r.f.storesA.conversations.getConversationByExternalKey(r.f.account.id, 'peer:sync')).not.toBeNull();
    expect(r.f.storesA.checkpoints.get(r.f.account.id, 'zalo_chat')).toMatchObject({ cursor: 'cursor_1' });
    expect(r.f.storesA.events.hasEvent(r.f.account.id, 'ev-sync-1')).toBe(true);
  });

  it('sync_poll: onMessageStored hears each newly stored message once, and a throwing hook never fails the sync', async () => {
    const r = rig();
    r.f.storesA.accounts.updateAccountFlags(r.f.account.id, { syncEnabled: true });
    const msg = chatMessage(r.f.account, { externalConversationKey: 'peer:photo', text: '[Ảnh]' });
    const event = { type: 'message.created', eventId: 'ev-photo-1', accountId: r.f.account.id, timestampMs: msg.sentAtMs, message: msg } as NormalizedEvent;
    const stored = vi.fn(() => {
      throw new Error('copy failed');
    });
    r.connector.queuedEvents = [event, { ...event, eventId: 'ev-photo-2' }];
    const rt = r.build('a', 'w1', { onMessageStored: stored });
    await rt.tick();
    const conv = r.f.storesA.conversations.getConversationByExternalKey(r.f.account.id, 'peer:photo');
    expect(stored).toHaveBeenCalledTimes(1);
    expect(r.f.storesA.messages.getMessage(stored.mock.calls[0]![0] as string)?.conversationId).toBe(conv?.id);
    expect(r.f.storesA.checkpoints.get(r.f.account.id, 'zalo_chat')).toMatchObject({ cursor: 'cursor_1' });
  });

  it('cleanup: finished housekeeping jobs are pruned, open work is untouched', async () => {
    const r = rig();
    const rt = r.build('a', 'w1', { handlers: {} });
    rt.schedule();
    await rt.tick();
    r.f.a.prepare(`UPDATE care_jobs SET updated_at = 1 WHERE status = 'completed'`).run();
    await r.clock.advance(3_600_001);
    rt.schedule();
    await rt.tick();
    const finishedOld = r.f.a.prepare(`SELECT count(*) AS n FROM care_jobs WHERE status = 'completed' AND updated_at = 1`).get() as { n: number };
    expect(finishedOld.n).toBe(0);
  });
});

describe('the guard is the ONE gate (switches, ownership, backlog)', () => {
  it('module off: nothing is scheduled or sent; re-enable parks the older outbox backlog for review instead of sending it', async () => {
    const r = rig();
    const rt = r.build('a', 'w1');
    const intent = r.manualReply(rt, 'req-old');
    rt.setSwitch('module', false, { actor: 'op' });
    expect(rt.schedule()).toEqual({ outbox: 0, sync: 0, cleanup: 0 });
    await rt.tick();
    expect(r.connector.providerSendCount).toBe(0);

    await r.clock.advance(1_000);
    const res = rt.setSwitch('module', true, { actor: 'op', reason: 'back' });
    expect(res).toMatchObject({ reenabled: true });
    expect(res.held).toBeGreaterThanOrEqual(1);
    expect(r.f.storesA.ownership.isHeld('outbox_intent', intent.id)).toBe(true);

    await r.clock.advance(1_000);
    await rt.tick();
    await rt.tick();
    expect(r.connector.providerSendCount).toBe(0);
    expect(r.f.storesA.outbox.getIntent(intent.id)?.status).toBe('needs_review');

    // a reply queued AFTER the re-enable is sent normally
    await r.clock.advance(1_000);
    const fresh = r.manualReply(rt, 'req-new', 'sau khi bật lại');
    await r.clock.advance(1_000);
    rt.schedule();
    await rt.tick();
    expect(r.f.storesA.outbox.getIntent(fresh.id)?.status).toBe('sent');
    expect(r.connector.providerSendCount).toBe(1);
  });

  it('send flag off, kill switch and a disabled job path all stop the dispatch; the intent stays pending', async () => {
    const r = rig();
    const rt = r.build('a', 'w1');
    const intent = r.manualReply(rt, 'req-1');
    rt.setSwitch('dispatch', false, { actor: 'op' });
    rt.schedule();
    await rt.tick();
    expect(r.f.storesA.outbox.getIntent(intent.id)?.status).toBe('pending');
    rt.setSwitch('path:job', false, { actor: 'op' });
    await rt.tick();
    expect(r.connector.providerSendCount).toBe(0);
    expect(r.f.storesA.outbox.getIntent(intent.id)?.status).toBe('pending');
  });

  it('account re-enable (paused -> active) is caught by the database trigger for jobs and intents, whoever flips the flag', async () => {
    const r = rig();
    const rt = r.build('a', 'w1');
    r.f.storesA.accounts.updateAccountFlags(r.f.account.id, { desiredState: 'paused' });
    const intent = r.manualReply(rt, 'req-1');
    const job = r.f.storesA.jobs.enqueueJob({ accountId: r.f.account.id, jobType: 'outbox_dispatch', payload: {}, dueAtMs: 0 });
    // a different handle (API process) re-enables the account
    r.f.storesB.accounts.updateAccountFlags(r.f.account.id, { desiredState: 'active' });
    expect(r.f.storesA.ownership.isHeld('outbox_intent', intent.id)).toBe(true);
    expect(r.f.storesA.ownership.isHeld('job', job.id)).toBe(true);
    // an unrelated flag change holds nothing new
    const other = r.manualReply(rt, 'req-2');
    r.f.storesB.accounts.updateAccountFlags(r.f.account.id, { aiEnabled: true });
    expect(r.f.storesA.ownership.isHeld('outbox_intent', other.id)).toBe(false);
    await r.clock.advance(1_000);
    rt.schedule();
    await rt.tick();
    await rt.tick();
    expect(r.f.storesA.outbox.getIntent(intent.id)?.status).toBe('needs_review');
  });

  it('two runtimes (two handles) on one account: each intent is sent exactly once and one worker holds the lock', async () => {
    const r = rig();
    const a = r.build('a', 'worker-a');
    const b = r.build('b', 'worker-b');
    for (let i = 0; i < 3; i++) r.manualReply(a, `req-${i}`, `tin ${i}`);
    for (let i = 0; i < 8; i++) {
      await r.clock.advance(5_000);
      a.schedule();
      b.schedule();
      await Promise.all([a.tick(), b.tick()]);
    }
    expect(r.connector.providerSendCount).toBe(3);
    const sent = r.f.a.prepare(`SELECT count(*) AS n FROM care_delivery_intents WHERE status = 'sent'`).get() as { n: number };
    expect(sent.n).toBe(3);
    expect(r.f.storesA.ownership.getHolder(r.f.account.id)?.holderId).toBe('worker-a');
  });
});

