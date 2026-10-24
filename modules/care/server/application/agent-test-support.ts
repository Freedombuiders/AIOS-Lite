/**
 * Fakes and seeding helpers for the CC-10 agent tests. Synthetic data only: no model, no network,
 * no provider. Not imported by production code.
 */

import type { CareAccountRecord, CareChannel, NormalizedMessage } from '../../../_lib/care-kit/types.js';
import { chatMessage, emailMessage, memoryFixture, type MemoryFixture } from '../test-fixtures.js';
import {
  AgentRunnerError,
  type AgentRunner,
  type AgentRunOutput,
  type AgentRunRequest,
  type AgentToolBoundary,
  type BoundaryReport,
  type DraftProposal,
  type DraftSink,
} from './agent-ports.js';
import { CareAgentTurn, type AgentTurnDeps } from './agent-turn.js';
import { killSwitches } from '../policy/test-support.js';

export const T0 = Date.parse('2026-10-09T10:00:00Z');

export class FakeRunner implements AgentRunner {
  requests: AgentRunRequest[] = [];
  boundaryChecks = 0;
  report: BoundaryReport = { enforced: true };
  /** Called for each run; default answers with a plain reply. */
  respond: (req: AgentRunRequest) => AgentRunOutput | Promise<AgentRunOutput> = () => ({
    text: JSON.stringify({ action: 'reply', replies: [{ ref: 'm1', text: 'Dạ giá là 100k ạ' }] }),
  });

  verifyBoundary(_b: AgentToolBoundary): BoundaryReport {
    this.boundaryChecks += 1;
    return this.report;
  }

  async run(req: AgentRunRequest): Promise<AgentRunOutput> {
    this.requests.push(req);
    return this.respond(req);
  }

  replyWith(json: unknown): this {
    this.respond = () => ({ text: typeof json === 'string' ? json : JSON.stringify(json) });
    return this;
  }
}

export class FakeSink implements DraftSink {
  proposals: DraftProposal[] = [];
  private byKey = new Map<string, string>();
  failWith: Error | null = null;
  async propose(p: DraftProposal): Promise<{ draftRef: string }> {
    if (this.failWith) throw this.failWith;
    this.proposals.push(p);
    const existing = this.byKey.get(p.idempotencyKey);
    if (existing) return { draftRef: existing };
    const ref = `draft-${this.byKey.size + 1}`;
    this.byKey.set(p.idempotencyKey, ref);
    return { draftRef: ref };
  }
}

export interface Seeded extends MemoryFixture {
  runner: FakeRunner;
  sink: FakeSink;
  conversationId: string;
  /** Local ids of seeded messages, in insertion order. */
  messageIds: string[];
  triggerId: string;
  turn: (over?: Partial<AgentTurnDeps>) => CareAgentTurn;
  now: { value: number };
}

export interface SeedOptions {
  channel?: CareChannel;
  account?: Partial<Parameters<MemoryFixture['stores']['accounts']['createAccount']>[0]>;
  /** Assignment on the account; false = none. */
  assignment?: false | { mode?: 'observe' | 'draft' | 'auto'; policyExt?: Record<string, unknown>; enabled?: boolean };
  /** Messages oldest -> newest; the LAST one is the trigger. */
  messages?: Array<Partial<NormalizedMessage>>;
  conversationKey?: string;
  conversationKind?: 'direct' | 'group';
  nowMs?: number;
}

export function seed(opts: SeedOptions = {}): Seeded {
  const channel = opts.channel ?? 'zalo';
  const fx = memoryFixture({
    channel,
    nativeAccountId: channel === 'email' ? 'shop@gmail.com' : 'shop-uid',
    ...opts.account,
  });
  const key = opts.conversationKey ?? (channel === 'email' ? 'thread:1' : 'peer:1');
  const defaults: Array<Partial<NormalizedMessage>> = opts.messages ?? [{ text: 'Cho mình hỏi giá khoá học nhé' }];
  const ids: string[] = [];
  defaults.forEach((m, i) => {
    const build = channel === 'email' ? emailMessage : chatMessage;
    const base = build(fx.account, {
      externalConversationKey: key,
      sentAtMs: T0 - (defaults.length - i) * 60_000,
      ...(channel !== 'email' && opts.conversationKind === 'group'
        ? { metadata: { type: 'chat' as const, conversationKind: 'group' as const } }
        : {}),
      ...m,
    });
    const res = fx.ingest.ingestNormalizedMessage(base);
    ids.push(res.messageId!);
  });
  if (opts.assignment !== false) {
    const a = opts.assignment ?? {};
    fx.stores.assignments.upsertAssignment({
      scope: 'account',
      accountId: fx.account.id,
      mode: a.mode ?? 'auto',
      agentId: 'cskh',
      enabled: a.enabled ?? true,
      policyExt: a.policyExt ?? null,
    });
  }
  const conv = fx.stores.conversations.getConversationByExternalKey(fx.account.id, key);
  const runner = new FakeRunner();
  const sink = new FakeSink();
  const now = { value: opts.nowMs ?? T0 };
  const seeded: Seeded = {
    ...fx,
    runner,
    sink,
    conversationId: conv?.id ?? '',
    messageIds: ids,
    triggerId: ids[ids.length - 1] ?? '',
    now,
    turn: (over = {}) =>
      new CareAgentTurn({
        db: fx.raw,
        stores: fx.stores,
        runner,
        draftSink: sink,
        killSwitches: () => killSwitches(),
        now: () => now.value,
        ...over,
      }),
  };
  return seeded;
}

export function accountOf(s: Seeded): CareAccountRecord {
  return s.stores.accounts.getAccount(s.account.id)!;
}

export { AgentRunnerError };
