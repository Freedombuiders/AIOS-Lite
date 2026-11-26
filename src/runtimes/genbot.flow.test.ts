// A `runtime: genbot` agent through the real engine (chat and a lean module turn), against the fake GenBot server.
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs fixture without types
import { FAKE_GENBOT_KEY, startFakeGenbot } from '../../test-fixtures/runtimes/fake-genbot.mjs';
import { agent, makeKit, type Kit } from '../work/test-kit.js';
import { createGenbotRuntime, GENBOT_CAPABILITIES } from './genbot.js';

let kit: Kit | undefined;
let fake: { url: string; requests: { method: string; body: { message: string } }[]; close(): Promise<void> } | undefined;
afterEach(async () => {
  await kit?.deps.dispatcher.stop();
  await fake?.close();
  kit = fake = undefined;
});

async function setup(context: 'standard' | 'lean', scenario = 'working') {
  fake = await startFakeGenbot({ scenario, workingPolls: 1, reply: 'Dạ, sen Tây Hồ còn hàng ạ.' });
  const opts = { base_url: fake!.url, bot_id: 'bot_cskh', key_env: 'GENBOT_KEY_CSKH' };
  const k = makeKit([agent('bot-cskh', { runtime: 'genbot', context, runtimeOptions: opts })], { runtimeCaps: GENBOT_CAPABILITIES });
  const genbot = createGenbotRuntime({ env: { GENBOT_KEY_CSKH: FAKE_GENBOT_KEY }, pollMs: 10 });
  k.script.current = (req) => genbot.run(req);
  k.deps.dispatcher.start();
  kit = k;
  return k;
}

describe('genbot agent through the engine', () => {
  it('answers in chat; the whole context goes in one message', async () => {
    const k = await setup('standard');
    const conv = k.deps.chat.create({ agentId: 'bot-cskh' });
    k.deps.chat.send(conv.id, 'Còn sen Tây Hồ không?');
    await k.settle(5000);
    const msgs = k.deps.chat.get(conv.id)!.messages;
    expect(msgs.map((m) => m.role)).toEqual(['user', 'agent']);
    expect(msgs[1]!.content).toBe('Dạ, sen Tây Hồ còn hàng ạ.');
    expect(fake!.requests[0]!.body.message).toMatch(/^sys\n\n/);
    expect(fake!.requests[0]!.body.message).toContain('Còn sen Tây Hồ không?');
    const run = k.deps.runs.list({ agentId: 'bot-cskh' })[0]!;
    expect(run).toMatchObject({ status: 'done', runtime: 'genbot', costUsd: null, inputTokens: null });
  });

  it('answers a lean module turn', async () => {
    const k = await setup('lean');
    const t = k.deps.tasks.create({ agentId: 'bot-cskh', prompt: 'Khách hỏi giá sen', source: 'module:care', trigger: 'module', contextProfile: 'lean' });
    await k.settle(5000);
    expect(k.deps.tasks.require(t.id)).toMatchObject({ status: 'done', result: 'Dạ, sen Tây Hồ còn hàng ạ.' });
    expect(k.deps.tasks.require(t.id).contextProfile).toBe('lean');
    expect(fake!.requests[0]!.body.message).toContain('Khách hỏi giá sen');
  });

  it('passes the runtime limits to the context builder', async () => {
    const k = await setup('lean');
    k.deps.tasks.create({ agentId: 'bot-cskh', prompt: 'x', source: 'module:care', trigger: 'module', contextProfile: 'lean' });
    await k.settle(5000);
    expect(k.calls.contexts[0]!.runtime).toEqual({ maxPromptChars: 20_000, readsFiles: false });
  });

  it('needs_approval fails the task as access AND raises an attention item naming the GenBot thread', async () => {
    const k = await setup('lean', 'approval');
    const t = k.deps.tasks.create({ agentId: 'bot-cskh', prompt: 'Khách hỏi giá sen', source: 'module:care', trigger: 'module', contextProfile: 'lean' });
    await k.settle(5000);
    const done = k.deps.tasks.require(t.id);
    expect(done.status).toBe('failed');
    expect(done.meta.errorFamily).toBe('access');
    const item = k.deps.attention.list().find((a) => a.taskId === t.id);
    expect(item).toBeDefined();
    expect(item!.detail).toContain('app GenBot');
    expect(item!.detail).toContain('t1');
  });

  it('429 keeps retryAfter on the task for runLean to hand back', async () => {
    const k = await setup('lean', 'status:429');
    const t = k.deps.tasks.create({ agentId: 'bot-cskh', prompt: 'x', source: 'module:care', trigger: 'module', contextProfile: 'lean' });
    await k.settle(5000);
    const done = k.deps.tasks.require(t.id);
    expect(done.meta.errorFamily).toBe('quota');
    expect(Date.parse(String(done.meta.retryAfter))).toBeGreaterThan(Date.now());
  });

  it('a request that cannot fit fails as config before anything is sent to GenBot', async () => {
    const k = await setup('lean', 'ok');
    const build = k.deps.context.build;
    k.deps.context = { build: (input) => ({ ...build(input), overBudget: 'Việc này cần 25.000 ký tự nhưng runtime chỉ nhận tối đa 20.000 ký tự' }) };
    const t = k.deps.tasks.create({ agentId: 'bot-cskh', prompt: 'x', source: 'module:care', trigger: 'module', contextProfile: 'lean' });
    await k.settle(5000);
    expect(k.deps.tasks.require(t.id)).toMatchObject({ status: 'failed', meta: { errorFamily: 'config' } });
    expect(k.deps.tasks.require(t.id).error).toContain('20.000');
    expect(fake!.requests).toHaveLength(0);
    expect(k.deps.runs.list({ taskId: t.id })).toHaveLength(0);
  });
});
