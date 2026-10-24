import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateCore, openDb } from '../core/db.js';
import { createEventBus } from '../core/events.js';
import { createLogger } from '../core/log.js';
import type { Task } from '../core/types.js';
import { recoverOnBoot } from './recovery.js';
import { createDispatcher } from './dispatcher.js';
import { createTaskService } from './tasks.js';
import { agent, makeKit, type Kit } from './test-kit.js';

let kit: Kit;
afterEach(async () => {
  await kit?.deps.dispatcher.stop();
});
const start = (k: Kit) => {
  kit = k;
  k.deps.dispatcher.start();
  return k;
};
const run = async (k: Kit, t: Task) => {
  await k.settle();
  return k.deps.tasks.require(t.id);
};

describe('engine basics', () => {
  it('runs a task end to end and records run, board, audit-free output', async () => {
    const k = start(makeKit([agent('main')]));
    k.script.current = () => ({ ok: true, output: 'xin chào', sessionId: 's1', model: 'm', usage: { inputTokens: 3, costUsd: 0.1 } });
    const t = await run(k, k.deps.tasks.create({ prompt: 'chào' }));
    expect(t).toMatchObject({ status: 'done', result: 'xin chào' });
    const runs = k.deps.runs.list({ taskId: t.id });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'done', model: 'm', inputTokens: 3, outputTokens: null, runtime: 'mock' });
    expect(JSON.parse(runs[0]!.skillsJson!)).toEqual(['s1']);
    expect(k.board.at(-1)!.text).toBe('xin chào');
  });

  it('missing / disabled agent fails with config family; hooks still fire', async () => {
    const k = start(makeKit([agent('main'), agent('off', { enabled: false })]));
    const seen: number[] = [];
    k.deps.hooks.taskFinished.add((t) => void seen.push(t.id));
    const t = k.deps.tasks.create({ prompt: 'x' });
    k.agentMap.delete('main');
    await k.settle();
    expect(k.deps.tasks.require(t.id)).toMatchObject({ status: 'failed' });
    expect(k.deps.tasks.require(t.id).meta.errorFamily).toBe('config');
    expect(seen).toEqual([t.id]);
    expect(k.deps.attention.list().some((i) => i.taskId === t.id)).toBe(true);
  });

  it('budget exceeded fails the task and raises attention without calling the runtime', async () => {
    const k = start(makeKit([agent('main', { budgetUsdMonth: 1 })]));
    const seed = k.deps.tasks.create({ prompt: 'seed' });
    await run(k, seed);
    const r = k.deps.runs.start({ taskId: seed.id, agentId: 'main', runtime: 'mock', trigger: 'assigned' });
    k.deps.runs.finish(r.id, { status: 'done', usage: { costUsd: 5 } });
    const before = k.requests.length;
    const t = await run(k, k.deps.tasks.create({ prompt: 'again' }));
    expect(t.status).toBe('failed');
    expect(t.meta.errorFamily).toBe('budget');
    expect(k.requests.length).toBe(before);
    expect(k.deps.attention.list().some((i) => i.kind === 'budget')).toBe(true);
  });

  it('runtime failure maps family to Vietnamese error + attention for auth', async () => {
    const k = start(makeKit([agent('main')]));
    k.script.current = () => ({ ok: false, output: '', error: { family: 'auth', message: 'not logged in' } });
    const t = await run(k, k.deps.tasks.create({ prompt: 'x' }));
    expect(t.status).toBe('failed');
    expect(t.error).toMatch(/đăng nhập/);
    expect(k.deps.runs.list({ taskId: t.id })[0]).toMatchObject({ status: 'failed', errorFamily: 'auth' });
    expect(k.deps.attention.list().some((i) => i.taskId === t.id && i.kind === 'failed')).toBe(true);
  });

  it('transient failure has no raised attention but still shows as derived failed', async () => {
    const k = start(makeKit([agent('main')]));
    k.script.current = () => ({ ok: false, output: '', error: { family: 'transient', message: 'x' } });
    const t = await run(k, k.deps.tasks.create({ prompt: 'x' }));
    expect(k.deps.attention.list().find((i) => i.key === `task:${t.id}`)?.kind).toBe('failed');
  });

  it('cancelling a running task aborts the runtime', async () => {
    const k = start(makeKit([agent('main')]));
    let aborted = false;
    k.script.current = (req) =>
      new Promise((resolve) => {
        req.signal.addEventListener('abort', () => {
          aborted = true;
          resolve({ ok: false, output: '', error: { family: 'cancelled', message: 'abort' } });
        });
      });
    const t = k.deps.tasks.create({ prompt: 'long' });
    for (let i = 0; i < 100 && k.requests.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(k.deps.tasks.require(t.id).status).toBe('running');
    k.deps.tasks.cancel(t.id);
    await k.settle();
    expect(aborted).toBe(true);
    expect(k.deps.tasks.require(t.id).status).toBe('cancelled');
    expect(k.deps.runs.list({ taskId: t.id })[0]!.status).toBe('cancelled');
  });

  it('links skills only for claude/grok runtimes', async () => {
    const k = start(makeKit([agent('c', { runtime: 'claude' }), agent('m')]));
    await run(k, k.deps.tasks.create({ prompt: 'a', agentId: 'm' }));
    expect(k.calls.linked).toEqual([]);
    await run(k, k.deps.tasks.create({ prompt: 'a', agentId: 'c' }));
    expect(k.calls.linked).toHaveLength(1);
  });

  it('a throwing hook never breaks the engine', async () => {
    const k = start(makeKit([agent('main')]));
    const calls: string[] = [];
    k.deps.hooks.taskFinished.add(() => { throw new Error('boom'); });
    k.deps.hooks.taskFinished.add(async () => { calls.push('second'); });
    const t = await run(k, k.deps.tasks.create({ prompt: 'x' }));
    expect(t.status).toBe('done');
    expect(calls).toEqual(['second']);
  });

  it('module source: moduleContext provider + meta.moduleContext + lean ignores task directives', async () => {
    const k = start(makeKit([agent('main', { canDelegate: true, context: 'lean' }), agent('dev')]));
    const finished: string[] = [];
    k.deps.hooks.moduleContext.set('care', (t) => `hồ sơ khách #${t.id}`);
    k.deps.hooks.taskFinished.add((t) => void finished.push(t.source));
    k.script.current = () => ({ ok: true, output: 'Trả lời.<aios-task to="dev">x</aios-task><aios-memory>m</aios-memory><aios-status>review</aios-status>' });
    const t = await run(k, k.deps.tasks.create({ prompt: 'khách hỏi', source: 'module:care', trigger: 'module', meta: { moduleContext: 'đoạn chat', images: ['/a.png'] } }));
    expect(k.calls.contexts[0]!.moduleContext).toBe(`hồ sơ khách #${t.id}\n\nđoạn chat`);
    expect(k.requests[0]!.images).toEqual(['/a.png']);
    expect(t).toMatchObject({ status: 'review', result: 'Trả lời.' });
    expect(k.deps.tasks.children(t.id)).toHaveLength(0);
    expect(k.memories).toHaveLength(0);
    expect(finished).toEqual(['module:care']);
  });
});

