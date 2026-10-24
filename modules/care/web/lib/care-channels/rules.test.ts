import { describe, expect, it } from 'vitest';
import type { CareAssignmentDto } from '@modules/care/server/api/dto-ops';
import { aiModeOf, buildRuleRows, filterRuleRows, keywordsSummary, type RuleLabels } from './rules';

const labels: RuleLabels = { care: { 'care-z1': 'Nick bán hàng', 'care-e1': 'sale@shop.test' } };

const core = (p: Partial<CareAssignmentDto> = {}): CareAssignmentDto => ({
  id: 'c1', scope: 'account', accountId: 'care-z1', customerId: null, channel: null, scopeTarget: null, priority: 100, enabled: true, mode: 'observe', agentId: 'care-agent',
  instructionsRef: null, policyExt: null, configVersion: 1, ...p,
});

describe('buildRuleRows', () => {
  it('observe means a person answers (AI off); a disabled rule means nobody is assigned', () => {
    const rows = buildRuleRows({ core: [core({ id: 'a' }), core({ id: 'b', enabled: false }), core({ id: 'c', mode: 'auto' })], labels });
    const byId = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byId['core:a']).toMatchObject({ owner: 'human', aiMode: 'off', agentId: 'care-agent', accountLabel: 'Nick bán hàng' });
    expect(byId['core:b']).toMatchObject({ owner: 'none', aiMode: 'off', agentId: null, enabled: false });
    expect(byId['core:c']).toMatchObject({ owner: 'agent', aiMode: 'auto' });
    expect(aiModeOf('observe')).toBe('off');
    expect(aiModeOf('auto')).toBe('auto');
  });

  it('puts conversation-level rows first, then customer, account, channel', () => {
    const rows = buildRuleRows({
      core: [
        core({ id: 'g', scope: 'global', accountId: null }),
        core({ id: 'ch', scope: 'channel', accountId: null, channel: 'email' }),
        core({ id: 'acc' }),
        core({ id: 'cu', scope: 'customer', accountId: null, customerId: 'customer-123456' }),
        core({ id: 'cv', scope: 'conversation', accountId: null, scopeTarget: 'conv-1' }),
      ],
      labels,
    });
    expect(rows.map((r) => r.key)).toEqual(['core:cv', 'core:cu', 'core:acc', 'core:g', 'core:ch']);
    expect(rows[0]).toMatchObject({ target: 'thread', subject: 'conv-1' });
  });

  it('reads keywords from the policy, review first, ignoring non-strings', () => {
    const [r] = buildRuleRows({ core: [core({ policyExt: { reviewKeywords: ['refund'], handoffKeywords: ['x'] } })], labels });
    expect(r).toMatchObject({ keywords: ['refund'], keywordsKind: 'review' });
    const [h] = buildRuleRows({ core: [core({ policyExt: { handoffKeywords: ['x', 5, ' '] } })], labels });
    expect(h).toMatchObject({ keywords: ['x'], keywordsKind: 'handoff' });
  });
});

describe('summaries and filters', () => {
  it('keywordsSummary shows the first words and a +N', () => {
    expect(keywordsSummary([])).toBe('');
    expect(keywordsSummary(['a', 'b'])).toBe('a, b');
    expect(keywordsSummary(['a', 'b', 'c', 'd', 'e', 'f'], 4)).toBe('a, b, c, d +2');
  });

  it('filterRuleRows narrows by channel and keeps channel-less rules visible', () => {
    const rows = buildRuleRows({ core: [core({ id: 'z', channel: 'zalo' }), core({ id: 'e', channel: 'email' }), core({ id: 'g', scope: 'global', accountId: null })], labels });
    expect(filterRuleRows(rows, 'all')).toHaveLength(3);
    expect(filterRuleRows(rows, 'email').map((r) => r.key).sort()).toEqual(['core:e', 'core:g']);
  });
});
