import { describe, expect, it } from 'vitest';
import { migrateCore, openDb } from '../core/db.js';
import type { Skill, Task } from '../core/types.js';
import type { ModuleInfo } from '../modules/contracts.js';
import { agent } from '../work/test-kit.js';
import { computeRecos } from './rules.js';
import { createRecosService } from './service.js';

const now = new Date('2026-10-24T10:00:00Z');
const failed = (id: number, agentId: string, ago = 1): Task => ({ id, agentId, status: 'failed', error: 'timeout', updatedAt: new Date(now.getTime() - ago * 86_400_000).toISOString() }) as Task;
const skill = (id: string, source = 'library'): Skill => ({ id, name: id, description: '', path: `/s/${id}/SKILL.md`, dir: `/s/${id}`, source });
const mod = (id: string, enabled: boolean, ready = true): ModuleInfo => ({ manifest: { id, name: id, description: 'd', version: '1', category: 'ops' }, state: { id, enabled, version: '1', installedAt: null, settings: {} }, requirements: [], ready, hasServer: false, hasWeb: false, agentTemplates: [] }) as ModuleInfo;

const base = { agents: [agent('main'), agent('worker')], failedTasks: [], monthCost: () => 0, skills: [], brainFolders: [], modules: [], now };

describe('reco rules', () => {
  it('flags an agent with 2+ recent failed tasks, ignores old ones', () => {
    const r = computeRecos({ ...base, failedTasks: [failed(1, 'worker'), failed(2, 'worker'), failed(3, 'main', 1), failed(4, 'main', 20), failed(5, 'main', 30)] });
    expect(r.map((x) => x.id)).toEqual(['failed-tasks:worker']);
  });

  it('budget: warns at 80 percent, high priority when over', () => {
    const r = computeRecos({ ...base, agents: [agent('a', { budgetUsdMonth: 10 }), agent('b', { budgetUsdMonth: 10 }), agent('c', { budgetUsdMonth: 10 })], monthCost: (id) => ({ a: 8.5, b: 12, c: 3 })[id] ?? 0 });
    expect(r.map((x) => [x.id, x.priority])).toEqual([['budget:b', 1], ['budget:a', 2]]);
  });

  it('skills: only library skills no agent holds; silent when some agent has all', () => {
    const agents = [agent('main', { access: { brain: {}, memory: { team: true, private: true }, skills: ['used'], connections: {}, modules: {} } })];
    const r = computeRecos({ ...base, agents, skills: [skill('used'), skill('idle'), skill('m', 'module:care')] });
    expect(r.map((x) => x.id)).toEqual(['unused-skill:idle']);
    const all = computeRecos({ ...base, agents: [agent('x', { access: { brain: {}, memory: { team: true, private: true }, skills: 'all', connections: {}, modules: {} } })], skills: [skill('idle')] });
    expect(all).toEqual([]);
  });

  it('brain: folder nobody can read gets a read-only grant suggestion', () => {
    const granted = agent('worker', { access: { brain: { kb: { read: ['**'], write: [] } }, memory: { team: true, private: true }, skills: [], connections: {}, modules: {} } });
    const r = computeRecos({ ...base, agents: [agent('main'), granted], brainFolders: [{ id: 'kb', name: 'KB' }, { id: 'old', name: 'Cũ' }] });
    expect(r).toHaveLength(1);
    expect(r[0]!.action).toEqual({ kind: 'grant-brain', folderId: 'old', agentId: 'main' });
  });

  it('modules: only ready modules that are not added', () => {
    const r = computeRecos({ ...base, modules: [mod('care', false), mod('ads', true), mod('zalo', false, false)] });
    expect(r.map((x) => x.id)).toEqual(['module:care']);
  });
});

describe('reco service', () => {
  function make() {
    const db = openDb(':memory:');
    migrateCore(db);
    const created: unknown[] = [];
    const added: string[] = [];
    const agents = [agent('main'), agent('worker')];
    const updates: Array<[string, unknown]> = [];
    const svc = createRecosService({
      db,
      agents: { list: () => agents, get: (id: string) => agents.find((a) => a.id === id), update: (id: string, p: unknown) => { updates.push([id, p]); return agents[0]; } } as never,
      tasks: { list: () => [failed(1, 'worker'), failed(2, 'worker')], create: (i: unknown) => { created.push(i); return { id: 77 } as Task; } },
      runs: { monthCost: () => 0 },
      skills: { list: () => [] },
      brain: { folders: () => [{ id: 'kb', name: 'KB', path: '/kb' }] },
      modules: { discover: () => [mod('care', false)], add: async (id: string) => { added.push(id); return { module: mod(id, true), migrationsApplied: [], agentsInstalled: [] }; } },
    });
    return { svc, created, added, updates };
  }

  it('cart then apply runs real actions and records the result', async () => {
    const { svc, created, added, updates } = make();
    const open = svc.list();
    expect(open.items.map((i) => i.id).sort()).toEqual(['brain-ungranted:kb', 'failed-tasks:worker', 'module:care']);
    for (const i of open.items) svc.setStatus(i.id, 'cart');
    expect(svc.list().counts.cart).toBe(3);
    const res = await svc.applyCart();
    expect(res.results.every((r) => r.ok)).toBe(true);
    expect(created).toHaveLength(1);
    expect(added).toEqual(['care']);
    expect(updates[0]![0]).toBe('main');
    expect(svc.list().items).toEqual([]);
    expect(svc.list({ status: 'done' }).items).toHaveLength(3);
  });

  it('skip hides a suggestion and applying twice is refused', async () => {
    const { svc } = make();
    svc.setStatus('module:care', 'skipped');
    expect(svc.list().items.map((i) => i.id)).not.toContain('module:care');
    await svc.apply('failed-tasks:worker');
    await expect(svc.apply('failed-tasks:worker')).rejects.toThrow(/đã được áp dụng/);
    expect(() => svc.setStatus('nope', 'cart')).toThrow(/không còn/);
  });
});
