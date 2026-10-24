import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestHarness, type TestHarness } from '../test-deps.js';
import * as compat from './index.js';
import { _reset, _setOverride } from './kill-switches.js';
import { unbindCompat } from './state.js';

let h: TestHarness;
beforeEach(() => {
  h = createTestHarness();
  compat.bindCompat(h.deps);
});
afterEach(() => {
  _reset();
  unbindCompat();
  h.cleanup();
});

describe('binding, db, logger, config', () => {
  it('db proxy and getDb hit the bound database; _initTestDatabase binds a fresh one', () => {
    h.deps.db.prepare("INSERT INTO kv (key, value) VALUES ('a','1')").run();
    expect((compat.db.prepare('SELECT value FROM kv WHERE key = ?').get('a') as { value: string }).value).toBe('1');
    expect(compat.getDb()).toBe(h.deps.db);
    compat._initTestDatabase();
    expect(compat.getDb()).not.toBe(h.deps.db);
    expect(compat.getDb().prepare("SELECT name FROM sqlite_master WHERE name='tasks'").get()).toBeTruthy();
    compat.initDatabase();
  });

  it('throws a clear error when unbound', () => {
    unbindCompat();
    expect(() => compat.getDb()).toThrow(/bindCompat/);
  });

  it('live-binding config constants follow the bound deps', () => {
    expect(compat.PROJECT_ROOT).toBe(h.deps.config.rootDir);
    expect(compat.STORE_DIR).toBe(path.join(h.deps.config.dataDir, 'store'));
    expect(compat.AGENT_ID).toBe('main');
    expect(compat.ZALO_CONTROL_PORT).toBe(h.deps.config.port + 1);
    expect(compat.CLAUDECLAW_CONFIG).toMatchObject({ timezone: h.deps.config.timezone });
    expect(compat.DB_ENCRYPTION_KEY).toBe('');
  });

  it('logger forwards to the app logger', () => {
    const spy = vi.spyOn(h.deps.log, 'info');
    compat.logger.info('xin chào');
    expect(spy).toHaveBeenCalledWith('xin chào');
    expect(typeof compat.logger.child).toBe('function');
  });

  it('saveTokenUsage accumulates totals', () => {
    const before = compat.tokenUsageTotals().turns;
    compat.saveTokenUsage('c', 's', 10, 5, 0, 15, 0.01, false, 'main', null, 0, { costSource: 'provider' });
    expect(compat.tokenUsageTotals().turns).toBe(before + 1);
  });
});

describe('agents and provider', () => {
  it('agent config helpers', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-agent-'));
    fs.writeFileSync(path.join(dir, 'persona.md'), 'x');
    h.fakes.agents.get('main')!.dir = dir;
    expect(compat.listAgentIds()).toEqual(['main']);
    expect(compat.loadAgentConfig('main').id).toBe('main');
    expect(() => compat.loadAgentConfig('zz')).toThrow();
    expect(compat.resolveAgentDir('main')).toBe(dir);
    expect(compat.resolveAgentClaudeMd('main')).toBe(path.join(dir, 'persona.md'));
    expect(compat.resolveAgentClaudeMd('zz')).toBeNull();
    expect(compat.resolveAgentDir('zz')).toBe(path.join(h.deps.config.agentsDir, 'zz'));
    fs.rmSync(dir, { recursive: true });
  });

  it('provider mapping and defaults', () => {
    expect(compat.getMainProviderConfig()).toEqual({ type: 'harness' }); // mock runtime
    h.fakes.agents.get('main')!.runtime = 'codex';
    h.fakes.agents.get('main')!.model = 'gpt-x';
    expect(compat.getMainProviderConfig()).toEqual({ type: 'acp-codex', model: 'gpt-x' });
    expect(compat.DEFAULT_PROVIDER.type).toBe('claude');
    expect(compat.defaultModelForProvider({ type: 'claude' })).toBe(compat.DEFAULT_CLAUDE_MODEL);
    expect(compat.defaultModelForProvider({ type: 'claude' }, 'm')).toBe('m');
    expect(compat.defaultModelForProvider({ type: 'openai', model: 'z' })).toBe('z');
    expect(compat.defaultModelForProvider({ type: 'openai' })).toBeUndefined();
    expect(compat.providerRunnable('claude')).toBe(true);
    expect(compat.providerRunnable('openrouter')).toBe(false);
  });
});

describe('kill switches', () => {
  it('default on; kv, env, emergency stop and overrides', () => {
    expect(compat.isEnabled('FB_PUBLISH_ENABLED')).toBe(true);
    compat.setKillSwitch('FB_PUBLISH_ENABLED', false);
    expect(compat.isEnabled('FB_PUBLISH_ENABLED')).toBe(false);
    expect(() => compat.requireEnabled('FB_PUBLISH_ENABLED')).toThrow(compat.KillSwitchDisabledError);
    compat.setKillSwitch('FB_PUBLISH_ENABLED', true);
    expect(compat.isEnabled('FB_PUBLISH_ENABLED')).toBe(true);
    process.env.ZALO_AUTOREPLY_ENABLED = '0';
    expect(compat.isEnabled('ZALO_AUTOREPLY_ENABLED')).toBe(false);
    delete process.env.ZALO_AUTOREPLY_ENABLED;
    h.deps.db.prepare("INSERT INTO kv (key, value) VALUES ('emergency_stop','1')").run();
    expect(compat.isEnabled('LLM_SPAWN_ENABLED')).toBe(false);
    _setOverride('LLM_SPAWN_ENABLED', true);
    expect(compat.isEnabled('LLM_SPAWN_ENABLED')).toBe(true);
    _reset();
    try {
      compat.requireEnabled('LLM_SPAWN_ENABLED');
    } catch (e) {
      expect((e as compat.KillSwitchDisabledError).switchName).toBe('LLM_SPAWN_ENABLED');
    }
  });
});

