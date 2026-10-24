import { describe, expect, it } from 'vitest';
import { CareError } from '../../../_lib/care-kit/errors.js';
import { previewEffectiveRule, resolveEffectiveRule, type RuleResolveContext } from './assignment-resolver.js';
import { CHANNEL_POLICY_DEFAULTS, resolvePolicy } from './policy-ext.js';
import { assignment } from './test-support.js';

const zaloCtx = (over: Partial<RuleResolveContext> = {}): RuleResolveContext => ({
  accountId: 'acc',
  channel: 'zalo',
  conversationKey: 'g1',
  conversationKind: 'group',
  customerId: 'cust-1',
  identityKey: 'uid-1',
  ...over,
});
const emailCtx = (over: Partial<RuleResolveContext> = {}): RuleResolveContext => ({
  accountId: 'acc',
  channel: 'email',
  conversationKey: 'thread-1',
  conversationKind: 'email_thread',
  emailSender: 'Khach@Example.com',
  ...over,
});

function winnerId(assignments: ReturnType<typeof assignment>[], ctx: RuleResolveContext): string | null {
  const r = resolveEffectiveRule(assignments, ctx);
  return r.status === 'none' ? null : r.rule.assignmentId;
}

describe('assignment precedence', () => {
  it('walks conversation -> customer -> identity -> account -> channel -> global as rules are removed', () => {
    const conversation = assignment({ id: 'conv', scope: 'conversation', scopeTarget: 'g1' });
    const customer = assignment({ id: 'cust', scope: 'customer', accountId: null, customerId: 'cust-1' });
    const identity = assignment({ id: 'ident', scope: 'identity', scopeTarget: 'uid-1' });
    const account = assignment({ id: 'acct', scope: 'account' });
    const channel = assignment({ id: 'chan', scope: 'channel', accountId: null, channel: 'zalo' });
    const global = assignment({ id: 'glob', scope: 'global', accountId: null });
    const all = [global, channel, account, identity, customer, conversation];
    const order = ['conv', 'cust', 'ident', 'acct', 'chan', 'glob'];
    for (let i = 0; i < order.length; i++) {
      expect(winnerId(all.filter((a) => !order.slice(0, i).includes(a.id)), zaloCtx())).toBe(order[i]);
    }
    expect(winnerId([], zaloCtx())).toBeNull();
  });

  it('ignores rules of other accounts, other channels and other targets', () => {
    const rules = [
      assignment({ id: 'other-acc', scope: 'account', accountId: 'other' }),
      assignment({ id: 'other-chan', scope: 'channel', accountId: null, channel: 'email' }),
      assignment({ id: 'other-conv', scope: 'conversation', scopeTarget: 'g2' }),
      assignment({ id: 'other-cust', scope: 'customer', accountId: null, customerId: 'cust-2' }),
    ];
    expect(winnerId(rules, zaloCtx())).toBeNull();
  });

  it('uses explicit priority within a tier', () => {
    const lo = assignment({ id: 'lo', scope: 'account', priority: 10 });
    const hi = assignment({ id: 'hi', scope: 'account', priority: 200 });
    expect(winnerId([lo, hi], zaloCtx())).toBe('hi');
  });

  it('treats an equal-priority tie as a typed configuration error naming both rules', () => {
    const a = assignment({ id: 'a', scope: 'account', priority: 50 });
    const b = assignment({ id: 'b', scope: 'account', priority: 50 });
    const lower = assignment({ id: 'c', scope: 'account', priority: 1 });
    let caught: unknown;
    try {
      resolveEffectiveRule([a, lower, b], zaloCtx());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CareError);
    expect((caught as CareError).code).toBe('CONFIGURATION_CONFLICT');
    expect((caught as CareError).details).toMatchObject({ tier: 'account', priority: 50, assignmentIds: ['a', 'b'] });
  });

  it('a tie in a lower-priority position is not a conflict; a tie between enabled and disabled is', () => {
    const win = assignment({ id: 'win', scope: 'account', priority: 90 });
    const t1 = assignment({ id: 't1', scope: 'account', priority: 5 });
    const t2 = assignment({ id: 't2', scope: 'account', priority: 5 });
    expect(winnerId([t1, win, t2], zaloCtx())).toBe('win');
    const on = assignment({ id: 'on', scope: 'account', priority: 7 });
    const off = assignment({ id: 'off', scope: 'account', priority: 7, enabled: false });
    expect(() => resolveEffectiveRule([on, off], zaloCtx())).toThrow(/equal priority/);
  });

  it('does not let a conflict in a broader tier matter when a narrower tier decides', () => {
    const conv = assignment({ id: 'conv', scope: 'conversation', scopeTarget: 'g1' });
    const a = assignment({ id: 'a', scope: 'account', priority: 1 });
    const b = assignment({ id: 'b', scope: 'account', priority: 1 });
    expect(winnerId([a, b, conv], zaloCtx())).toBe('conv');
  });
});

