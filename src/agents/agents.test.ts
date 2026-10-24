import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgentRegistry } from './registry.js';
import { AgentValidationError, parseAgentConfig } from './schema.js';
import { REPO_ROOT, tempRegistry, tmpDir, writeFile } from '../shared/test-kit.js';

const ctx = (id = 'tester') => ({ id, dir: `/r/agents/${id}`, repoRoot: '/r', workspacesDir: '/r/workspaces' });

describe('agent schema', () => {
  it('applies safe defaults and default deny', () => {
    const a = parseAgentConfig({ name: 'A', runtime: 'mock' }, ctx());
    expect(a).toMatchObject({ permission: 'safe', context: 'standard', canDelegate: false, maxConcurrent: 1, enabled: true, description: '' });
    expect(a.access).toEqual({ brain: {}, memory: { team: false, private: true }, skills: [], connections: {}, modules: {} });
    expect(a.workspace).toBe('/r/workspaces/tester');
  });

  it('maps snake_case yaml to camelCase and resolves relative workspace against repo root', () => {
    const a = parseAgentConfig(
      { name: 'A', runtime: 'claude', runtime_options: { profile: 'x' }, reports_to: 'main', can_delegate: true, max_concurrent: 3, budget_usd_month: 12, workspace: 'work/a', access: { brain: { x: { read: '**' } }, skills: 'all', connections: { gh: ['search_*'], k: true } } },
      ctx(),
    );
    expect(a).toMatchObject({ reportsTo: 'main', canDelegate: true, maxConcurrent: 3, budgetUsdMonth: 12, workspace: '/r/work/a', runtimeOptions: { profile: 'x' } });
    expect(a.access.brain.x).toEqual({ read: ['**'], write: [] });
    expect(a.access.skills).toBe('all');
    expect(a.access.connections).toEqual({ gh: ['search_*'], k: true });
  });

  it('falls back to description when persona is empty', () => {
    expect(parseAgentConfig({ name: 'A', runtime: 'mock', description: 'mô tả' }, { ...ctx(), persona: '  ' }).persona).toBe('mô tả');
    expect(parseAgentConfig({ name: 'A', runtime: 'mock' }, { ...ctx(), persona: 'Xin chào' }).persona).toBe('Xin chào');
  });

  it('reports Vietnamese errors', () => {
    const run = (raw: unknown, id = 'tester') => {
      try {
        parseAgentConfig(raw, ctx(id));
      } catch (e) {
        expect(e).toBeInstanceOf(AgentValidationError);
        return (e as AgentValidationError).message;
      }
      throw new Error('should fail');
    };
    expect(run({ runtime: 'mock' })).toContain('name: thiếu giá trị bắt buộc');
    expect(run({ name: 'A', runtime: 'gpt' })).toContain('runtime: giá trị phải là một trong');
    expect(run({ name: 'A', runtime: 'mock', permision: 'full' })).toContain('khoá không hợp lệ (permision)');
    expect(run({ name: 'A', runtime: 'mock', max_concurrent: 'nhiều' })).toContain('max_concurrent: sai kiểu dữ liệu');
    expect(run({ name: 'A', runtime: 'mock' }, 'Bad Id')).toContain('không hợp lệ');
    expect(run(null)).toContain('mapping');
  });
});