describe('delegation and teams', () => {
  it('delegate → waiting → children done → parent re-run summarises', async () => {
    const k = start(makeKit([agent('boss', { canDelegate: true }), agent('dev')]));
    k.script.current = (req) => {
      if (req.agent.id === 'dev') return { ok: true, output: 'đã làm xong' };
      if (req.prompt.includes('child dev')) return { ok: true, output: 'Tổng hợp: ' + req.prompt.split('child dev: ')[1]!.split('\n')[0] };
      return { ok: true, output: 'Giao nhé<aios-task to="dev" title="Việc A">làm A</aios-task><aios-memory scope="team">ghi nhớ</aios-memory>' };
    };
    const p = k.deps.tasks.create({ prompt: 'dự án', agentId: 'boss' });
    const waitingSeen = new Promise<void>((res) => k.deps.bus.on('task', (e) => e.task.id === p.id && e.task.status === 'waiting' && res()));
    await waitingSeen;
    await k.settle();
    const final = k.deps.tasks.require(p.id);
    expect(final).toMatchObject({ status: 'done', result: 'Tổng hợp: đã làm xong' });
    expect(final.meta.round).toBe(1);
    const kids = k.deps.tasks.children(p.id);
    expect(kids).toHaveLength(1);
    expect(kids[0]).toMatchObject({ title: 'Việc A', depth: 1, source: 'agent:boss', status: 'done' });
    expect(k.memories[0]).toMatchObject({ agentId: null, source: 'agent:boss', content: 'ghi nhớ' });
    expect(k.deps.runs.list({ taskId: p.id })).toHaveLength(2);
  });

  it('wait=false child does not make the parent wait', async () => {
    const k = start(makeKit([agent('boss', { canDelegate: true }), agent('dev')]));
    k.script.current = (req) => (req.agent.id === 'boss' ? { ok: true, output: 'ok<aios-task to="dev" wait="false">x</aios-task>' } : { ok: true, output: 'd' });
    const p = await run(k, k.deps.tasks.create({ prompt: 'p', agentId: 'boss' }));
    expect(p.status).toBe('done');
    expect(k.deps.tasks.children(p.id)).toHaveLength(1);
  });

  it('rejected directives are written to board', async () => {
    const k = start(makeKit([agent('boss', { canDelegate: true })]));
    k.script.current = () => ({ ok: true, output: 'a<aios-task to="ghost">x</aios-task>' });
    const p = await run(k, k.deps.tasks.create({ prompt: 'p', agentId: 'boss' }));
    expect(p.status).toBe('done');
    expect(k.board.some((b) => b.kind === 'directive' && /ghost/.test(b.text))).toBe(true);
  });

  it('review → comment → re-run', async () => {
    const k = start(makeKit([agent('main')]));
    k.script.current = (req) => (req.prompt.includes('comment: sửa lại') ? { ok: true, output: 'bản sửa' } : { ok: true, output: 'nháp<aios-status>review</aios-status>' });
    const t = await run(k, k.deps.tasks.create({ prompt: 'viết' }));
    expect(t).toMatchObject({ status: 'review', result: 'nháp' });
    k.deps.comments.add(t.id, 'user', 'sửa lại');
    const t2 = await run(k, t);
    expect(t2).toMatchObject({ status: 'done', result: 'bản sửa' });
    expect(k.prompts.at(-1)).toContain('[trigger:commented]');
  });

  it('parallel team without mergeBy concatenates results', async () => {
    const k = start(makeKit([agent('a'), agent('b')], { config: { maxParallel: 5 } }));
    k.script.current = (req) => ({ ok: true, output: `kq-${req.agent.id}` });
    const p = k.deps.team.createTeamTask({ prompt: 'hỏi', agentIds: ['a', 'b'], mode: 'parallel' });
    expect(p).toMatchObject({ kind: 'team', status: 'waiting' });
    const f = await run(k, p);
    await k.settle();
    const final = k.deps.tasks.require(p.id);
    expect(final.status).toBe('done');
    expect(final.result).toBe('### a\nkq-a\n\n### b\nkq-b');
  });

  it('parallel team with mergeBy re-runs the parent with childResults', async () => {
    const k = start(makeKit([agent('a'), agent('b'), agent('m')], { config: { maxParallel: 5 } }));
    k.script.current = (req) => (req.agent.id === 'm' ? { ok: true, output: 'gộp:' + (req.prompt.match(/child \w+/g) ?? []).join(',') } : { ok: true, output: `kq-${req.agent.id}` });
    const p = k.deps.team.createTeamTask({ prompt: 'hỏi', agentIds: ['a', 'b'], mode: 'parallel', mergeBy: 'm' });
    expect(p.agentId).toBe('m');
    await k.settle();
    const final = k.deps.tasks.require(p.id);
    expect(final).toMatchObject({ status: 'done', result: 'gộp:child a,child b' });
    expect(k.calls.contexts.at(-1)!.childResults).toHaveLength(2);
  });

  it('relay passes results along and finishes with the last', async () => {
    const k = start(makeKit([agent('a'), agent('b'), agent('c')]));
    k.script.current = (req) => ({ ok: true, output: `${req.agent.id}(${req.prompt.includes('Kết quả bước trước') ? 'chain' : 'first'})` });
    const p = k.deps.team.createTeamTask({ prompt: 'đề', agentIds: ['a', 'b', 'c'], mode: 'relay' });
    await k.settle();
    const final = k.deps.tasks.require(p.id);
    expect(final).toMatchObject({ status: 'done', result: 'c(chain)' });
    expect(k.prompts[1]).toContain('## Kết quả bước trước (a)\na(first)');
    expect(k.deps.tasks.children(p.id)).toHaveLength(3);
  });

  it('a failed relay step fails the parent', async () => {
    const k = start(makeKit([agent('a'), agent('b')]));
    k.script.current = (req) => (req.agent.id === 'b' ? { ok: false, output: '', error: { family: 'transient', message: 'x' } } : { ok: true, output: 'ok' });
    const p = k.deps.team.createTeamTask({ prompt: 'đề', agentIds: ['a', 'b'], mode: 'relay' });
    await k.settle();
    const final = k.deps.tasks.require(p.id);
    expect(final.status).toBe('failed');
    expect(final.error).toMatch(/Bước 2 \(b\)/);
  });

  it('team input validation', () => {
    const k = makeKit([agent('a')]);
    expect(() => k.deps.team.createTeamTask({ prompt: 'x', agentIds: [], mode: 'parallel' })).toThrow();
    expect(() => k.deps.team.createTeamTask({ prompt: 'x', agentIds: ['ghost'], mode: 'parallel' })).toThrow(/Không tìm thấy/);
  });
});

