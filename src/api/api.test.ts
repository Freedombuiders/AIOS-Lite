// Contract tests: every route of docs/dev/API.md against in-memory deps + fakes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nowIso } from '../core/db.js';
import type { AppDeps } from '../core/deps.js';
import type { Conversation, Message, Schedule, Skill } from '../core/types.js';
import { createModuleManager } from '../modules/manager.js';
import { createTestHarness, type TestHarness } from '../modules/test-deps.js';
import { createApiServer } from './server.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'modules', '__tests__', 'modules');

let h: TestHarness;
let app: Hono;
let deps: AppDeps;

function wire(token?: string) {
  h = createTestHarness({ modulesDir: FIXTURES, env: token ? { AIOS_TOKEN: token } : {} });
  deps = h.deps;
  const f = h.fakes;
  const runtime = {
    id: 'mock' as const, label: 'Mock',
    capabilities: { resume: false, systemPrompt: 'inline', reportsCost: false, images: false, noTools: true, enforces: { context: 'hard', mcp: 'none', fileRead: 'none', fileWrite: 'none', shell: 'none' } },
    doctor: async () => ({ runtime: 'mock' as const, status: 'pass' as const, checks: [], testedAt: nowIso() }),
    run: async () => ({ ok: true, output: '' }),
  };
  Object.assign(deps, {
    runtimes: { get: () => runtime, list: () => [runtime], register() {} },
    stats: { overview: () => ({ agents: { total: 1, enabled: 1, running: 0 }, tasks: deps.tasks.counts(), runsToday: 0, costMonthUsd: 0, costByAgent: [], recentRuns: [] }) },
    access: {
      ...deps.access,
      resolve: (a: { id: string }) => ({ agentId: a.id, readDirs: [], writeDirs: [], addDirs: [], memory: { team: true, private: true }, mcpServers: [{ id: 'x', allowedTools: ['*'], env: { K: 'v' } }], envVars: { K: 'v' }, skills: [], moduleScopes: {}, permission: 'safe', tools: 'default' }),
      snapshot: (x: { mcpServers: { id: string; allowedTools: string[] }[]; envVars: Record<string, string> }) => ({ ...x, mcpServers: x.mcpServers.map((m) => ({ id: m.id, allowedTools: m.allowedTools })), envVars: Object.keys(x.envVars), skills: [] }),
    },
    board: { add: () => ({}), recent: () => [{ id: 1, agentId: 'main', taskId: null, kind: 'note', text: 'hi', createdAt: nowIso() }] },
    brain: {
      ...deps.brain,
      folders: () => [{ id: 'kb', name: 'KB', path: h.root }],
      tree: () => [{ name: 'a.md', path: 'a.md', type: 'file' }],
      read: (_f: string, p: string) => {
        if (p.includes('..')) throw new Error('traversal');
        return { title: 'A', content: '# A', mtimeMs: 1 };
      },
      search: () => [{ folderId: 'kb', path: 'a.md', title: 'A', snippet: 'x', score: 1 }],
    },
    skills: {
      ...deps.skills,
      list: () => [{ id: 's1', name: 'S1', description: '', path: '/x/SKILL.md', dir: '/x', source: 'library' } as Skill],
      get: (id: string) => (id === 's1' ? ({ id: 's1', name: 'S1', description: '', path: '/x/SKILL.md', dir: '/x', source: 'library' } as Skill) : undefined),
      read: () => '# skill',
    },
    scheduler: (() => {
      const list: Schedule[] = [];
      const mk = (i: Record<string, unknown>): Schedule => ({ id: list.length + 1, name: String(i.name), agentId: String(i.agentId), cron: String(i.cron), timezone: 'UTC', prompt: String(i.prompt), enabled: true, lastRunAt: null, nextRunAt: null, lastTaskId: null, createdAt: nowIso(), updatedAt: nowIso() });
      return {
        list: () => list,
        get: (id: number) => list.find((s) => s.id === id),
        create(i: Record<string, unknown>) {
          const s = mk(i);
          list.push(s);
          return s;
        },
        update: (id: number, p: Partial<Schedule>) => Object.assign(list.find((s) => s.id === id)!, p),
        remove(id: number) {
          list.splice(list.findIndex((s) => s.id === id), 1);
        },
        runNow: () => f.mkTask({ prompt: 'scheduled', source: 'schedule:1' }),
        tick: () => [], start() {}, stop() {},
      };
    })(),
    chat: (() => {
      const convos: Conversation[] = [];
      const msgs: Message[] = [];
      return {
        listConversations: () => convos,
        create(i: { agentId: string; title?: string }) {
          const c: Conversation = { id: convos.length + 1, agentId: i.agentId, title: i.title ?? 'Mới', sessionId: null, sessionRuntime: null, createdAt: nowIso(), updatedAt: nowIso() };
          convos.push(c);
          return c;
        },
        get: (id: number) => (convos.find((c) => c.id === id) ? { conversation: convos.find((c) => c.id === id)!, messages: msgs } : undefined),
        rename: (id: number, title: string) => Object.assign(convos.find((c) => c.id === id)!, { title }),
        remove(id: number) {
          convos.splice(convos.findIndex((c) => c.id === id), 1);
        },
        send(id: number, content: string) {
          const m: Message = { id: msgs.length + 1, conversationId: id, role: 'user', content, taskId: null, createdAt: nowIso() };
          msgs.push(m);
          return { message: m, task: f.mkTask({ prompt: content, kind: 'chat' }) };
        },
      };
    })(),
  });
  f.agents.get('main')!.access.connections = { gh: true };
  f.connections.set('gh', { id: 'gh', type: 'env', env: { TOKEN: 'ghp_supersecretvalue1234567890', REF: '$GH_TOKEN', EMPTY: '' } });
  (deps as { modules: unknown }).modules = createModuleManager(deps, { fromDist: false });
  app = createApiServer(deps, { webDir: path.join(h.root, 'no-web') }).app;
}

