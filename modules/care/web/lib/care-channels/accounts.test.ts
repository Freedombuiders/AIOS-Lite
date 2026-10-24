import { describe, expect, it } from 'vitest';
import type { CareAssignmentDto } from '@modules/care/server/api/dto-ops';
import { defaultAgentOf, quietHoursText, usageView } from './accounts';

const rule = (p: Partial<CareAssignmentDto>): CareAssignmentDto => ({
  id: 'r1', scope: 'account', accountId: 'a1', customerId: null, channel: null, scopeTarget: null, priority: 0, enabled: true, mode: 'draft',
  agentId: 'care-agent', instructionsRef: null, policyExt: null, configVersion: 1, ...p,
});

describe('usage bar', () => {
  it('shows used / limit with a clamped percentage', () => {
    expect(usageView(32, 150)).toEqual({ used: 32, limit: 150, percent: 21, hot: false });
    expect(usageView(140, 150)).toMatchObject({ percent: 93, hot: true });
    expect(usageView(500, 150)).toMatchObject({ percent: 100, hot: true });
    expect(usageView(5, 0)).toMatchObject({ percent: 0, hot: false });
    expect(usageView(-3, 10)).toMatchObject({ used: 0, percent: 0 });
  });

  it('prints quiet hours only when they are on', () => {
    expect(quietHoursText({ enabled: true, start: '22:00', end: '07:00' })).toBe('22:00–07:00');
    expect(quietHoursText({ enabled: false, start: '22:00', end: '07:00' })).toBeNull();
    expect(quietHoursText(null)).toBeNull();
  });
});

describe('default agent of an account', () => {
  it('uses the account-scope rule of that account only', () => {
    const list = [rule({ id: 'x', accountId: 'other', agentId: 'o' }), rule({ id: 'y', scope: 'customer', agentId: 'c' }), rule({ id: 'z', agentId: 'mine', mode: 'auto' })];
    expect(defaultAgentOf(list, 'a1')).toEqual({ agentId: 'mine', mode: 'auto', enabled: true });
    expect(defaultAgentOf(list, 'none')).toBeNull();
  });

  it('prefers the higher priority rule', () => {
    expect(defaultAgentOf([rule({ id: 'a', priority: 1, agentId: 'low' }), rule({ id: 'b', priority: 5, agentId: 'high' })], 'a1')?.agentId).toBe('high');
  });
});