describe('dispatcher', () => {
  it('emergency stop prevents claims, resume claims', async () => {
    const k = start(makeKit([agent('main')]));
    k.db.prepare("INSERT INTO kv (key, value) VALUES ('emergency_stop', '1')").run();
    const t = k.deps.tasks.create({ prompt: 'x' });
    await new Promise((r) => setTimeout(r, 250));
    expect(k.deps.tasks.require(t.id).status).toBe('queued');
    k.db.prepare("UPDATE kv SET value = '0' WHERE key = 'emergency_stop'").run();
    await k.settle();
    expect(k.deps.tasks.require(t.id).status).toBe('done');
  });

  it('respects per-agent max_concurrent and priority', async () => {
    const k = makeKit([agent('main', { maxConcurrent: 1 })], { config: { maxParallel: 5 } });
    let active = 0;
    let peak = 0;
    const order: string[] = [];
    k.script.current = async (req) => {
      active++;
      peak = Math.max(peak, active);
      order.push(req.prompt.split('\n')[1]!);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return { ok: true, output: 'ok' };
    };
    k.deps.tasks.create({ prompt: 'low' });
    k.deps.tasks.create({ prompt: 'high', priority: 9 });
    k.deps.tasks.create({ prompt: 'low2' });
    start(k);
    await k.settle();
    expect(peak).toBe(1);
    expect(order[0]).toBe('high');
  });

  it('global maxParallel caps concurrency across agents', async () => {
    const k = makeKit([agent('a'), agent('b'), agent('c')], { config: { maxParallel: 2 } });
    let active = 0;
    let peak = 0;
    k.script.current = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
      return { ok: true, output: 'ok' };
    };
    for (const id of ['a', 'b', 'c']) k.deps.tasks.create({ prompt: id, agentId: id });
    start(k);
    await k.settle();
    expect(peak).toBe(2);
  });

  it('two dispatchers on the same DB never claim the same task', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-disp-'));
    const file = path.join(dir, 'x.db');
    const mk = () => {
      const db = openDb(file);
      migrateCore(db);
      const bus = createEventBus();
      const log = createLogger({ level: 'silent' });
      const agents = { list: () => [agent('main', { maxConcurrent: 50 })], get: (id: string) => (id === 'main' ? agent('main', { maxConcurrent: 50 }) : undefined) } as never;
      const tasks = createTaskService({ db, bus, agents });
      const claimed: number[] = [];
      const engine = {
        async execute(t: Task) {
          claimed.push(t.id);
          await new Promise((r) => setTimeout(r, 5));
          tasks.update(t.id, { status: 'done' });
        },
      };
      const disp = createDispatcher({ db, config: { maxParallel: 100, dispatcherPollMs: 100 }, agents, tasks, engine, log, bus });
      return { db, tasks, claimed, disp };
    };
    const a = mk();
    const b = mk();
    for (let i = 0; i < 60; i++) a.tasks.create({ prompt: `t${i}` });
    a.disp.start();
    b.disp.start();
    for (let i = 0; i < 200 && a.tasks.counts().done < 60; i++) await new Promise((r) => setTimeout(r, 20));
    await a.disp.stop();
    await b.disp.stop();
    const all = [...a.claimed, ...b.claimed];
    expect(all).toHaveLength(60);
    expect(new Set(all).size).toBe(60);
    a.db.close();
    b.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stop waits for running executions', async () => {
    const k = start(makeKit([agent('main')]));
    let finished = false;
    k.script.current = async () => {
      await new Promise((r) => setTimeout(r, 100));
      finished = true;
      return { ok: true, output: 'ok' };
    };
    k.deps.tasks.create({ prompt: 'x' });
    for (let i = 0; i < 100 && k.deps.dispatcher.runningTaskIds().length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    await k.deps.dispatcher.stop();
    expect(finished).toBe(true);
  });
});

