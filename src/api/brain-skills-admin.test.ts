// Brain folders CRUD, skill roots, skill grants and the directory browser, over HTTP with real services.
import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../agents/registry.js';
import { loadConfig } from '../core/config.js';
import type { AppDeps } from '../core/deps.js';
import { createBrainService } from '../shared/brain.js';
import { listDirs } from '../shared/fs-browse.js';
import { createSkillLibrary } from '../shared/skills.js';
import { memDb, testLog, tmpDir, writeFile } from '../shared/test-kit.js';
import { errorBody, handleError } from './errors.js';
import { brainRoutes } from './routes/brain.js';
import { skillsAdminRoutes } from './routes/skills-admin.js';

let root: string;
let deps: AppDeps;
let app: Hono;
const audit: string[] = [];

const call = async (method: string, url: string, body?: unknown) => {
  const res = await app.request(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as any };
};

function mkSkill(dir: string, id: string) {
  writeFile(path.join(dir, id, 'SKILL.md'), `---\nname: ${id}\ndescription: d\n---\n# ${id}\n`);
}

beforeEach(() => {
  root = tmpDir('aios-admin-');
  audit.length = 0;
  fs.mkdirSync(path.join(root, 'agents'));
  fs.mkdirSync(path.join(root, 'data'));
  const config = loadConfig({ rootDir: root, loadDotEnv: false, env: { AIOS_SKILLS_DIRS: './skills' } });
  const db = memDb();
  const agents = createAgentRegistry({ agentsDir: config.agentsDir, workspacesDir: config.workspacesDir });
  mkSkill(path.join(root, 'skills'), 'viet-caption');
  writeFile(config.brainConfigFile, '# giữ chú thích này\nfolders: []\n');
  const brain = createBrainService({ db, configFile: config.brainConfigFile, rootDir: root, log: testLog });
  const skills = createSkillLibrary({ dirs: config.skillsDirs, log: testLog });
  agents.create('a1', { name: 'A1', runtime: 'mock', access: { brain: {}, memory: { team: true, private: true }, skills: [], connections: {}, modules: {} } });
  agents.create('a2', { name: 'A2', runtime: 'mock', access: { brain: {}, memory: { team: true, private: true }, skills: 'all', connections: {}, modules: {} } });
  deps = { config, db, brain, skills, agents, audit: { log: (e: { action: string }) => void audit.push(e.action) } } as unknown as AppDeps;
  app = new Hono();
  app.onError(handleError(testLog));
  app.notFound((c) => c.json(errorBody('not_found', 'x'), 404));
  skillsAdminRoutes(app, deps);
  brainRoutes(app, deps);
});