describe('explicit disabled rule is a deny override', () => {
  it('does not fall through to a broader enabled rule', () => {
    const off = assignment({ id: 'off', scope: 'conversation', scopeTarget: 'g1', enabled: false });
    const account = assignment({ id: 'acct', scope: 'account' });
    const r = resolveEffectiveRule([account, off], zaloCtx());
    expect(r.status).toBe('denied');
    expect(r.status === 'denied' && r.rule.assignmentId).toBe('off');
  });

  it('a disabled lower-priority rule does not deny when an enabled higher-priority rule exists in the tier', () => {
    const on = assignment({ id: 'on', scope: 'account', priority: 100 });
    const off = assignment({ id: 'off', scope: 'account', priority: 10, enabled: false });
    expect(resolveEffectiveRule([off, on], zaloCtx()).status).toBe('active');
  });

  it('a disabled higher-priority rule denies even with an enabled lower-priority rule', () => {
    const on = assignment({ id: 'on', scope: 'account', priority: 10 });
    const off = assignment({ id: 'off', scope: 'account', priority: 100, enabled: false });
    expect(resolveEffectiveRule([on, off], zaloCtx()).status).toBe('denied');
  });

  it('a disabled global default silences conversations nothing else claims', () => {
    expect(resolveEffectiveRule([assignment({ scope: 'global', accountId: null, enabled: false })], zaloCtx()).status).toBe('denied');
  });
});

describe('Email: sender > domain > account default (legacy parity)', () => {
  const sender = assignment({ id: 'sender', scope: 'identity', scopeTarget: 'khach@example.com' });
  const domain = assignment({ id: 'domain', scope: 'domain', scopeTarget: 'example.com' });
  const def = assignment({ id: 'def', scope: 'account' });

  it('prefers sender over domain over the account default, case-insensitively', () => {
    expect(winnerId([def, domain, sender], emailCtx())).toBe('sender');
    expect(winnerId([def, domain], emailCtx())).toBe('domain');
    expect(winnerId([def], emailCtx())).toBe('def');
  });

  it('matches the domain exactly, not its subdomains', () => {
    expect(winnerId([def, domain], emailCtx({ emailSender: 'x@sub.example.com' }))).toBe('def');
  });

  it('a disabled specific sender rule silences the thread instead of falling through', () => {
    const off = assignment({ id: 'off', scope: 'identity', scopeTarget: 'khach@example.com', enabled: false });
    expect(resolveEffectiveRule([def, domain, off], emailCtx()).status).toBe('denied');
  });

  it('does not apply email predicates to a chat channel', () => {
    expect(winnerId([domain], zaloCtx({ emailSender: 'khach@example.com' }))).toBeNull();
  });
});

describe('Zalo: thread beats the nick-wide default for its kind (legacy parity)', () => {
  const groups = assignment({ id: 'groups', scope: 'account', policyExt: { legacyScope: 'account_groups' } });
  const dms = assignment({ id: 'dms', scope: 'account', policyExt: { legacyScope: 'account_dms' } });
  const thread = assignment({ id: 'thread', scope: 'conversation', scopeTarget: 'g1', agentId: 'vip' });

  it('prefers the specific thread rule', () => {
    expect(winnerId([groups, dms, thread], zaloCtx())).toBe('thread');
  });

  it('falls back to the default for the conversation kind', () => {
    expect(winnerId([groups, dms], zaloCtx({ conversationKey: 'g2', conversationKind: 'group' }))).toBe('groups');
    expect(winnerId([groups, dms], zaloCtx({ conversationKey: 'u1', conversationKind: 'direct' }))).toBe('dms');
  });

  it('a kind-restricted default does not apply to a conversation of unknown kind', () => {
    expect(winnerId([groups, dms], zaloCtx({ conversationKind: null }))).toBeNull();
  });

  it('a kind-restricted rule is more specific than a general account rule at the same priority', () => {
    const general = assignment({ id: 'general', scope: 'account' });
    expect(winnerId([general, dms], zaloCtx({ conversationKey: 'u1', conversationKind: 'direct' }))).toBe('dms');
    expect(winnerId([general, dms], zaloCtx({ conversationKey: 'g2', conversationKind: 'group' }))).toBe('general');
  });

  it('a disabled thread rule does not fall through to the default', () => {
    const off = assignment({ id: 'off', scope: 'conversation', scopeTarget: 'g9', enabled: false });
    const r = resolveEffectiveRule([groups, off], zaloCtx({ conversationKey: 'g9' }));
    expect(r.status).toBe('denied');
  });

  it('ignores other accounts', () => {
    expect(winnerId([groups, thread], zaloCtx({ accountId: 'other' }))).toBeNull();
  });
});

