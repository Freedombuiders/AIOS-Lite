import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../agents/registry.js';
import { loadConfig } from '../core/config.js';
import { migrateCore, openDb } from '../core/db.js';
import type { Schedule, Skill } from '../core/types.js';
import type { SchedulerService } from '../work/contracts.js';
import { createTeamsService } from './service.js';

const REPO = path.resolve(__dirname, '..', '..');
let root: string;

function fakeScheduler(): SchedulerService & { rows: Schedule[] } {
  const rows: Schedule[] = [];
  let id = 0;
  return {
    rows,
    list: () => rows,
    get: (i) => rows.find((r) => r.id === i),
    create: (input) => {
      const s: Schedule = { id: ++id, name: input.name, agentId: input.agentId, cron: input.cron, timezone: input.timezone ?? 'UTC', prompt: input.prompt, enabled: input.enabled ?? true, lastRunAt: null, nextRunAt: null, lastTaskId: null, createdAt: '', updatedAt: '' };
      rows.push(s);
      return s;
    },
    update: () => { throw new Error('n/a'); },
    remove: (i) => { rows.splice(rows.findIndex((r) => r.id === i), 1); },
    runNow: () => { throw new Error('n/a'); },
    tick: () => [],
    start() {},
    stop() {},
  };
}

function setup(catalogDir = path.join(REPO, 'teams')) {
  const db = openDb(':memory:');
  migrateCore(db);
  const agentsDir = path.join(root, 'agents');
  const skillsDir = path.join(root, 'skills');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });
  const agents = createAgentRegistry({ agentsDir, workspacesDir: path.join(root, 'workspaces') });
  const scheduler = fakeScheduler();
  const skillMap = new Map<string, Skill>();
  const skills = {
    reload() {
      skillMap.clear();
      for (const d of fs.readdirSync(skillsDir)) skillMap.set(d, { id: d, name: d, description: '', path: path.join(skillsDir, d, 'SKILL.md'), dir: path.join(skillsDir, d), source: 'library' });
    },
    get: (id: string) => skillMap.get(id),
  } as never;
  const config = loadConfig({ rootDir: root, loadDotEnv: false, env: {} });
  const svc = createTeamsService({ config: { ...config, skillsDirs: [skillsDir] }, db, agents, scheduler, skills, catalogDir });
  return { svc, agents, scheduler, agentsDir, skillsDir, db };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-teams-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('team catalog', () => {
  it('loads the two shipped packages without problems', () => {
    const { svc } = setup();
    const l = svc.list();
    expect(l.problems).toEqual([]);
    expect(l.items.map((t) => t.slug).sort()).toEqual(['cskh-zalo-email', 'fb-content-studio']);
  });
});

