import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createModuleContext } from './context.js';
import { sanitizeOutbound } from './outbound.js';
import { readManifest } from './loader.js';
import { createSettingsStore } from './settings.js';
import type { ModuleContext } from './sdk.js';
import { createTestHarness, type TestHarness } from './test-deps.js';

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), '__tests__', 'modules', 'fx');
let h: TestHarness;
let ctx: ModuleContext;
let stops: Set<() => void>;

beforeEach(() => {
  h = createTestHarness();
  const manifest = readManifest(FX);
  const settings = createSettingsStore(h.deps.db, h.deps.cipher, () => manifest);
  const res = { stops: new Set<() => void>() };
  stops = res.stops;
  ctx = createModuleContext(h.deps, manifest, FX, res, { settings, isEnabled: () => false, provides: () => undefined });
});
afterEach(() => {
  for (const s of [...stops]) s();
  h.cleanup();
});

describe('runLean', () => {
  it('creates a lean module task and returns the run output', async () => {
    h.fakes.state.autoFinish = () => ({ output: '{"reply":"chào"}' });
    const r = await ctx.agents.runLean({ agentId: 'main', title: 'T', prompt: 'P', moduleContext: 'CTX', images: ['/a.png'], meta: { k: 1 } });
    expect(r).toMatchObject({ ok: true, output: '{"reply":"chào"}', usage: { inputTokens: 10, outputTokens: 5 } });
    expect(r.runId).not.toBeNull();
    const t = h.fakes.tasks[0]!;
    expect(t).toMatchObject({ contextProfile: 'lean', trigger: 'module', source: 'module:fx', priority: 5 });
    expect(t.meta).toEqual({ k: 1, moduleContext: 'CTX', images: ['/a.png'] });
  });

  it('reports failures and timeouts without throwing', async () => {
    h.fakes.state.autoFinish = () => ({ status: 'failed', error: 'hết quota' });
    expect(await ctx.agents.runLean({ agentId: 'main', title: 'T', prompt: 'P' })).toMatchObject({ ok: false, error: 'hết quota' });
    h.fakes.state.autoFinish = undefined;
    const r = await ctx.agents.runLean({ agentId: 'main', title: 'T', prompt: 'P', timeoutMs: 20 });
    expect(r.ok).toBe(false);
    expect(h.fakes.tasks.at(-1)!.status).toBe('cancelled');
  });

  it('forces source on tasks.create', () => {
    const t = ctx.tasks.create({ prompt: 'x', agentId: 'main' });
    expect(t.source).toBe('module:fx');
  });
});

describe('context services', () => {
  it('schedule.every (interval and cron) stops via returned fn and on teardown', async () => {
    let n = 0;
    const stop = ctx.schedule.every('a', 5, () => void n++);
    ctx.schedule.every('b', '* * * * *', () => {});
    expect(stops.size).toBe(2);
    await new Promise((r) => setTimeout(r, 30));
    stop();
    const seen = n;
    expect(seen).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(n).toBe(seen);
    expect(stops.size).toBe(1);
  });

  it('events are namespaced and subscribable', () => {
    const got: unknown[] = [];
    const bus: unknown[] = [];
    h.deps.bus.on('custom', (e) => bus.push(e.name));
    ctx.events.on('ping', (p) => got.push(p));
    ctx.events.emit('ping', { a: 1 });
    expect(bus).toEqual(['fx:ping']);
    expect(got).toEqual([{ a: 1 }]);
  });

  it('attention keys are prefixed and audit actor defaults to the module', () => {
    ctx.attention.raise({ key: 'draft:1', title: 'Duyệt' });
    expect(h.fakes.attention.get('module:fx:draft:1')).toMatchObject({ kind: 'module', moduleId: 'fx', severity: 'info' });
    ctx.attention.resolve('draft:1');
    expect(h.fakes.attention.size).toBe(0);
    ctx.audit.log('x.y', 't', { a: 1 });
    expect(h.deps.audit.list()[0]).toMatchObject({ actor: 'module:fx', action: 'x.y', target: 't' });
  });

  it('access.can maps to the module scope; settings round-trip with secrets decrypted', () => {
    h.fakes.agents.get('main')!.access.modules = { fx: ['read'] };
    expect(ctx.access.can('main', 'read')).toBe(true);
    expect(ctx.access.can('main', 'write')).toBe(false);
    ctx.settings.set('token', 'sekret-1');
    expect(ctx.settings.get('token')).toBe('sekret-1');
    expect(ctx.settings.get('greeting')).toBe('xin chào');
    expect(ctx.crypto.decrypt(ctx.crypto.encrypt('abc'))).toBe('abc');
  });

  it('dataDir is created on demand under data/modules/<id>', () => {
    expect(ctx.dataDir).toBe(path.join(h.deps.config.dataDir, 'modules', 'fx'));
  });
});

describe('outbound.sanitize', () => {
  it('strips secrets, paths, ANSI, directive tags and fences; keeps Vietnamese', () => {
    const input = 'Xin chào anh \u001b[31mĐức\u001b[0m! Key sk-ant-abcdefghijklmnopqrstuv.\n```json\n{"a":1}\n```\n<aios-delegate to="x">file /Users/tony/secret/a.txt hoặc ~/Documents/x.md</aios-delegate> Xem https://example.com/Users/a';
    const out = sanitizeOutbound(input);
    expect(out).toContain('Xin chào anh Đức!');
    expect(out).not.toMatch(/sk-ant|\u001b|```|aios-|\/Users\/tony|~\/Documents/);
    expect(out).toContain('{"a":1}');
    expect(out).toContain('https://example.com/Users/a');
  });
});
