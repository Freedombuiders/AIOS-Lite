import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createModuleManager } from '../modules/manager.js';
import { createTestHarness, type TestHarness } from '../modules/test-deps.js';
import { createApiServer } from '../api/server.js';
import { runCli } from './aios.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let tmp: string;
const out: string[] = [];
const errs: string[] = [];
const io = { out: (t: string) => void out.push(t), err: (t: string) => void errs.push(t) };

beforeEach(() => {
  // inside the repo so the scaffolded server/index.ts can import ../../../src/modules/sdk.js and vite can load it
  tmp = fs.mkdtempSync(path.join(REPO, '.tmp-cli-'));
  fs.symlinkSync(path.join(REPO, 'src'), path.join(tmp, 'src'));
  fs.cpSync(path.join(REPO, 'modules', '_template'), path.join(tmp, 'modules', '_template'), { recursive: true });
  out.length = errs.length = 0;
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('module new', () => {
  it('scaffolds with ids, table prefix and names replaced', async () => {
    expect(await runCli(['module', 'new', 'my-demo'], { io, modulesDir: path.join(tmp, 'modules') })).toBe(0);
    const dir = path.join(tmp, 'modules', 'my-demo');
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'module.json'), 'utf8'));
    expect(manifest).toMatchObject({ id: 'my-demo', name: 'My Demo', tables: ['my_demo_notes'] });
    expect(manifest.agentTemplates).toEqual(['my-demo-helper']);
    expect(fs.existsSync(path.join(dir, 'agents', 'my-demo-helper', 'agent.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'skills', 'my-demo-skill', 'SKILL.md'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'migrations', '001_init.sql'), 'utf8')).toContain('my_demo_notes');
    expect(fs.readFileSync(path.join(dir, 'server', 'index.ts'), 'utf8')).toContain('my_demo_notes');
    expect(fs.readFileSync(path.join(dir, 'web', 'index.tsx'), 'utf8')).toContain('/api/m/my-demo/notes');
    for (const f of ['server/index.ts', 'web/index.tsx', 'module.json', 'agents/my-demo-helper/agent.yaml'])
      expect(fs.readFileSync(path.join(dir, f), 'utf8')).not.toMatch(/_template|template_|template-/);
  });

  it('refuses bad or duplicate ids', async () => {
    const o = { io, modulesDir: path.join(tmp, 'modules') };
    expect(await runCli(['module', 'new', 'Bad_Id'], o)).toBe(1);
    expect(await runCli(['module', 'new', 'demo'], o)).toBe(0);
    expect(await runCli(['module', 'new', 'demo'], o)).toBe(1);
    expect(errs.join()).toContain('đã tồn tại');
  });
});

describe('scaffolded module works with the manager', () => {
  let h: TestHarness;
  afterEach(() => h?.cleanup());

  it('add, serve /hello, remove, purge', async () => {
    await runCli(['module', 'new', 'demo'], { io, modulesDir: path.join(tmp, 'modules') });
    h = createTestHarness({ modulesDir: path.join(tmp, 'modules') });
    const mgr = createModuleManager(h.deps, { fromDist: false });
    (h.deps as { modules: unknown }).modules = mgr;
    const app = createApiServer(h.deps).app;

    const add = await mgr.add('demo', { installAgents: true });
    expect(add.migrationsApplied).toEqual(['001_init']);
    expect(add.agentsInstalled).toEqual(['demo-helper']);
    expect(add.module.error).toBeUndefined();
    expect(h.deps.db.prepare("SELECT name FROM sqlite_master WHERE name='demo_notes'").get()).toBeTruthy();

    const hello = await app.request('/api/m/demo/hello');
    expect(await hello.json()).toEqual({ message: 'Xin chào từ module!', module: 'demo' });

    h.fakes.state.autoFinish = () => ({ output: 'Trả lời mẫu' });
    h.fakes.agents.get('main')!.access.modules = { demo: ['notes.write'] };
    const ask = await app.request('/api/m/demo/ask', { method: 'POST', body: JSON.stringify({ text: 'Chào?', agentId: 'main' }), headers: { 'content-type': 'application/json' } });
    expect(await ask.json()).toMatchObject({ ok: true, answer: 'Trả lời mẫu' });
    expect(h.fakes.tasks[0]).toMatchObject({ source: 'module:demo', contextProfile: 'lean' });

    await mgr.remove('demo');
    expect((await app.request('/api/m/demo/hello')).status).toBe(404);
    await mgr.purge('demo', 'demo');
    expect(h.deps.db.prepare("SELECT name FROM sqlite_master WHERE name='demo_notes'").get()).toBeUndefined();
    await mgr.stop();
  });
});

describe('talking to the API', () => {
  it('agents, task --wait, tasks, memory, brain, module list/add/remove', async () => {
    const calls: string[] = [];
    let polls = 0;
    const fake = (async (url: string, init: RequestInit) => {
      const u = new URL(url);
      calls.push(`${init.method} ${u.pathname}${u.search} ${(init.headers as Record<string, string>).authorization ?? ''}`);
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
      if (u.pathname === '/api/agents') return json({ items: [{ id: 'main', name: 'Main', runtime: 'mock', enabled: true, stats: { running: 0, queued: 1 } }] });
      if (u.pathname === '/api/tasks' && init.method === 'POST') return json({ id: 7, status: 'queued' }, 201);
      if (u.pathname === '/api/tasks/7') return json({ task: { id: 7, status: ++polls < 2 ? 'running' : 'done', result: 'KẾT QUẢ', error: null } });
      if (u.pathname === '/api/tasks') return json({ items: [{ id: 7, status: 'done', agentId: 'main', title: 'T' }] });
      if (u.pathname === '/api/memory' && init.method === 'POST') return json({ id: 3 }, 201);
      if (u.pathname === '/api/memory') return json({ items: [{ id: 3, agentId: null, content: 'nhớ' }] });
      if (u.pathname === '/api/brain/search') return json({ items: [{ folderId: 'kb', path: 'a.md', title: 'A', snippet: 'x' }] });
      if (u.pathname === '/api/modules') return json({ items: [{ manifest: { id: 'care', name: 'Care', version: '1' }, state: { enabled: false }, ready: true }] });
      if (u.pathname === '/api/modules/care/add') return json({ migrationsApplied: ['001'], agentsInstalled: [], module: {} });
      if (u.pathname === '/api/modules/care/remove') return json({});
      return json({ error: { code: 'not_found', message: 'không có' } }, 404);
    }) as unknown as typeof fetch;
    const o = { io, fetch: fake, baseUrl: 'http://x', token: 'tok', pollMs: 1 };

    expect(await runCli(['agents'], o)).toBe(0);
    expect(out.at(-1)).toContain('main');
    expect(await runCli(['task', 'Làm', 'báo cáo', '--agent', 'main', '--wait'], o)).toBe(0);
    expect(out).toContain('KẾT QUẢ');
    expect(calls).toContain('POST /api/tasks Bearer tok');
    expect(await runCli(['tasks', '--status', 'done'], o)).toBe(0);
    expect(await runCli(['memory', 'add', 'nhớ', 'cái', 'này', '--pin'], o)).toBe(0);
    expect(await runCli(['memory', 'search', 'nhớ'], o)).toBe(0);
    expect(await runCli(['brain', 'search', 'a'], o)).toBe(0);
    expect(await runCli(['module', 'list'], o)).toBe(0);
    expect(await runCli(['module', 'add', 'care', '--agents'], o)).toBe(0);
    expect(await runCli(['module', 'remove', 'care'], o)).toBe(0);
    expect(await runCli(['module', 'add', 'zzz'], o)).toBe(1);
    expect(errs.at(-1)).toBe('không có');
    expect(await runCli(['task'], o)).toBe(1);
    expect(await runCli(['bogus'], o)).toBe(1);
    expect(await runCli(['help'], o)).toBe(0);
  });

  it('explains when the server is down', async () => {
    const down = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    expect(await runCli(['agents'], { io, fetch: down, baseUrl: 'http://x' })).toBe(1);
    expect(errs.at(-1)).toContain('Không kết nối được');
  });
});