describe('agent registry', () => {
  it('loads the five sample agents', () => {
    const reg = createAgentRegistry({ agentsDir: path.join(REPO_ROOT, 'agents'), workspacesDir: path.join(REPO_ROOT, 'workspaces') });
    expect(reg.errors()).toEqual([]);
    // samples must exist; learners may add their own agents next to them
    expect(reg.list().map((a) => a.id)).toEqual(expect.arrayContaining(['assistant', 'coder', 'demo', 'main', 'researcher']));
    const main = reg.require('main');
    expect(main).toMatchObject({ runtime: 'claude', canDelegate: true, access: { skills: 'all', memory: { team: true, private: true } } });
    expect(Object.keys(main.access.brain)).toEqual(['ca-nhan', 'cong-ty-a', 'cong-ty-b']);
    expect(main.persona).toContain('Trợ lý chính');
    expect(reg.require('assistant').runtimeOptions).toEqual({ profile: 'default' });
    expect(reg.require('coder').access.skills).toEqual(['review-code']);
  });

  it('keeps invalid agents in errors() and skips _ and dot folders', () => {
    const t = tempRegistry();
    writeFile(path.join(t.agentsDir, 'good-one', 'agent.yaml'), 'name: G\nruntime: mock\n');
    writeFile(path.join(t.agentsDir, 'bad-one', 'agent.yaml'), 'name: B\nruntime: nope\n');
    writeFile(path.join(t.agentsDir, 'broken', 'agent.yaml'), 'name: [unclosed');
    fs.mkdirSync(path.join(t.agentsDir, 'no-yaml'));
    writeFile(path.join(t.agentsDir, '_hidden', 'agent.yaml'), 'name: H\nruntime: mock\n');
    const reg = t.registry();
    expect(reg.list().map((a) => a.id)).toEqual(['good-one']);
    expect(reg.errors().map((e) => e.id).sort()).toEqual(['bad-one', 'broken', 'no-yaml']);
    expect(reg.errors().find((e) => e.id === 'bad-one')!.message).toContain('runtime');
  });

  it('creates, updates and round-trips through yaml', () => {
    const t = tempRegistry();
    const reg = t.registry();
    const a = reg.create('sales-a', { name: 'Sale A', runtime: 'claude', description: 'Trả lời khách', persona: 'Bạn là sale.', context: 'lean', access: { brain: { 'cong-ty-a': { read: ['**'], write: [] } }, memory: { team: true, private: true }, skills: ['x'], connections: {}, modules: { care: ['inbox.read'] } } });
    expect(a.context).toBe('lean');
    expect(fs.existsSync(path.join(t.workspacesDir, 'sales-a'))).toBe(true);
    const yamlText = fs.readFileSync(path.join(t.agentsDir, 'sales-a', 'agent.yaml'), 'utf8');
    expect(yamlText.indexOf('name:')).toBeLessThan(yamlText.indexOf('runtime:'));
    expect(yamlText).not.toContain('workspace:');
    expect(() => reg.create('sales-a', { name: 'x', runtime: 'mock' })).toThrow('đã tồn tại');
    expect(() => reg.create('Bad Id', { name: 'x', runtime: 'mock' })).toThrow('không hợp lệ');

    const u = reg.update('sales-a', { enabled: false, persona: 'Persona mới', budgetUsdMonth: 30 });
    expect(u).toMatchObject({ enabled: false, persona: 'Persona mới', budgetUsdMonth: 30, context: 'lean' });
    const again = t.registry();
    expect(again.require('sales-a')).toEqual(u);
    expect(() => reg.update('sales-a', { runtime: 'nope' as never })).toThrow(AgentValidationError);
    expect(reg.require('sales-a').runtime).toBe('claude');
    expect(() => reg.require('ghost')).toThrow('Không tìm thấy');
  });

  it('archives to agents/_archive/<id>-<timestamp>', () => {
    const t = tempRegistry();
    const reg = t.registry();
    reg.create('old-one', { name: 'Old', runtime: 'mock' });
    reg.archive('old-one');
    expect(reg.get('old-one')).toBeUndefined();
    const archived = fs.readdirSync(path.join(t.agentsDir, '_archive'));
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatch(/^old-one-\d{14}$/);
    expect(t.registry().list()).toEqual([]);
  });

  it('installs a template and fails if the target exists', () => {
    const t = tempRegistry();
    const reg = t.registry();
    const tpl = path.join(tmpDir(), 'zalo-care');
    writeFile(path.join(tpl, 'agent.yaml'), 'name: Zalo care\nruntime: mock\ncontext: lean\n');
    writeFile(path.join(tpl, 'persona.md'), 'Chăm khách.');
    const a = reg.installTemplate(tpl);
    expect(a).toMatchObject({ id: 'zalo-care', context: 'lean', persona: 'Chăm khách.' });
    expect(() => reg.installTemplate(tpl)).toThrow('đã tồn tại');
    expect(reg.installTemplate(tpl, 'zalo-care-2').id).toBe('zalo-care-2');
    const bad = path.join(tmpDir(), 'bad-tpl');
    writeFile(path.join(bad, 'agent.yaml'), 'name: B\nruntime: nope\n');
    expect(() => reg.installTemplate(bad)).toThrow();
    expect(fs.existsSync(path.join(t.agentsDir, 'bad-tpl'))).toBe(false);
  });

  it('creates workspace dirs on demand', () => {
    const t = tempRegistry();
    writeFile(path.join(t.agentsDir, 'solo-agent', 'agent.yaml'), 'name: S\nruntime: mock\n');
    const reg = t.registry();
    expect(fs.existsSync(path.join(t.workspacesDir, 'solo-agent'))).toBe(false);
    expect(reg.ensureWorkspace('solo-agent')).toBe(path.join(t.workspacesDir, 'solo-agent'));
    expect(fs.existsSync(path.join(t.workspacesDir, 'solo-agent'))).toBe(true);
  });
});