const call = async (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) => {
  const res = await app.request(url, {
    method,
    headers: { ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, res };
};

beforeEach(() => wire());
afterEach(async () => {
  await deps.modules.stop();
  h.cleanup();
});

describe('conventions', () => {
  it('error shape, 404 and invalid JSON', async () => {
    let r = await call('GET', '/api/nope');
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: { code: 'not_found', message: expect.any(String) } });
    r = await app.request('/api/tasks', { method: 'POST', body: '{oops', headers: { 'content-type': 'application/json' } }).then(async (x) => ({ status: x.status, body: await x.json() }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('bad_request');
    r = await call('POST', '/api/tasks', { prompt: '' });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/prompt/);
  });

  it('enforces AIOS_TOKEN (header; ?token= only for SSE)', async () => {
    wire('s3cret');
    expect((await call('GET', '/api/health')).status).toBe(401);
    expect((await call('GET', '/api/health', undefined, { authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await call('GET', '/api/health?token=s3cret')).status).toBe(401);
    expect((await call('GET', '/api/health', undefined, { authorization: 'Bearer s3cret' })).status).toBe(200);
    const sse = await app.request('/api/events?token=s3cret');
    expect(sse.status).toBe(200);
    await sse.body!.cancel();
  });
});

describe('system', () => {
  it('health, runtimes, stats, attention, settings', async () => {
    expect((await call('GET', '/api/health')).body).toMatchObject({ ok: true, version: expect.any(String), uptimeSec: expect.any(Number) });
    const rt = (await call('GET', '/api/runtimes?probe=1')).body.items[0];
    expect(rt).toMatchObject({ runtime: 'mock', label: 'Mock', status: 'pass', capabilities: { noTools: true } });
    expect((await call('GET', '/api/stats')).body.agents.total).toBe(1);

    deps.attention.raise({ key: 'task:1', kind: 'review', title: 'x', severity: 'info' });
    expect((await call('GET', '/api/attention')).body.items).toHaveLength(1);
    expect((await call('POST', '/api/attention/task%3A1/resolve')).body).toEqual({ ok: true });
    expect((await call('GET', '/api/attention')).body.items).toHaveLength(0);

    expect((await call('GET', '/api/settings')).body).toMatchObject({ timezone: expect.any(String), maxParallel: 3, emergencyStop: false });
    expect((await call('PUT', '/api/settings', { emergencyStop: true })).body.emergencyStop).toBe(true);
    expect(deps.db.prepare("SELECT value FROM kv WHERE key='emergency_stop'").get()).toEqual({ value: '1' });
    expect((await call('PUT', '/api/settings', { emergencyStop: false })).body.emergencyStop).toBe(false);
    expect((await call('PUT', '/api/settings', { emergencyStop: 'x' })).status).toBe(400);
  });
});

describe('agents', () => {
  it('list, get, create, update, archive, reload, access', async () => {
    const list = (await call('GET', '/api/agents')).body;
    expect(list.items[0]).toMatchObject({ id: 'main', stats: { running: 0, queued: 0, lastRunAt: null, costMonthUsd: 0, runsMonth: 0 } });
    expect(list.items[0].persona).toBeUndefined();
    expect(list.errors).toEqual([]);
    expect((await call('GET', '/api/agents/main')).body).toMatchObject({ id: 'main', stats: expect.any(Object) });
    expect((await call('GET', '/api/agents/zzz')).status).toBe(404);

    const created = await call('POST', '/api/agents', { id: 'writer', name: 'Writer', runtime: 'mock' });
    expect(created.status).toBe(201);
    expect((await call('POST', '/api/agents', { id: 'writer', name: 'W', runtime: 'mock' })).status).toBe(409);
    expect((await call('POST', '/api/agents', { id: 'Bad Id', name: 'W', runtime: 'mock' })).status).toBe(400);
    expect((await call('PUT', '/api/agents/writer', { description: 'd' })).body.description).toBe('d');
    expect((await call('PUT', '/api/agents/zzz', {})).status).toBe(404);
    expect((await call('POST', '/api/agents/reload')).body).toHaveProperty('items');

    const access = (await call('GET', '/api/agents/main/access')).body;
    expect(access).toMatchObject({ runtime: 'mock', enforcement: { context: 'hard' }, access: { agentId: 'main', envVars: ['K'] } });
    expect(JSON.stringify(access)).not.toContain('"v"');

    expect((await call('DELETE', '/api/agents/writer')).body).toEqual({ ok: true });
    expect((await call('DELETE', '/api/agents/writer')).status).toBe(404);
  });
});

describe('connections', () => {
  it('never returns secret values; test; composio key', async () => {
    const { body } = await call('GET', '/api/connections');
    const gh = body.items[0];
    expect(gh).toMatchObject({ id: 'gh', ready: true, grantedTo: ['main'], env: { TOKEN: '[set]', REF: '$GH_TOKEN', EMPTY: '[missing]' } });
    expect(JSON.stringify(body)).not.toContain('supersecret');
    expect((await call('POST', '/api/connections/gh/test')).body).toEqual({ ok: true, message: 'ok' });
    expect((await call('POST', '/api/connections/zzz/test')).status).toBe(404);
    expect((await call('PUT', '/api/connections/composio-key', { apiKey: 'short' })).status).toBe(400);
    expect((await call('PUT', '/api/connections/composio-key', { apiKey: 'ak_1234567890abcdef' })).body).toEqual({ ok: true });
    expect(fs.readFileSync(path.join(h.root, '.env'), 'utf8')).toContain('COMPOSIO_API_KEY=ak_1234567890abcdef');
    delete process.env.COMPOSIO_API_KEY;
  });
});

describe('tasks, runs, comments', () => {
  it('covers every task route', async () => {
    expect((await call('POST', '/api/tasks', { prompt: 'x', agentId: 'zzz' })).status).toBe(400);
    const t = await call('POST', '/api/tasks', { prompt: 'Làm báo cáo', agentId: 'main' });
    expect(t.status).toBe(201);
    expect(t.body).toMatchObject({ source: 'user', status: 'queued', agentId: 'main' });
    const api = await call('POST', '/api/tasks', { prompt: 'y', source: 'agent:x' }, { 'x-aios-source': 'api' });
    expect(api.body.source).toBe('api');

    const id = t.body.id;
    expect((await call('GET', '/api/tasks?status=queued,running&agentId=main&limit=5')).body.items.length).toBeGreaterThan(0);
    expect((await call('GET', '/api/tasks?status=bogus')).status).toBe(400);
    expect((await call('GET', '/api/tasks/counts')).body).toMatchObject({ queued: 2, done: 0 });
    const detail = (await call('GET', `/api/tasks/${id}`)).body;
    expect(detail).toMatchObject({ task: { id }, runs: [], children: [], comments: [], parent: null });
    expect((await call('GET', '/api/tasks/999')).status).toBe(404);
    expect((await call('GET', '/api/tasks/abc')).status).toBe(400);

    const team = await call('POST', '/api/tasks/team', { prompt: 'p', agentIds: ['main'], mode: 'parallel' });
    expect(team.status).toBe(201);
    expect((await call('POST', '/api/tasks/team', { prompt: 'p', agentIds: ['zzz'], mode: 'parallel' })).status).toBe(400);

    const c = await call('POST', `/api/tasks/${id}/comments`, { body: 'nhận xét' });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ author: 'user', body: 'nhận xét' });
    expect((await call('GET', `/api/tasks/${id}/comments`)).body.items).toHaveLength(1);

    expect((await call('POST', `/api/tasks/${id}/approve`)).status).toBe(409);
    expect((await call('POST', `/api/tasks/${id}/retry`)).status).toBe(409);
    expect((await call('POST', `/api/tasks/${id}/cancel`)).body.status).toBe('cancelled');
    expect((await call('POST', `/api/tasks/${id}/cancel`)).status).toBe(409);
    expect((await call('POST', `/api/tasks/${id}/retry`)).body).toMatchObject({ status: 'queued', trigger: 'retry' });

    deps.tasks.update(id, { status: 'review' });
    expect((await call('POST', `/api/tasks/${id}/approve`)).body.status).toBe('done');

    // runs
    h.fakes.finish(api.body.id, 'done', 'xong');
    const runs = (await call('GET', `/api/runs?taskId=${api.body.id}&status=done`)).body.items;
    expect(runs).toHaveLength(1);
    const run = (await call('GET', `/api/runs/${runs[0].id}?afterEventId=0`)).body;
    expect(run).toMatchObject({ run: { output: 'xong' }, events: [], access: null });
    expect((await call('GET', '/api/runs/999')).status).toBe(404);
    expect((await call('GET', '/api/runs?status=zzz')).status).toBe(400);
  });
});

describe('schedules', () => {
  it('CRUD + run + cron validation', async () => {
    const input = { name: 'Sáng', agentId: 'main', cron: '0 8 * * *', prompt: 'báo cáo' };
    expect((await call('POST', '/api/schedules', { ...input, cron: 'not cron' })).status).toBe(400);
    expect((await call('POST', '/api/schedules', { ...input, agentId: 'zzz' })).status).toBe(400);
    const s = await call('POST', '/api/schedules', input);
    expect(s.status).toBe(201);
    expect((await call('GET', '/api/schedules')).body.items).toHaveLength(1);
    expect((await call('PUT', `/api/schedules/${s.body.id}`, { name: 'Tối' })).body.name).toBe('Tối');
    expect((await call('PUT', `/api/schedules/${s.body.id}`, { cron: 'bad' })).status).toBe(400);
    expect((await call('POST', `/api/schedules/${s.body.id}/run`)).body).toMatchObject({ source: 'schedule:1' });
    expect((await call('DELETE', `/api/schedules/${s.body.id}`)).body).toEqual({ ok: true });
    expect((await call('DELETE', '/api/schedules/9')).status).toBe(404);
  });
});

describe('conversations', () => {
  it('create, get, rename, send, delete', async () => {
    expect((await call('POST', '/api/conversations', { agentId: 'zzz' })).status).toBe(400);
    const c = await call('POST', '/api/conversations', { agentId: 'main', title: 'Hỏi' });
    expect(c.status).toBe(201);
    const id = c.body.id;
    expect((await call('GET', '/api/conversations?agentId=main')).body.items).toHaveLength(1);
    expect((await call('PATCH', `/api/conversations/${id}`, { title: 'Mới' })).body.title).toBe('Mới');
    const m = await call('POST', `/api/conversations/${id}/messages`, { content: 'xin chào' });
    expect(m.status).toBe(201);
    expect(m.body).toMatchObject({ message: { content: 'xin chào' }, task: { kind: 'chat' } });
    expect((await call('GET', `/api/conversations/${id}`)).body).toMatchObject({ conversation: { id }, messages: expect.any(Array) });
    expect((await call('DELETE', `/api/conversations/${id}`)).body).toEqual({ ok: true });
    expect((await call('GET', `/api/conversations/${id}`)).status).toBe(404);
  });
});

describe('brain, memory, skills, board, audit', () => {
  it('brain', async () => {
    expect((await call('GET', '/api/brain/folders')).body.items[0]).toMatchObject({ id: 'kb', docs: 0, exists: true });
    expect((await call('GET', '/api/brain/tree?folder=kb&depth=2')).body.items).toHaveLength(1);
    expect((await call('GET', '/api/brain/tree?folder=zz')).status).toBe(404);
    expect((await call('GET', '/api/brain/file?folder=kb&path=a.md')).body).toEqual({ title: 'A', content: '# A', mtimeMs: 1 });
    expect((await call('GET', '/api/brain/file?folder=kb&path=../x')).status).toBe(404);
    expect((await call('GET', '/api/brain/search?q=a&folders=kb&limit=3')).body.items[0].folderId).toBe('kb');
    expect((await call('GET', '/api/brain/search')).status).toBe(400);
    expect((await call('POST', '/api/brain/reindex', { full: true })).body).toMatchObject({ indexed: 0 });
    expect((await call('POST', '/api/brain/reindex')).status).toBe(200);
  });

  it('memory', async () => {
    const m = await call('POST', '/api/memory', { content: 'nhớ cái này', agentId: null, pinned: true });
    expect(m.status).toBe(201);
    expect(m.body).toMatchObject({ source: 'user', pinned: true });
    expect((await call('GET', '/api/memory?scope=team&q=nhớ&limit=10')).body.items).toHaveLength(1);
    expect((await call('GET', '/api/memory?scope=x')).status).toBe(400);
    expect((await call('PATCH', `/api/memory/${m.body.id}`, { pinned: false })).body.pinned).toBe(false);
    expect((await call('DELETE', `/api/memory/${m.body.id}`)).body).toEqual({ ok: true });
    expect((await call('PATCH', '/api/memory/999', { pinned: true })).status).toBe(404);
    expect((await call('POST', '/api/memory', { content: 'x', agentId: 'zzz' })).status).toBe(400);
  });

  it('skills, board, audit', async () => {
    expect((await call('GET', '/api/skills')).body.items[0]).toMatchObject({ id: 's1', usedBy: [] });
    expect((await call('GET', '/api/skills/s1')).body).toMatchObject({ skill: { id: 's1' }, content: '# skill' });
    expect((await call('GET', '/api/skills/zz')).status).toBe(404);
    expect((await call('GET', '/api/board?limit=5')).body.items).toHaveLength(1);
    deps.audit.log({ actor: 'user', action: 'x.y' });
    expect((await call('GET', '/api/audit?actor=user&action=x.y&limit=5')).body.items[0]).toMatchObject({ actor: 'user', action: 'x.y' });
    expect((await call('GET', '/api/audit?since=zzz')).status).toBe(400);
  });
});

describe('modules', () => {
  it('list, add (412, 400), settings, route gating, remove, purge', async () => {
    const list = (await call('GET', '/api/modules')).body.items;
    expect(list.map((m: { manifest: { id: string } }) => m.manifest.id)).toEqual(['bad', 'fx', 'needs']);
    expect((await call('GET', '/api/modules/fx')).body).toMatchObject({ manifest: { id: 'fx' }, ready: true, hasServer: true });
    expect((await call('GET', '/api/modules/zzz')).status).toBe(404);

    expect((await call('GET', '/api/m/fx/ping')).status).toBe(404);
    const miss = await call('POST', '/api/modules/needs/add');
    expect(miss.status).toBe(412);
    expect(miss.body.error.code).toBe('requirements_missing');
    expect(miss.body.error.message).toContain('fx');
    expect((await call('POST', '/api/modules/bad/add')).status).toBe(400);

    const add = await call('POST', '/api/modules/fx/add', { installAgents: true });
    expect(add.status).toBe(200);
    expect(add.body).toMatchObject({ migrationsApplied: ['001_init'], agentsInstalled: ['fx-helper'], module: { state: { enabled: true } } });
    expect((await call('GET', '/api/m/fx/ping')).body).toEqual({ pong: true, id: 'fx' });

    expect((await call('PUT', '/api/modules/fx/settings', { token: 'abc', limit: 7 })).body).toMatchObject({ token: '********', limit: 7 });
    expect((await call('GET', '/api/modules/fx/settings')).body).toMatchObject({ token: '********', greeting: 'xin chào' });
    expect((await call('PUT', '/api/modules/fx/settings', { limit: 'abc' })).status).toBe(400);

    expect((await call('POST', '/api/modules/fx/purge', { confirm: 'fx' })).status).toBe(409);
    expect((await call('POST', '/api/modules/fx/remove')).body.state.enabled).toBe(false);
    expect((await call('GET', '/api/m/fx/ping')).status).toBe(404);
    expect((await call('POST', '/api/modules/fx/purge', { confirm: 'wrong' })).status).toBe(400);
    expect((await call('POST', '/api/modules/fx/purge', { confirm: 'fx' })).body).toEqual({ ok: true });
  });
});

describe('SSE', () => {
  it('streams bus events with ?types= filter and pings', async () => {
    app = createApiServer(deps, { pingMs: 20 }).app;
    const res = await app.request('/api/events?types=task');
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = '';
    const t = deps.tasks.create({ prompt: 'sse' });
    deps.bus.emit({ type: 'audit', entry: { id: 1, ts: '', actor: 'a', action: 'b', target: null, runId: null, detail: null } });
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !(text.includes('event: task') && text.includes(': ping'))) {
      const { value } = await reader.read();
      text += dec.decode(value);
    }
    await reader.cancel();
    expect(text).toContain('event: task');
    expect(text).toContain(`"id":${t.id}`);
    expect(text).toContain(': ping');
    expect(text).not.toContain('event: audit');
  });
});

describe('static web + listen', () => {
  it('serves dist/web with SPA fallback and never swallows /api', async () => {
    const web = path.join(h.root, 'web');
    fs.mkdirSync(path.join(web, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(web, 'index.html'), '<html>app</html>');
    fs.writeFileSync(path.join(web, 'assets', 'a.js'), 'x');
    app = createApiServer(deps, { webDir: web }).app;
    expect(await (await app.request('/tasks/12')).text()).toBe('<html>app</html>');
    expect((await app.request('/assets/a.js')).headers.get('content-type')).toContain('javascript');
    expect(await (await app.request('/..%2f..%2fetc/passwd')).text()).toBe('<html>app</html>');
    expect((await app.request('/api/zzz')).status).toBe(404);
  });

  it('listens on the configured host and closes', async () => {
    deps.config.port = 0;
    const server = await createApiServer(deps).listen();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/health`);
    expect(res.status).toBe(200);
    await server.close();
  });
});