describe('legacy policy_ext is honoured per field', () => {
  it('keeps each stated field and takes the channel default for the rest', () => {
    const a = assignment({ policyExt: { humanPauseMinutes: 10, groupTrigger: 'smart', triggerKeywords: [' báo giá ', ''] } });
    const policy = resolvePolicy(a, 'zalo');
    expect(policy.values.humanPauseMinutes).toBe(10);
    expect(policy.values.groupTrigger).toBe('smart');
    expect(policy.values.triggerKeywords).toEqual(['báo giá']);
    expect(policy.values.maxRepliesPerThreadDay).toBe(CHANNEL_POLICY_DEFAULTS.zalo.maxRepliesPerThreadDay);
    expect(policy.sources.humanPauseMinutes).toBe('rule');
    expect(policy.sources.maxRepliesPerThreadDay).toBe('default');
    expect(policy.warnings).toEqual([]);
  });

  it('does not reset email and zalo to a common ceiling', () => {
    const email = resolvePolicy(assignment({ policyExt: { primaryOnly: false } }), 'email').values;
    const zalo = resolvePolicy(assignment({ policyExt: null }), 'zalo').values;
    expect(email.humanPauseMinutes).toBe(240);
    expect(email.maxRepliesPerThreadDay).toBe(3);
    expect(email.quietHoursMode).toBe('defer');
    expect(email.primaryOnly).toBe(false);
    expect(zalo.humanPauseMinutes).toBe(30);
    expect(zalo.maxRepliesPerThreadDay).toBe(30);
    expect(zalo.quietHoursMode).toBe('auto_to_draft');
  });

  it('treats a stated 0 as a value (no human pause) and null as not stated', () => {
    const p = resolvePolicy(assignment({ policyExt: { humanPauseMinutes: 0, maxRepliesPerThreadDay: null } }), 'email');
    expect(p.values.humanPauseMinutes).toBe(0);
    expect(p.sources.humanPauseMinutes).toBe('rule');
    expect(p.values.maxRepliesPerThreadDay).toBe(3);
    expect(p.sources.maxRepliesPerThreadDay).toBe('default');
  });

  it('a fixed legacy auto delay becomes a degenerate range; invalid values are dropped with a warning', () => {
    const p = resolvePolicy(assignment({ policyExt: { autoDelaySeconds: 45, groupTrigger: 'nope', quietHoursMode: 'defer', primaryOnly: 'yes' } }), 'zalo');
    expect(p.values.autoDelay).toEqual({ minSeconds: 45, maxSeconds: 45 });
    expect(p.values.groupTrigger).toBe('mention_or_keyword');
    expect(p.values.primaryOnly).toBe(false);
    expect(p.warnings.join('|')).toMatch(/groupTrigger/);
    expect(p.warnings.join('|')).toMatch(/primaryOnly/);
  });
});

describe('effective rule preview', () => {
  it('reports the walk, the winner and per-field sources without throwing on a conflict', () => {
    const a = assignment({ id: 'a', scope: 'account', priority: 5, mode: 'auto', policyExt: { humanPauseMinutes: 15 } });
    const b = assignment({ id: 'b', scope: 'account', priority: 5 });
    const glob = assignment({ id: 'g', scope: 'global', accountId: null });
    const conflict = previewEffectiveRule([a, b, glob], zaloCtx());
    expect(conflict.outcome).toBe('conflict');
    expect(conflict.conflict).toMatchObject({ tier: 'account', assignmentIds: ['a', 'b'] });
    // The tiers examined before the conflict are all listed.
    expect(conflict.trace.map((t) => t.tier)).toEqual(['conversation', 'customer', 'identity', 'domain', 'account']);

    const ok = previewEffectiveRule([a, glob], zaloCtx());
    expect(ok.outcome).toBe('active');
    expect(ok.rule?.tier).toBe('account');
    expect(ok.rule?.mode).toBe('auto');
    expect(ok.rule?.policy.sources.humanPauseMinutes).toBe('rule');
    expect(ok.trace.find((t) => t.tier === 'account')?.selectedId).toBe('a');
    expect(ok.rule?.policyRevision).toBe('a@1');
  });

  it('previews denied and none', () => {
    expect(previewEffectiveRule([assignment({ scope: 'account', enabled: false })], zaloCtx()).outcome).toBe('denied');
    expect(previewEffectiveRule([], zaloCtx()).outcome).toBe('none');
  });
});