describe('chat', () => {
  it('stores messages, auto-titles, inlines history when not resuming, reuses session when resuming', async () => {
    const k = start(makeKit([agent('main')]));
    const conv = k.deps.chat.create({ agentId: 'main' });
    k.script.current = (req) => ({ ok: true, output: `trả lời ${req.sessionId ?? 'no-session'}`, sessionId: 'sess-1' });
    const s1 = k.deps.chat.send(conv.id, 'Xin chào bạn\nhai dòng');
    expect(s1.task).toMatchObject({ kind: 'chat', priority: 10, trigger: 'chat', conversationId: conv.id });
    await k.settle();
    const c1 = k.deps.chat.get(conv.id)!;
    expect(c1.conversation).toMatchObject({ title: 'Xin chào bạn', sessionId: 'sess-1', sessionRuntime: 'mock' });
    expect(c1.messages.map((m) => m.role)).toEqual(['user', 'agent']);
    expect(c1.messages[1]!.content).toBe('trả lời no-session');
    // second turn resumes → no history inlined, sessionId passed
    k.deps.chat.send(conv.id, 'tiếp');
    await k.settle();
    expect(k.requests[1]!.sessionId).toBe('sess-1');
    expect(k.calls.contexts[1]!.resuming).toBe(true);
    expect(k.calls.contexts[1]!.history).toBeUndefined();
    expect(k.deps.chat.get(conv.id)!.messages.at(-1)!.content).toBe('trả lời sess-1');
  });

  it('inlines history when the runtime cannot resume; clearSession drops the session', async () => {
    const k = start(makeKit([agent('main')], { runtimeCaps: { resume: false } }));
    const conv = k.deps.chat.create({ agentId: 'main' });
    k.script.current = () => ({ ok: true, output: 'ok', sessionId: 'sx' });
    k.deps.chat.send(conv.id, 'một');
    await k.settle();
    k.deps.chat.send(conv.id, 'hai');
    await k.settle();
    expect(k.requests[1]!.sessionId).toBeUndefined();
    expect(k.calls.contexts[1]!.resuming).toBe(false);
    expect(k.calls.contexts[1]!.history!.map((m) => m.content)).toEqual(['một', 'ok']);
    expect(k.deps.chat.get(conv.id)!.conversation.sessionId).toBeNull();
  });

  it('failed chat turn leaves a system message; clearSession clears stored session', async () => {
    const k = start(makeKit([agent('main')]));
    const conv = k.deps.chat.create({ agentId: 'main' });
    k.script.current = () => ({ ok: true, output: 'ok', sessionId: 's1' });
    k.deps.chat.send(conv.id, 'a');
    await k.settle();
    k.script.current = () => ({ ok: false, output: '', clearSession: true, error: { family: 'transient', message: 'hết phiên' } });
    k.deps.chat.send(conv.id, 'b');
    await k.settle();
    const c = k.deps.chat.get(conv.id)!;
    expect(c.messages.at(-1)).toMatchObject({ role: 'system' });
    expect(c.conversation.sessionId).toBeNull();
  });

  it('rename / remove / list', () => {
    const k = makeKit([agent('main')]);
    const c = k.deps.chat.create({ agentId: 'main', title: 'A' });
    expect(k.deps.chat.rename(c.id, 'B').title).toBe('B');
    expect(k.deps.chat.listConversations({ agentId: 'main' })).toHaveLength(1);
    k.deps.chat.remove(c.id);
    expect(k.deps.chat.get(c.id)).toBeUndefined();
    expect(() => k.deps.chat.send(999, 'x')).toThrow(/Không tìm thấy/);
  });
});

describe('boot recovery', () => {
  it('re-queues a running task once, then fails it with attention', () => {
    const k = makeKit([agent('main')]);
    const t = k.deps.tasks.create({ prompt: 'x' });
    k.deps.tasks.update(t.id, { status: 'running' });
    const r = k.deps.runs.start({ taskId: t.id, agentId: 'main', runtime: 'mock', trigger: 'assigned' });
    const res1 = recoverOnBoot(k.deps);
    expect(res1).toEqual({ requeued: 1, failed: 0 });
    expect(k.deps.tasks.require(t.id)).toMatchObject({ status: 'queued', recoverCount: 1 });
    expect(k.deps.runs.get(r.id)).toMatchObject({ status: 'failed', error: 'Bị ngắt khi khởi động lại' });
    k.deps.tasks.update(t.id, { status: 'running' });
    expect(recoverOnBoot(k.deps)).toEqual({ requeued: 0, failed: 1 });
    expect(k.deps.tasks.require(t.id).status).toBe('failed');
    expect(k.deps.attention.list().some((i) => i.taskId === t.id)).toBe(true);
  });
});