describe('kill switch from module settings', () => {
  it('uses a bound module setting named after the switch', () => {
    const settings: Record<string, unknown> = { FB_PUBLISH_ENABLED: false };
    compat.bindModuleCompat('m', { manifest: { settings: { FB_PUBLISH_ENABLED: {} } }, settings: { get: (k: string) => settings[k] } } as never);
    expect(compat.isEnabled('FB_PUBLISH_ENABLED')).toBe(false);
    settings.FB_PUBLISH_ENABLED = true;
    expect(compat.isEnabled('FB_PUBLISH_ENABLED')).toBe(true);
    compat.unbindModuleCompat('m');
  });
});

describe('process, env, security', () => {
  it('isProcessAlive / killProcess', () => {
    expect(compat.isProcessAlive(process.pid)).toBe(true);
    expect(compat.isProcessAlive(0)).toBe(false);
    expect(compat.isProcessAlive(2 ** 22 + 12345)).toBe(false);
    expect(compat.killProcess(-1)).toBe(false);
    expect(compat.killProcess(2 ** 22 + 12345)).toBe(false);
  });

  it('readEnvFile prefers .env then process.env, setEnvKey writes', () => {
    const file = h.deps.config.envFile;
    compat.setEnvKey(file, 'COMPAT_A', 'one');
    process.env.COMPAT_B = 'two';
    expect(compat.readEnvFile(['COMPAT_A', 'COMPAT_B', 'COMPAT_NONE'])).toEqual({ COMPAT_A: 'one', COMPAT_B: 'two' });
    expect(fs.readFileSync(file, 'utf8')).toContain('COMPAT_A=one');
    delete process.env.COMPAT_A;
    delete process.env.COMPAT_B;
  });

  it('getScrubbedSdkEnv drops secrets but keeps explicit auth vars', () => {
    process.env.SOME_API_TOKEN = 'abc';
    process.env.COMPAT_PLAIN = 'ok';
    const env = compat.getScrubbedSdkEnv({ ANTHROPIC_API_KEY: 'sk-x' });
    expect(env.SOME_API_TOKEN).toBeUndefined();
    expect(env.COMPAT_PLAIN).toBe('ok');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-x');
    delete process.env.SOME_API_TOKEN;
    delete process.env.COMPAT_PLAIN;
  });
});

describe('outbound', () => {
  it('policy, options and sanitizeOutboundText', () => {
    const policy = compat.resolveOutboundPolicy({ MY_SECRET_VALUE: 'supersecret123', PLAIN: 'x', OUTBOUND_SANITIZE: '1' });
    expect(policy).toEqual({ enabled: true, protectedValues: ['supersecret123'] });
    expect(compat.resolveOutboundPolicy({ OUTBOUND_SANITIZE: '0' }).enabled).toBe(false);
    expect(compat.outboundOptionsForSeam('fb.comment', policy)).toMatchObject({ seam: 'fb.comment', enabled: true });
    const events: unknown[] = [];
    const out = compat.sanitizeOutboundText('Chào bạn, mã supersecret123 ở /Users/a/b.txt', { ...compat.outboundOptionsForSeam('x', policy), onEvent: (e) => events.push(e) });
    expect(out).toBe('Chào bạn, mã [redacted] ở');
    expect(events.length).toBeGreaterThan(0);
    expect(compat.sanitizeOutboundText('/Users/a/b', { enabled: false })).toBe('/Users/a/b');
  });
});

describe('agent engine + notify', () => {
  it('EngineFactory turns invoke() into a lean task', async () => {
    h.fakes.state.autoFinish = () => ({ output: 'đã xong' });
    const events: string[] = [];
    let result: unknown;
    for await (const e of compat.EngineFactory.forProvider({ type: 'claude' }).invoke({ prompt: 'làm đi', provider: { type: 'claude' }, cwd: '/tmp', agentId: 'main' })) {
      events.push(e.type);
      if (e.type === 'result') result = e;
    }
    expect(events).toEqual(['progress', 'text_delta', 'result']);
    expect(result).toMatchObject({ text: 'đã xong', usage: { inputTokens: 10 } });
    expect(h.fakes.tasks[0]).toMatchObject({ contextProfile: 'lean', source: 'module:compat' });
  });

  it('reports failures as error events', async () => {
    h.fakes.state.autoFinish = () => ({ status: 'failed', error: 'hết quota' });
    const types: string[] = [];
    for await (const e of compat.EngineFactory.forProvider({ type: 'claude' }).invoke({ prompt: 'x', provider: { type: 'claude' }, cwd: '/tmp' })) types.push(e.type);
    expect(types).toEqual(['progress', 'error']);
  });

  it('notifyOwner raises a module attention item', () => {
    compat.notifyOwner({ key: 'draft:1', title: 'Duyệt nháp', moduleId: 'care' });
    expect(h.fakes.attention.get('module:care:draft:1')).toMatchObject({ kind: 'module', moduleId: 'care' });
  });

  it('crash-guard installs once as a side effect', async () => {
    const before = process.listenerCount('unhandledRejection');
    await import('./crash-guard.js');
    await import('./crash-guard.js');
    expect(process.listenerCount('unhandledRejection')).toBeLessThanOrEqual(before + 1);
  });
});