describe('install', () => {
  it('creates agents the registry can load again, plus skills and disabled schedules', () => {
    const { svc, agents, scheduler, agentsDir, skillsDir } = setup();
    const ref = { kind: 'catalog', id: 'cskh-zalo-email' } as const;
    const plan = svc.preview(ref, {});
    expect(plan.canInstall).toBe(false);
    expect(plan.missingInputs).toContain('SHOP_NAME');
    const res = svc.install(ref, { inputs: { SHOP_NAME: 'Hoa Sen' }, defaultRuntime: 'mock' });
    expect(res.agents.map((a) => a.id).sort()).toEqual(['cskh-agent', 'cskh-complaints']);
    const fresh = createAgentRegistry({ agentsDir, workspacesDir: path.join(root, 'ws') });
    expect(fresh.errors()).toEqual([]);
    const a = fresh.require('cskh-agent');
    expect(a.runtime).toBe('mock');
    expect(a.permission).toBe('safe');
    expect(a.persona.length).toBeGreaterThan(50);
    expect(a.access.connections).toEqual({});
    expect(a.access.skills).toContain('cskh-escalation');
    expect(agents.get('cskh-complaints')?.reportsTo).toBe('cskh-agent');
    expect(fs.existsSync(path.join(skillsDir, 'cskh-escalation', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(a.dir, 'knowledge', 'customer-care.md'))).toBe(true);
    expect(scheduler.rows).toHaveLength(1);
    expect(scheduler.rows[0]!.enabled).toBe(false);
    expect(scheduler.rows[0]!.prompt).toContain('Hoa Sen');
    expect(svc.list().history[0]!.slug).toBe('cskh-zalo-email');
  });

  it('renames on id clash by default and skips when asked', () => {
    const { svc, agents } = setup();
    const ref = { kind: 'catalog', id: 'fb-content-studio' } as const;
    const inputs = { BRAND_NAME: 'Rocket' };
    svc.install(ref, { inputs, defaultRuntime: 'mock' });
    const second = svc.install(ref, { inputs, defaultRuntime: 'mock' });
    expect(second.agents.map((a) => a.id).sort()).toEqual(['fb-comment-agent-2', 'fb-content-lead-2']);
    expect(agents.get('fb-comment-agent-2')).toBeTruthy();
    const plan = svc.preview(ref, { inputs, strategy: 'skip' });
    expect(plan.agents.every((a) => a.action === 'skip' && a.collision)).toBe(true);
    const before = agents.list().length;
    svc.install(ref, { inputs, strategy: 'skip', defaultRuntime: 'mock' });
    expect(agents.list().length).toBe(before);
  });

  it('never writes a secret input value', () => {
    const dir = path.join(root, 'cat', 'sec');
    fs.mkdirSync(path.join(dir, 'agents', 'bot'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'TEAM.md'), '---\nschema: aios-team/v1\nname: Sec\nslug: sec\ndescription: d\nmanager: bot\ninputs:\n  - key: API_TOKEN\n    kind: secret\n---\nx');
    fs.writeFileSync(path.join(dir, 'agents', 'bot', 'agent.yaml.template'), 'name: "Bot"\ndescription: "uses {{input.API_TOKEN}}"');
    fs.writeFileSync(path.join(dir, 'agents', 'bot', 'persona.md'), 'Token: {{input.API_TOKEN}}');
    const { svc, agentsDir } = setup(path.join(root, 'cat'));
    svc.install({ kind: 'catalog', id: 'sec' }, { inputs: { API_TOKEN: 'sk-supersecretvalue1234567890' }, defaultRuntime: 'mock' });
    const all = fs.readFileSync(path.join(agentsDir, 'bot', 'persona.md'), 'utf8') + fs.readFileSync(path.join(agentsDir, 'bot', 'agent.yaml'), 'utf8');
    expect(all).not.toContain('supersecret');
    expect(all).toContain('CHƯA CẤU HÌNH');
  });

  it('rolls back when a schedule is invalid', () => {
    const s = setup();
    s.scheduler.create = () => { throw new Error('boom'); };
    expect(() => s.svc.install({ kind: 'catalog', id: 'cskh-zalo-email' }, { inputs: { SHOP_NAME: 'x' }, defaultRuntime: 'mock' })).toThrow(/hoàn tác/);
    expect(s.agents.list()).toEqual([]);
    expect(fs.existsSync(path.join(s.skillsDir, 'cskh-escalation'))).toBe(false);
  });
});

describe('export and import', () => {
  it('exports a zip without secrets, absolute paths or emails, and re-imports it', () => {
    const { svc, agents, scheduler } = setup();
    agents.create('seller', {
      name: 'Seller',
      runtime: 'mock',
      persona: `Gọi API với ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnop1234567890 và bot 123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.\nThư mục ${root}/notes, liên hệ boss@example.com, tài khoản 123456789012.`,
    });
    scheduler.create({ name: 'Báo cáo', agentId: 'seller', cron: '0 8 * * *', prompt: 'Gửi cho boss@example.com', timezone: 'Asia/Ho_Chi_Minh' });
    const res = svc.export({ name: 'Đội bán hàng', agentIds: ['seller'] });
    expect(res.redactions).toBeGreaterThan(3);
    const zip = new AdmZip(res.zip);
    const text = zip.getEntries().map((e) => e.getData().toString('utf8')).join('\n');
    for (const bad of ['sk-ant-abcdef', 'AAAAAAAAAAAAAAAA', 'boss@example.com', root, '123456789012', os.homedir()]) expect(text).not.toContain(bad);
    expect(zip.getEntry('TEAM.md')).toBeTruthy();
    expect(zip.getEntry('schedules.yaml')).toBeTruthy();
    const imp = svc.importZip(res.zip);
    expect(imp.team.agents.map((a) => a.id)).toEqual(['seller']);
  });

  it('rejects scripts and path traversal in imports', () => {
    const { svc } = setup();
    const mk = (extra: string) => {
      const z = new AdmZip();
      z.addFile('TEAM.md', Buffer.from('---\nschema: aios-team/v1\nname: X\nslug: x\ndescription: d\nmanager: a1\n---\n'));
      z.addFile('agents/a1/agent.yaml.template', Buffer.from('name: A'));
      z.addFile('agents/a1/persona.md', Buffer.from('p'));
      z.addFile(extra, Buffer.from('echo hi'));
      return z.toBuffer();
    };
    expect(() => svc.importZip(mk('agents/a1/run.sh'))).toThrow(/văn bản|script/);
    expect(() => svc.importZip(mk('../evil.md'))).toThrow();
  });
});

describe('shipped packages', () => {
  it('mention no owner-only CLI, runtime or messenger', () => {
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const abs = path.join(d, e.name);
        if (e.isDirectory()) walk(abs);
        else if (/-cli\b|CLAUDECLAW|hive-mind|hive-cli/i.test(fs.readFileSync(abs, 'utf8'))) hits.push(path.relative(REPO, abs));
      }
    };
    walk(path.join(REPO, 'teams'));
    expect(hits).toEqual([]);
  });
});