describe('brain folders', () => {
  it('creates with slug id, indexes, marks vault, keeps comments', async () => {
    const dir = path.join(root, 'cty');
    writeFile(path.join(dir, 'a.md'), '# Xin chào\nnội dung');
    fs.mkdirSync(path.join(dir, '.obsidian'));
    const r = await call('POST', '/api/brain/folders', { name: 'Công ty Đại Phát', path: dir, description: 'mô tả' });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ id: 'cong-ty-dai-phat', exists: true, isVault: true, mdCount: 1, docs: 1 });
    const yaml = fs.readFileSync(deps.config.brainConfigFile, 'utf8');
    expect(yaml).toContain('# giữ chú thích này');
    expect(yaml).toContain('id: cong-ty-dai-phat');
    const list = await call('GET', '/api/brain/folders');
    expect(list.json.items).toHaveLength(1);
    expect(deps.brain.search('Xin chào')).toHaveLength(1);
  });

  it('makes ids unique, refuses duplicates, missing dirs, data/ and node_modules', async () => {
    const a = path.join(root, 'a');
    const b = path.join(root, 'b');
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    expect((await call('POST', '/api/brain/folders', { name: 'Kho', path: a })).json.id).toBe('kho');
    expect((await call('POST', '/api/brain/folders', { name: 'Kho', path: b })).json.id).toBe('kho-2');
    expect((await call('POST', '/api/brain/folders', { name: 'Khác', path: a })).status).toBe(409);
    expect((await call('POST', '/api/brain/folders', { name: 'X', path: path.join(root, 'nope') })).status).toBe(400);
    expect((await call('POST', '/api/brain/folders', { name: 'X', path: path.join(root, 'data') })).status).toBe(400);
    fs.mkdirSync(path.join(root, 'x', 'node_modules', 'p'), { recursive: true });
    expect((await call('POST', '/api/brain/folders', { name: 'X', path: path.join(root, 'x', 'node_modules', 'p') })).status).toBe(400);
    fs.mkdirSync(path.join(root, 'c'));
    expect((await call('POST', '/api/brain/folders', { name: 'X', id: 'Bad Id', path: path.join(root, 'c') })).status).toBe(400);
  });

  it('updates name, description and path', async () => {
    const a = path.join(root, 'a');
    const b = path.join(root, 'b');
    writeFile(path.join(a, 'x.md'), '# X');
    writeFile(path.join(b, 'y.md'), '# Y');
    await call('POST', '/api/brain/folders', { name: 'Kho', path: a });
    const r = await call('PUT', '/api/brain/folders/kho', { name: 'Kho mới', description: 'd', path: b });
    expect(r.json).toMatchObject({ name: 'Kho mới', description: 'd', path: b, docs: 1 });
    expect(deps.brain.search('Y')).toHaveLength(1);
    expect(deps.brain.search('X')).toHaveLength(0);
    expect((await call('PUT', '/api/brain/folders/none', { name: 'q' })).status).toBe(404);
  });

  it('removes folder, its rows and every agent grant, leaving files alone', async () => {
    const a = path.join(root, 'a');
    writeFile(path.join(a, 'x.md'), '# X');
    await call('POST', '/api/brain/folders', { name: 'Kho', path: a });
    const acc = deps.agents.get('a1')!.access;
    deps.agents.update('a1', { access: { ...acc, brain: { kho: { read: ['**'], write: [] }, other: { read: ['**'], write: [] } } } });
    const list = (await call('GET', '/api/brain/folders')).json.items[0];
    expect(list.readers).toEqual(['a1']);
    const r = await call('DELETE', '/api/brain/folders/kho');
    expect(r.json).toMatchObject({ ok: true, agentsUpdated: ['a1'] });
    expect(fs.existsSync(path.join(a, 'x.md'))).toBe(true);
    expect(deps.db.prepare('SELECT COUNT(*) n FROM brain_docs').get()).toEqual({ n: 0 });
    expect(Object.keys(deps.agents.get('a1')!.access.brain)).toEqual(['other']);
    expect(fs.readFileSync(deps.config.brainConfigFile, 'utf8')).not.toContain('kho');
    expect((await call('DELETE', '/api/brain/folders/kho')).status).toBe(404);
    expect(audit).toContain('brain.folder.remove');
  });
});

describe('fs browser', () => {
  it('lists directories only, flags vaults and skills, skips hidden except .claude, stays in home', () => {
    const home = tmpDir('aios-home-');
    fs.mkdirSync(path.join(home, 'vault', '.obsidian'), { recursive: true });
    mkSkill(path.join(home, '.claude', 'skills'), 's');
    fs.mkdirSync(path.join(home, '.secret'));
    fs.mkdirSync(path.join(home, 'Zeta'));
    writeFile(path.join(home, 'file.txt'), 'x');
    const r = listDirs(home, { home });
    expect(r.parent).toBeNull();
    expect(r.dirs.map((d) => d.name)).toEqual(['.claude', 'vault', 'Zeta']);
    expect(r.dirs.find((d) => d.name === 'vault')?.isVault).toBe(true);
    expect(r.dirs.find((d) => d.name === '.claude')?.hasSkills).toBe(true);
    const sub = listDirs(path.join(home, '.claude'), { home });
    expect(sub.parent).toBe(fs.realpathSync(home));
    expect(sub.dirs[0]).toMatchObject({ name: 'skills', hasSkills: true });
    expect(() => listDirs('/', { home })).toThrow();
    expect(() => listDirs(path.join(home, 'file.txt'), { home })).toThrow();
    expect(() => listDirs(path.join(home, 'nope'), { home })).toThrow();
    expect(() => listDirs('relative/dir', { home })).toThrow();
  });

  it('route refuses paths outside the home directory', async () => {
    expect((await call('GET', '/api/fs/dirs?path=/')).status).toBe(400);
    expect((await call('GET', '/api/fs/dirs?path=~')).status).toBe(200);
  });
});

