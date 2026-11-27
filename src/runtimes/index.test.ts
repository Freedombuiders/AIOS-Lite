import { describe, expect, it } from 'vitest';
import type { Runtime } from './contracts.js';
import { createRuntimeRegistry } from './index.js';

describe('createRuntimeRegistry', () => {
  it('has only GenBot and the mock, with honest capability tables', () => {
    const reg = createRuntimeRegistry();
    expect(reg.list().map((r) => r.id).sort()).toEqual(['genbot', 'mock']);
    for (const r of reg.list()) {
      expect(r.capabilities.enforces.context).toBe('hard');
      expect(r.capabilities.noTools).toBe(true);
      expect(r.capabilities.enforces.note ?? '').toMatch(/[ạăâêôơưđ]/);
    }
    expect(reg.get('genbot').capabilities).toMatchObject({ resume: false, systemPrompt: 'inline', reportsCost: false, noTools: true, mcp: false, readsFiles: false, maxPromptChars: 20_000 });
    expect(reg.get('genbot').capabilities.enforces.mcp).toBe('hard');
    expect(reg.get('mock').capabilities).toMatchObject({ mcp: true, readsFiles: true });
  });

  it('an old engine named by a legacy agent.yaml has no adapter: get throws, find returns undefined', () => {
    const reg = createRuntimeRegistry();
    expect(() => reg.get('claude')).toThrow(/Runtime không tồn tại: Claude Code/);
    expect(reg.find('codex')).toBeUndefined();
    expect(reg.find('genbot')?.id).toBe('genbot');
  });

  it('register replaces an adapter', () => {
    const reg = createRuntimeRegistry();
    const fake = { ...reg.get('mock'), label: 'Fake' } satisfies Runtime;
    reg.register(fake);
    expect(reg.get('mock').label).toBe('Fake');
  });
});

describe('doctor', () => {
  it('genbot doctor needs no binary and stays generic (agents are checked one by one elsewhere)', async () => {
    const r = await createRuntimeRegistry().get('genbot').doctor();
    expect(r.status).toBe('pass');
    expect(r.checks[0]!.code).toBe('genbot.http');
  });

  it('mock is always healthy', async () => {
    expect((await createRuntimeRegistry().get('mock').doctor({ probe: true })).status).toBe('pass');
  });
});
