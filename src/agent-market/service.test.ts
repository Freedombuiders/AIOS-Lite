import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../agents/registry.js';
import { createMarketService, MarketError } from './service.js';

let root: string;
const mk = () => {
  const agents = createAgentRegistry({ agentsDir: path.join(root, 'agents'), workspacesDir: path.join(root, 'ws') });
  const svc = createMarketService({ config: { rootDir: root, skillsDirs: [path.join(root, 'skills')] }, agents });
  return { agents, svc };
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-market-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('agent market', () => {
  it('lists the catalog', () => {
    const { svc } = mk();
    const ids = svc.templates().map((t) => t.id);
    expect(ids).toContain('education-advisor');
    expect(ids).toContain('research-analyst');
  });

  it('previews exactly the files it later writes, with the chosen runtime', () => {
    const { svc, agents } = mk();
    const fields = { businessName: 'Trung tâm A', courses: 'Khóa 1', registration: 'link' };
    const p = svc.preview('education-advisor', { runtime: 'codex', fields });
    expect(p.runtime).toBe('codex');
    expect(p.missingRequired).toEqual([]);
    expect(p.newSkills.length).toBe(4);
    const res = svc.install('education-advisor', { runtime: 'codex', fields });
    expect(res.files.sort()).toEqual(p.files.map((f) => f.path).sort());
    const fresh = createAgentRegistry({ agentsDir: path.join(root, 'agents'), workspacesDir: path.join(root, 'ws2') });
    expect(fresh.errors()).toEqual([]);
    const a = fresh.require(res.agent.id);
    expect(a.runtime).toBe('codex');
    expect(a.permission).toBe('safe');
    expect(a.access.connections).toEqual({});
    expect(fs.readFileSync(path.join(a.dir, 'knowledge', 'customer-care.md'), 'utf8')).toContain('Khóa 1');
    expect(fs.existsSync(path.join(root, 'skills', 'course-advising', 'SKILL.md'))).toBe(true);
    expect(agents.get(res.agent.id)).toBeTruthy();
  });

  it('refuses missing required fields and an id that is taken', () => {
    const { svc } = mk();
    expect(() => svc.install('education-advisor', {})).toThrow(MarketError);
    svc.install('research-analyst', { id: 'nghien-cuu', fields: { business: 'x' } });
    expect(() => svc.preview('research-analyst', { id: 'nghien-cuu', fields: { business: 'x' } })).toThrow(/đã tồn tại/);
    const second = svc.install('research-analyst', { fields: { business: 'x' } });
    const third = svc.install('research-analyst', { fields: { business: 'x' } });
    expect(second.agent.id).toBe('research-analyst');
    expect(third.agent.id).toBe('research-analyst-2');
  });
});