describe('skill roots', () => {
  it('lists env root, adds and removes a user root, reports clashes, persists to skills.yaml', async () => {
    const extra = path.join(root, 'extra');
    mkSkill(extra, 'viet-caption');
    mkSkill(extra, 'moi');
    const before = (await call('GET', '/api/skills/roots')).json;
    expect(before.items).toHaveLength(1);
    expect(before.items[0]).toMatchObject({ kind: 'env', readOnly: true, skills: 1 });

    const added = await call('POST', '/api/skills/roots', { path: extra, label: 'Thêm' });
    expect(added.status).toBe(201);
    expect(added.json).toMatchObject({ kind: 'user', readOnly: false, skills: 2, clashes: ['viet-caption'] });
    expect(deps.skills.get('moi')).toBeTruthy();
    expect(deps.skills.get('viet-caption')?.dir).toBe(path.join(root, 'skills', 'viet-caption')); // first root wins
    expect(fs.readFileSync(path.join(deps.config.configDir, 'skills.yaml'), 'utf8')).toContain('label: Thêm');
    expect((await call('POST', '/api/skills/roots', { path: extra })).status).toBe(409);
    expect((await call('POST', '/api/skills/roots', { path: path.join(root, 'nope') })).status).toBe(400);

    expect((await call('DELETE', '/api/skills/roots', { path: path.join(root, 'skills') })).status).toBe(400);
    expect((await call('DELETE', '/api/skills/roots', { path: extra })).json.ok).toBe(true);
    expect(deps.skills.get('moi')).toBeUndefined();
    expect((await call('DELETE', '/api/skills/roots', { path: extra })).status).toBe(404);
  });

  it('suggests brain-folder skills dirs and hides ones already added', async () => {
    const brainDir = path.join(root, 'kho');
    mkSkill(path.join(brainDir, '.claude', 'skills'), 'trong-kho');
    await call('POST', '/api/brain/folders', { name: 'Kho', path: brainDir });
    const sug = (await call('GET', '/api/skills/roots')).json.suggestions;
    expect(sug.map((s: { path: string }) => s.path)).toContain(path.join(fs.realpathSync(brainDir), '.claude', 'skills').replace(fs.realpathSync(root), root));
    await call('POST', '/api/skills/roots', { path: path.join(brainDir, '.claude', 'skills') });
    const after = (await call('GET', '/api/skills/roots')).json.suggestions;
    expect(after.some((s: { path: string }) => s.path.endsWith(path.join('kho', '.claude', 'skills')))).toBe(false);
  });
});

describe('skill grants', () => {
  it('adds and removes a skill per agent, skips agents with all', async () => {
    const r = await call('PUT', '/api/skills/viet-caption/agents', { agentIds: ['a1'] });
    expect(r.json.usedBy.sort()).toEqual(['a1', 'a2']);
    expect(deps.agents.get('a1')!.access.skills).toEqual(['viet-caption']);
    expect(deps.agents.get('a2')!.access.skills).toBe('all');
    const r2 = await call('PUT', '/api/skills/viet-caption/agents', { agentIds: [] });
    expect(r2.json.usedBy).toEqual(['a2']);
    expect(deps.agents.get('a1')!.access.skills).toEqual([]);
    expect((await call('PUT', '/api/skills/none/agents', { agentIds: [] })).status).toBe(404);
    expect((await call('PUT', '/api/skills/viet-caption/agents', { agentIds: ['ghost'] })).status).toBe(400);
  });
});
