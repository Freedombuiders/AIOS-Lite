import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase } from '../store.js';
import { bindFakeRuntime, unbindFakeRuntime, type FakeRuntime } from '../test-runtime.js';
import { runAnalystAgent } from './agent-turn.js';

let rt: FakeRuntime;

beforeEach(() => {
  _initTestDatabase(':memory:');
});
afterEach(() => unbindFakeRuntime());

describe('runAnalystAgent', () => {
  it('runs one lean turn with the system text in front of the prompt and returns the text', async () => {
    rt = bindFakeRuntime({ runLean: () => ({ ok: true, output: '{"ok":true}', taskId: 7, runId: 8, usage: { costUsd: 0.02 } }), models: { 'fb-analyst': 'sonnet-x' } });
    const out = await runAnalystAgent({ agentId: 'fb-analyst', usageKey: 'fbstudio:analyst:P1', system: 'SYS', prompt: 'PROMPT' });
    expect(out).toMatchObject({ text: '{"ok":true}', model: 'sonnet-x', costUsd: 0.02 });
    expect(out.error).toBeUndefined();
    expect(rt.leanCalls).toHaveLength(1);
    expect(rt.leanCalls[0]).toMatchObject({ agentId: 'fb-analyst', meta: { kind: 'fb-analyst', usageKey: 'fbstudio:analyst:P1' } });
    expect(rt.leanCalls[0].prompt).toBe('SYS\n\n---\n\nPROMPT');
  });

  it('reports a failed turn with its text', async () => {
    bindFakeRuntime({ runLean: () => ({ ok: false, output: 'half an ans', taskId: 1, runId: null, error: 'rate limited' }) });
    const out = await runAnalystAgent({ agentId: 'main', usageKey: 'k', system: 's', prompt: 'p' });
    expect(out).toMatchObject({ text: 'half an ans', error: 'rate limited' });
  });

  it('catches an engine that throws', async () => {
    bindFakeRuntime({ runLean: () => { throw new Error('spawn failed'); } });
    const out = await runAnalystAgent({ agentId: 'main', usageKey: 'k', system: 's', prompt: 'p' });
    expect(out).toMatchObject({ text: '', error: 'spawn failed' });
  });
});
