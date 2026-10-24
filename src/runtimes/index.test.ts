import { describe, expect, it } from 'vitest';
import type { Runtime } from './contracts.js';
import { createRuntimeRegistry } from './index.js';
import { fixture } from './test-util.js';

describe('createRuntimeRegistry', () => {
  it('has the five adapters and honest capability tables', () => {
    const reg = createRuntimeRegistry();
    expect(reg.list().map((r) => r.id).sort()).toEqual(['claude', 'codex', 'grok', 'hermes', 'mock']);
    for (const r of reg.list()) {
      expect(r.capabilities.enforces.context).toBe('hard');
      expect(r.capabilities.noTools).toBe(true);
    }
    expect(reg.get('codex').capabilities.enforces.fileRead).toBe('none');
    expect(reg.get('claude').capabilities.enforces.fileRead).toBe('hard');
    expect(reg.get('codex').capabilities.reportsCost).toBe(false);
    expect(reg.get('codex').capabilities.images).toBe(true);
    expect(reg.get('claude').capabilities.systemPrompt).toBe('native');
    expect(reg.get('codex').capabilities.systemPrompt).toBe('inline');
    for (const r of reg.list()) expect(r.capabilities.enforces.note ?? '').toMatch(/[ạăâêôơưđ]|Runtime|Codex|Chế/);
  });

  it('get throws for unknown ids and register replaces an adapter', async () => {
    const reg = createRuntimeRegistry();
    expect(() => reg.get('nope' as never)).toThrow();
    const fake = { ...reg.get('mock'), label: 'Fake' } satisfies Runtime;
    reg.register(fake);
    expect(reg.get('mock').label).toBe('Fake');
  });

  it('commands/env options reach the adapters', async () => {
    const reg = createRuntimeRegistry({ commands: { claude: fixture('fake-claude.mjs') }, env: { FAKE_SCENARIO: 'ok' } });
    const report = await reg.get('claude').doctor();
    expect(report.command).toBe(fixture('fake-claude.mjs'));
    expect(report.version).toBe('fake-cli 1.2.3');
    expect(report.status).toBe('pass');
    expect(report.checks.find((c) => c.code === 'claude.auth')?.message).toContain('Đã đăng nhập');
  });

  it('claude doctor flags a logged-out CLI; probe runs a real turn through the adapter', async () => {
    const out = createRuntimeRegistry({ commands: { claude: fixture('fake-claude.mjs') }, env: { FAKE_SCENARIO: 'loggedout' } });
    const r = await out.get('claude').doctor();
    expect(r.status).toBe('fail');
    const ok = createRuntimeRegistry({ commands: { claude: fixture('fake-claude.mjs') }, env: { FAKE_SCENARIO: 'ok' } });
    const probed = await ok.get('claude').doctor({ probe: true });
    expect(probed.checks.find((c) => c.code === 'claude.probe')?.level).toBe('info');
  });

  it('hermes doctor runs acp --check', async () => {
    const good = await createRuntimeRegistry({ commands: { hermes: fixture('fake-hermes.mjs') } }).get('hermes').doctor();
    expect(good.checks.find((c) => c.code === 'hermes.acp')?.level).toBe('info');
    const bad = await createRuntimeRegistry({ commands: { hermes: fixture('fake-hermes.mjs') }, env: { FAKE_SCENARIO: 'acpbad' } }).get('hermes').doctor();
    expect(bad.status).toBe('fail');
  });
});

describe('doctor', () => {
  it('reports a missing binary for every CLI runtime', async () => {
    const reg = createRuntimeRegistry({ commands: { claude: '/nope/claude', codex: '/nope/codex', grok: '/nope/grok', hermes: '/nope/hermes' } });
    for (const id of ['claude', 'codex', 'grok', 'hermes'] as const) {
      const r = await reg.get(id).doctor();
      expect(r.status).toBe('fail');
      expect(r.checks[0]).toMatchObject({ level: 'error' });
      expect(r.checks[0]!.message).toContain('Không tìm thấy');
    }
  });

  it('mock is always healthy', async () => {
    expect((await createRuntimeRegistry().get('mock').doctor({ probe: true })).status).toBe('pass');
  });
});
