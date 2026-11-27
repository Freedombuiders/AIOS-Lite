import { describe, expect, it } from 'vitest';
import { KNOWN_RUNTIME_NAMES, allowedRuntimes, isKnownRuntime, isLegacyRuntime, legacyRuntimeMessage, runtimeLabel, runtimeRefusal } from './runtime-policy.js';

describe('runtime policy (GenBot only; G3 deleted the old engines)', () => {
  it('offers genbot, plus mock only under tests or AIOS_MOCK=1', () => {
    expect(allowedRuntimes({})).toEqual(['genbot']);
    expect(allowedRuntimes({ AIOS_MOCK: '1' })).toEqual(['genbot', 'mock']);
    expect(allowedRuntimes({ VITEST: 'true' })).toEqual(['genbot', 'mock']);
  });

  it('still knows the old engine names, so an old agent.yaml loads and is flagged instead of failing', () => {
    for (const r of ['claude', 'codex', 'grok', 'hermes']) {
      expect(isLegacyRuntime(r)).toBe(true);
      expect(isKnownRuntime(r)).toBe(true);
    }
    expect(KNOWN_RUNTIME_NAMES).toEqual(expect.arrayContaining(['genbot', 'mock']));
    expect(isKnownRuntime('nope')).toBe(false);
    expect(isLegacyRuntime('genbot')).toBe(false);
  });

  it('speaks Vietnamese: the attention text and the refusal name the engine', () => {
    expect(runtimeLabel('claude')).toBe('Claude Code');
    expect(runtimeLabel('genbot')).toBe('GenBot');
    expect(legacyRuntimeMessage('Trợ lý cũ', 'codex')).toMatch(/^Agent Trợ lý cũ đang dùng Codex, hãy chuyển sang GenBot\./);
    expect(legacyRuntimeMessage('X', 'grok')).toContain('Chuyển sang GenBot');
    expect(runtimeRefusal('grok')).toMatch(/Grok.*không còn được dùng.*GenBot/);
  });
});
