import { describe, expect, it } from 'vitest';
import { CareError } from '../../../_lib/care-kit/errors.js';
import { chatMessage, createEligibleAccount, memoryFixture, TEST_KEY } from '../test-fixtures.js';
import { createCareStores, createTestCareDatabase } from './index.js';

function seed() {
  const fx = memoryFixture();
  const res = fx.ingest.ingestNormalizedMessage(chatMessage(fx.account, { text: 'xin chào, giá bao nhiêu?' }));
  const conv = fx.stores.conversations.getConversationByExternalKey(fx.account.id, 'peer:1')!;
  const msgId = res.messageId!;
  return { ...fx, conv, msgId };
}

const key = (s: ReturnType<typeof seed>, over: Record<string, unknown> = {}) => ({
  accountId: s.account.id,
  conversationId: s.conv.id,
  triggerMessageId: s.msgId,
  contextRevision: s.conv.revision,
  policyRevision: 'asg@1',
  agentId: 'cskh',
  mode: 'draft' as const,
  ...over,
});

describe('CareAgentRunStore', () => {
  it('creates the table additively and idempotently on every boot', () => {
    const { rawDbForTestIsolationOnly: db, close } = createTestCareDatabase(':memory:', TEST_KEY);
    const before = db.prepare(`SELECT sql FROM sqlite_master WHERE name LIKE '%agent_runs%' ORDER BY name`).all();
    expect(before.length).toBeGreaterThan(1);
    // A second schema pass is a no-op.
    createCareStores(db, TEST_KEY);
    close();
  });

  it('beginRun is idempotent per (conversation, trigger, context revision, kind)', () => {
    const s = seed();
    const a = s.stores.agentRuns.beginRun(key(s));
    expect(a.outcome).toBe('created');
    expect(a.run.status).toBe('running');
    const b = s.stores.agentRuns.beginRun(key(s));
    expect(b.outcome).toBe('in_progress');
    expect(b.run.id).toBe(a.run.id);
    s.stores.agentRuns.completeRun(a.run.id, { status: 'skipped', skipReason: 'observe_only' });
    const c = s.stores.agentRuns.beginRun(key(s));
    expect(c.outcome).toBe('terminal');
    expect(c.run.id).toBe(a.run.id);
    expect(s.raw.prepare('SELECT COUNT(*) AS n FROM care_agent_runs').get()).toEqual({ n: 1 });
    // A new context revision, or an explicit manual request, is a different run.
    expect(s.stores.agentRuns.beginRun(key(s, { contextRevision: s.conv.revision + 1 })).outcome).toBe('created');
    expect(s.stores.agentRuns.beginRun(key(s, { triggerKind: 'manual' })).outcome).toBe('created');
    expect(s.raw.prepare('SELECT COUNT(*) AS n FROM care_agent_runs').get()).toEqual({ n: 3 });
    s.close();
  });

  it('takes over a running row only after the lease went stale, and only one taker wins', () => {
    const s = seed();
    const first = s.stores.agentRuns.beginRun(key(s), { nowMs: 1_000, leaseMs: 5_000 });
    expect(s.stores.agentRuns.beginRun(key(s), { nowMs: 5_999, leaseMs: 5_000 }).outcome).toBe('in_progress');
    const take = s.stores.agentRuns.beginRun(key(s), { nowMs: 6_001, leaseMs: 5_000 });
    expect(take.outcome).toBe('taken_over');
    expect(take.run.id).toBe(first.run.id);
    expect(take.run.attempts).toBe(2);
    // The lease was renewed by the takeover.
    expect(s.stores.agentRuns.beginRun(key(s), { nowMs: 6_100, leaseMs: 5_000 }).outcome).toBe('in_progress');
    s.close();
  });

  it('completeRun is compare-and-set and never overwrites a finished run', () => {
    const s = seed();
    const { run } = s.stores.agentRuns.beginRun(key(s));
    const done = s.stores.agentRuns.completeRun(run.id, {
      status: 'drafted',
      draftRef: 'draft-1',
      decision: { reply: 'Dạ giá 100k ạ' },
      modelCalled: true,
      latencyMs: 12,
      costUsd: 0.002,
      costSource: 'provider',
    });
    expect(done).toMatchObject({ status: 'drafted', draftRef: 'draft-1', modelCalled: true, latencyMs: 12, costUsd: 0.002, costSource: 'provider' });
    expect(done?.decision).toEqual({ reply: 'Dạ giá 100k ạ' });
    expect(s.stores.agentRuns.completeRun(run.id, { status: 'failed', skipReason: 'late' })).toBeNull();
    expect(s.stores.agentRuns.getRun(run.id)?.status).toBe('drafted');
    s.close();
  });

  it('validates input: drafted needs a draftRef, trigger must belong to the conversation, cost must be sane', () => {
    const s = seed();
    const { run } = s.stores.agentRuns.beginRun(key(s));
    expect(() => s.stores.agentRuns.completeRun(run.id, { status: 'drafted' })).toThrow(CareError);
    expect(() => s.stores.agentRuns.completeRun(run.id, { status: 'skipped', costUsd: -1 })).toThrow(CareError);
    expect(() => s.stores.agentRuns.beginRun(key(s, { triggerMessageId: 'nope' }))).toThrow(/not found/);
    const other = createEligibleAccount(s.stores, { channel: 'zalo' });
    expect(() => s.stores.agentRuns.beginRun(key(s, { accountId: other.id }))).toThrow(/mismatch/);
    expect(() => s.stores.agentRuns.beginRun(key(s, { triggerKind: 'x' as never }))).toThrow(CareError);
    s.close();
  });

  it('encrypts the decision at rest and fails closed under a different key', () => {
    const s = seed();
    const { run } = s.stores.agentRuns.beginRun(key(s));
    s.stores.agentRuns.completeRun(run.id, { status: 'skipped', skipReason: 'agent_skip', decision: { reason: 'KHACH-SECRET-TEXT' } });
    const raw = s.raw.prepare('SELECT decision_enc, skip_reason FROM care_agent_runs WHERE id = ?').get(run.id) as { decision_enc: string; skip_reason: string };
    expect(raw.decision_enc).not.toContain('KHACH-SECRET-TEXT');
    expect(raw.decision_enc).toMatch(/^[0-9a-f]{24}:[0-9a-f]{32}:/);
    expect(raw.skip_reason).toBe('agent_skip');
    const wrong = createCareStores(s.raw, Buffer.alloc(32, 9));
    expect(() => wrong.agentRuns.getRun(run.id)).toThrow(/decryption failed|Strict/i);
    s.close();
  });

  it('lists newest first with filters and a keyset bound, and counts quotas', () => {
    const s = seed();
    const store = s.stores.agentRuns;
    const mk = (rev: number, now: number, patch: Parameters<typeof store.completeRun>[1]) => {
      const { run } = store.beginRun(key(s, { contextRevision: rev, agentId: 'cskh' }), { nowMs: now });
      store.completeRun(run.id, patch, now);
      return run.id;
    };
    mk(100, 1_000, { status: 'drafted', draftRef: 'd1', modelCalled: true });
    mk(101, 2_000, { status: 'skipped', skipReason: 'agent_skip', modelCalled: true });
    mk(102, 3_000, { status: 'skipped', skipReason: 'observe_only' });
    mk(103, 4_000, { status: 'failed', skipReason: 'timeout', modelCalled: true });
    expect(store.listRuns({ conversationId: s.conv.id }).map((r) => r.contextRevision)).toEqual([103, 102, 101, 100]);
    expect(store.listRuns({ status: 'skipped' })).toHaveLength(2);
    expect(store.listRuns({ beforeMs: 3_000 }).map((r) => r.contextRevision)).toEqual([101, 100]);
    expect(store.listRuns({ limit: 1 })).toHaveLength(1);
    expect(store.countDraftedSince(s.conv.id, 0)).toBe(1);
    expect(store.countDraftedSince(s.conv.id, 1_001)).toBe(0);
    expect(store.countModelRunsSince('cskh', 0)).toBe(3);
    expect(store.countModelRunsSince('cskh', 2_500)).toBe(1);
    expect(store.countModelRunsSince('someone-else', 0)).toBe(0);
    s.close();
  });

  it('runs disappear with their conversation (derived data follows deletion)', () => {
    const s = seed();
    s.stores.agentRuns.beginRun(key(s));
    s.raw.pragma('foreign_keys = ON');
    s.raw.prepare('DELETE FROM care_conversations WHERE id = ?').run(s.conv.id);
    expect(s.raw.prepare('SELECT COUNT(*) AS n FROM care_agent_runs').get()).toEqual({ n: 0 });
    s.close();
  });
});
