import { afterEach, describe, expect, it } from 'vitest';
import type { Task } from '../core/types.js';
import { parseDirectives, validateDirectives } from './directives.js';
import { agent, makeKit, type Kit } from './test-kit.js';

let kit: Kit;
afterEach(async () => {
  await kit?.deps.dispatcher.stop();
});

describe('module action directives', () => {
  it('parses JSON payloads (also inside a code fence) and rejects bad JSON', () => {
    const p = parseDirectives(
      'Xong.\n<aios-action module="marketing" name="content.add">{"caption":"Chào"}</aios-action>\n<aios-action module="marketing" name="x">```json\n{"a":1}\n```</aios-action>\n<aios-action module="m" name="y">{bad</aios-action>',
    );
    expect(p.directives).toEqual([
      { kind: 'action', module: 'marketing', name: 'content.add', payload: { caption: 'Chào' } },
      { kind: 'action', module: 'marketing', name: 'x', payload: { a: 1 } },
    ]);
    expect(p.malformed).toHaveLength(1);
    expect(p.cleanOutput).toBe('Xong.');
  });

  it('requires a registered action and the module scope', () => {
    const ds = parseDirectives('<aios-action module="m" name="a">{}</aios-action><aios-action module="m" name="nope">{}</aios-action>').directives;
    const base = { agent: agent('main'), task: { depth: 0, meta: {} } as unknown as Task, agents: { get: () => undefined }, config: { maxDelegationDepth: 3, maxChildrenPerRun: 5, maxSummaryRounds: 3 }, teamMemory: false };
    const denied = validateDirectives(ds, { ...base, actionScope: (_m, n) => (n === 'a' ? 'content.write' : undefined), canModule: () => false });
    expect(denied.accepted).toHaveLength(0);
    expect(denied.rejected.map((r) => r.reason)).toEqual([expect.stringContaining('chưa được cấp quyền'), expect.stringContaining('Không có hành động')]);
    const ok = validateDirectives(ds, { ...base, actionScope: (_m, n) => (n === 'a' ? 'content.write' : undefined), canModule: () => true });
    expect(ok.accepted).toHaveLength(1);
  });

  it('engine runs a granted action and records the result as a task comment', async () => {
    kit = makeKit([agent('main')]);
    const calls: unknown[] = [];
    kit.deps.hooks.moduleActions = new Map([
      ['mkt:content.add', { moduleId: 'mkt', name: 'content.add', scope: 'content.write', description: 'Thêm nội dung', run: (payload: unknown) => { calls.push(payload); return { id: 7 }; } }],
    ]);
    const resolve = kit.deps.access.resolve.bind(kit.deps.access);
    kit.deps.access.resolve = (a, t) => ({ ...resolve(a, t), moduleScopes: { mkt: ['content.write'] } });
    kit.script.current = () => ({ ok: true, output: 'Đã soạn.\n<aios-action module="mkt" name="content.add">{"caption":"Bài mới"}</aios-action>' });
    kit.deps.dispatcher.start();
    const t = kit.deps.tasks.create({ prompt: 'soạn bài' });
    await kit.settle();
    expect(kit.deps.tasks.require(t.id)).toMatchObject({ status: 'done', result: 'Đã soạn.' });
    expect(calls).toEqual([{ caption: 'Bài mới' }]);
    expect(kit.deps.comments.list(t.id).map((c) => c.body)).toEqual([expect.stringContaining('mkt/content.add: thành công')]);
  });
});

describe('module agentContext', () => {
  it('adds module data to any run of an agent holding a scope of that module', async () => {
    kit = makeKit([agent('main')]);
    kit.deps.hooks.agentContext = new Map([['mkt', (_a, _t, scopes) => `Trang: Ninh Bình Home (${scopes.join(',')})`]]);
    const resolve = kit.deps.access.resolve.bind(kit.deps.access);
    kit.deps.access.resolve = (a, t) => ({ ...resolve(a, t), moduleScopes: { mkt: ['analytics.read'] } });
    const seen: string[] = [];
    kit.script.current = (req) => {
      seen.push(req.prompt);
      return { ok: true, output: 'ok' };
    };
    kit.deps.dispatcher.start();
    kit.deps.tasks.create({ prompt: 'báo cáo trang' });
    await kit.settle();
    expect(seen.join('\n')).toContain('Trang: Ninh Bình Home (analytics.read)');
  });
});
