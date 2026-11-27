import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_ID, botHasKey, pickDefaultAgent } from './default-agent.js';

const a = (id: string, runtime = 'genbot', enabled = true) => ({ id, runtime, enabled }) as never;

describe('pickDefaultAgent (the agent for work nobody assigned)', () => {
  it('is the Trợ lý bot when it has a key', () => {
    expect(DEFAULT_AGENT_ID).toBe('bot-tro-ly');
    expect(pickDefaultAgent([a('bot-cskh'), a('bot-tro-ly')], () => true)).toBe('bot-tro-ly');
  });

  it('else the first GenBot bot with a key', () => {
    expect(pickDefaultAgent([a('bot-cskh'), a('bot-tro-ly'), a('bot-noi-dung')], (id) => id === 'bot-noi-dung')).toBe('bot-noi-dung');
  });

  it('with no key anywhere: the Trợ lý bot, else the first bot (its run then explains the missing key)', () => {
    expect(pickDefaultAgent([a('bot-cskh'), a('bot-tro-ly')])).toBe('bot-tro-ly');
    expect(pickDefaultAgent([a('bot-cskh'), a('x')])).toBe('bot-cskh');
  });

  it('skips paused bots and legacy agents; a mock agent counts only when there is no bot; null when nothing fits', () => {
    expect(pickDefaultAgent([a('bot-tro-ly', 'genbot', false), a('old', 'claude'), a('m', 'mock')])).toBe('m');
    expect(pickDefaultAgent([a('old', 'claude')])).toBeNull();
    expect(pickDefaultAgent([])).toBeNull();
  });
});

describe('botHasKey', () => {
  const bot = (runtimeOptions: Record<string, string> = {}) => ({ id: 'b', runtime: 'genbot' as const, runtimeOptions });
  it('a stored key or a set GENBOT_KEY_* variable; never a legacy agent', () => {
    expect(botHasKey(bot(), { has: () => true })).toBe(true);
    expect(botHasKey(bot(), { has: () => false })).toBe(false);
    expect(botHasKey(bot({ key_env: 'GENBOT_KEY_B' }), { has: () => false }, { GENBOT_KEY_B: 'k' })).toBe(true);
    expect(botHasKey(bot({ key_env: 'OTHER' }), { has: () => false }, { OTHER: 'k' })).toBe(false);
    expect(botHasKey({ id: 'o', runtime: 'claude', runtimeOptions: {} }, { has: () => true })).toBe(false);
    expect(botHasKey(undefined, { has: () => true })).toBe(false);
  });
});
