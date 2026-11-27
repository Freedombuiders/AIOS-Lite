// Đội AI · Bot API: add a bot with a probe, store its key encrypted, never return it, use it in the adapter, owner only.
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import type { Hono } from 'hono';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs fixture without types
import { startFakeGenbot } from '../../test-fixtures/runtimes/fake-genbot.mjs';
import { createAgentRegistry } from '../agents/registry.js';
import type { AppDeps } from '../core/deps.js';
import type { AppEvent } from '../core/events.js';
import { redactString } from '../core/redact.js';
import { genbotKeysFor } from '../integrations/genbot-keys.js';
import { createTestHarness, type TestHarness } from '../modules/test-deps.js';
import { createRuntimeRegistry } from '../runtimes/index.js';
import { REPO_ROOT, writeFile } from '../shared/test-kit.js';
import { createApiServer } from './server.js';

const KEY = 'gbk_api_test_key_value_0123456789WXYZ';
const KEY2 = 'gbk_rotated_api_key_value_5555QQQQ';

let h: TestHarness;
let app: Hono;
let deps: AppDeps;
let ownerHeaders: Record<string, string> = {};
let fake: { url: string; requests: { method: string; headers: Record<string, string>; body: { message: string } }[]; close(): Promise<void> } | undefined;
const events: AppEvent[] = [];
const logLines: string[] = [];

function wire() {
  h = createTestHarness();
  deps = h.deps;
  const agentsDir = path.join(h.root, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  // the root holds the default team's templates (the add form pre-fills from them)
  (deps.config as { rootDir: string }).rootDir = REPO_ROOT;
  writeFile(path.join(agentsDir, 'old-claude', 'agent.yaml'), 'name: Trợ lý cũ\nruntime: claude\nmodel: sonnet\nruntime_options: {}\n');
  const agents = createAgentRegistry({ agentsDir, workspacesDir: path.join(h.root, 'ws') });
  const keys = genbotKeysFor(deps);
  Object.assign(deps, {
    agents,
    runtimes: createRuntimeRegistry({ genbot: { keyFor: (id) => keys.get(id), pollMs: 10 } }),
    brain: { ...deps.brain, folders: () => [{ id: 'tra-sen-viet', name: 'Trà Sen Việt', path: h.root }] },
    modules: { list: () => [], settings: () => ({}), routeTable: () => [], mount() {}, stop: async () => {} },
    log: pino(
      { level: 'trace', hooks: { logMethod(args, method) { method.apply(this, args.map((a) => (typeof a === 'string' ? redactString(a) : a)) as never); } } },
      new Writable({ write(chunk, _e, cb) { logLines.push(String(chunk)); cb(); } }),
    ),
  });
  deps.bus.on('*', (e) => void events.push(e));
  const server = createApiServer(deps, { webDir: path.join(h.root, 'no-web') });
  app = server.app;
  ownerHeaders = { cookie: `aios_owner=${server.owner.redeem(server.owner.issueCode())}` };
}

const call = async (method: string, url: string, payload?: unknown, headers: Record<string, string> = ownerHeaders) => {
  const res = await app.request(url, {
    method,
    headers: { ...headers, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, text };
};

beforeEach(() => {
  events.length = 0;
  logLines.length = 0;
  wire();
});
afterEach(async () => {
  await fake?.close();
  fake = undefined;
  h.cleanup();
});

/** Everything that left the server or was written during the test, besides the encrypted row. */
function everythingVisible(extra: string[] = []): string {
  const agentFiles = fs.readdirSync(path.join(h.root, 'agents'), { recursive: true }).map(String)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.md'))
    .map((f) => fs.readFileSync(path.join(h.root, 'agents', f), 'utf8'));
  const audit = deps.db.prepare('SELECT * FROM audit_log').all();
  const kv = deps.db.prepare('SELECT * FROM kv').all();
  return [...extra, JSON.stringify(events), logLines.join('\n'), JSON.stringify(audit), JSON.stringify(kv), ...agentFiles].join('\n');
}

describe('Đội AI · Bot API', () => {
  it('empty state: no bot yet, the three templates, the default GenBot address, legacy agents listed apart', async () => {
    const r = await call('GET', '/api/genbot');
    expect(r.status).toBe(200);
    expect(r.body.bots).toEqual([]);
    expect(r.body.baseUrl).toBe('http://127.0.0.1:8800');
    expect(r.body.templates.map((t: { id: string; label: string }) => t.label)).toEqual(['CSKH Zalo', 'Nội dung', 'Trợ lý']);
    const cskh = r.body.templates[0];
    expect(cskh).toMatchObject({ context: 'lean', brain: { read: ['san-pham/**', 'chinh-sach/**', 'giong-noi.md'], write: [] }, modules: { care: ['reply.draft', 'reply.send'] } });
    expect(r.body.legacy).toEqual([{ id: 'old-claude', name: 'Trợ lý cũ', runtime: 'claude', enabled: true }]);
  });

  it('probe before saving, add a bot with its key, the adapter uses it, rotate, delete: the key never leaves the server', async () => {
    fake = await startFakeGenbot({ scenario: 'ok', key: KEY, reply: 'pong' });
    const probe = await call('POST', '/api/genbot/probe', { botId: 'bot_cskh', key: KEY, baseUrl: fake!.url });
    expect(probe.status).toBe(200);
    expect(probe.body.summary).toMatchObject({ ok: true });
    expect(probe.body.summary.message).toContain('pong');
    expect(fake!.requests.at(-1)!.headers.authorization).toBe(`Bearer ${KEY}`);

    const created = await call('POST', '/api/genbot/bots', { name: 'Bot CSKH', role: 'Trực Zalo', botId: 'bot_cskh', key: KEY, baseUrl: fake!.url, template: 'cskh', brainFolder: 'tra-sen-viet' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      id: 'bot-cskh', name: 'Bot CSKH', role: 'Trực Zalo', botId: 'bot_cskh', connected: true, maxRunsDay: 500, context: 'lean',
      key: { hasKey: true, last4: 'WXYZ', source: 'store' },
      brain: [{ folder: 'tra-sen-viet', read: ['san-pham/**', 'chinh-sach/**', 'giong-noi.md'], write: [] }],
      modules: { care: ['reply.draft', 'reply.send'] },
    });
    const cfg = deps.agents.require('bot-cskh');
    expect(cfg.runtime).toBe('genbot');
    expect(cfg.runtimeOptions).toEqual({ base_url: fake!.url, bot_id: 'bot_cskh', max_runs_day: 500 });
    expect(cfg.persona).toContain('Bot CSKH');

    // stored encrypted
    const row = deps.db.prepare("SELECT values_enc FROM integration_credentials WHERE integration_id = 'genbot-key:bot-cskh'").get() as { values_enc: string };
    expect(row.values_enc.startsWith('v1:')).toBe(true);
    expect(row.values_enc).not.toContain(KEY);

    // the adapter reads the stored key: a check sends it as the bearer, and records the result
    const check = await call('POST', '/api/genbot/bots/bot-cskh/check');
    expect(check.body.summary.ok).toBe(true);
    expect(fake!.requests.at(-1)!.headers.authorization).toBe(`Bearer ${KEY}`);
    const listed = await call('GET', '/api/genbot');
    expect(listed.body.bots[0].lastCheck).toMatchObject({ ok: true });
    // and a real run through the registry's runtime uses it too
    const runReq = { ...(await import('../runtimes/probe.js')).probeRequest(h.root, 'genbot') };
    const res = await deps.runtimes.get('genbot').run({ ...runReq, agent: deps.agents.require('bot-cskh'), prompt: 'Còn hàng không?' });
    expect(res).toMatchObject({ ok: true, output: 'pong' });

    // no API response carries it
    const responses = [probe.text, created.text, check.text, listed.text, (await call('GET', '/api/agents')).text, (await call('GET', '/api/agents/bot-cskh')).text, (await call('GET', '/api/agents/bot-cskh/access')).text];
    const agentsList = JSON.parse(responses[4]!) as { items: { id: string; genbotKey?: unknown }[] };
    expect(agentsList.items.find((a) => a.id === 'bot-cskh')!.genbotKey).toEqual({ hasKey: true, last4: 'WXYZ' });

    // rotate
    const rotated = await call('PUT', '/api/genbot/bots/bot-cskh/key', { key: KEY2 });
    expect(rotated.body.key).toMatchObject({ hasKey: true, last4: 'QQQQ' });
    expect(genbotKeysFor(deps).get('bot-cskh')).toBe(KEY2);
    responses.push(rotated.text);

    // never in a response, the agent files, the audit log, kv, any event or any log line
    const seen = everythingVisible(responses);
    expect(seen).not.toContain(KEY);
    expect(seen).not.toContain(KEY2);

    // delete removes the agent and its key
    expect((await call('DELETE', '/api/genbot/bots/bot-cskh')).body).toEqual({ ok: true });
    expect(deps.agents.get('bot-cskh')).toBeUndefined();
    expect(deps.db.prepare("SELECT COUNT(*) AS n FROM integration_credentials WHERE integration_id LIKE 'genbot-key:%'").get()).toEqual({ n: 0 });
  });

  it('edit, pause, a bad key and a bad bot id are refused in Vietnamese; deleting through /api/agents also drops the key', async () => {
    const created = await call('POST', '/api/genbot/bots', { name: 'Bot Nội dung', botId: '', template: 'noi-dung' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ id: 'bot-noi-dung', connected: false, key: { hasKey: false }, context: 'standard' });
    expect((await call('PUT', '/api/genbot/bots/bot-noi-dung', { botId: 'has space' })).status).toBe(400);
    expect((await call('PUT', '/api/genbot/bots/bot-noi-dung', { baseUrl: 'http://192.168.1.5:8800' })).body.error.message).toMatch(/https/);
    const edited = await call('PUT', '/api/genbot/bots/bot-noi-dung', { botId: 'bot_nd', maxRunsDay: 200, role: 'Viết bài' });
    expect(edited.body).toMatchObject({ botId: 'bot_nd', maxRunsDay: 200, role: 'Viết bài' });
    const badKey = await call('PUT', '/api/genbot/bots/bot-noi-dung/key', { key: 'short' });
    expect(badKey.status).toBe(400);
    expect(badKey.body.error.message).toMatch(/không hợp lệ/);
    expect((await call('POST', '/api/genbot/bots/bot-noi-dung/pause', { paused: true })).body.enabled).toBe(false);
    expect((await call('POST', '/api/genbot/bots/bot-noi-dung/pause', { paused: false })).body.enabled).toBe(true);
    await call('PUT', '/api/genbot/bots/bot-noi-dung/key', { key: KEY });
    expect((await call('DELETE', '/api/agents/bot-noi-dung')).body).toEqual({ ok: true });
    expect(genbotKeysFor(deps).get('bot-noi-dung')).toBeUndefined();
  });

  it('moves a legacy agent to GenBot only when the owner asks, keeping its other settings', async () => {
    expect(deps.agents.require('old-claude').runtime).toBe('claude');
    const moved = await call('POST', '/api/genbot/bots/old-claude/convert');
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ id: 'old-claude', name: 'Trợ lý cũ', botId: '', connected: false });
    const cfg = deps.agents.require('old-claude');
    expect(cfg).toMatchObject({ runtime: 'genbot', runtimeOptions: { base_url: 'http://127.0.0.1:8800', bot_id: '' } });
    expect(cfg.model).toBeUndefined();
    expect((await call('GET', '/api/genbot')).body.legacy).toEqual([]);
  });

  it('every route that sets a key, an address or a bot id is owner only', async () => {
    await call('POST', '/api/genbot/bots', { name: 'Bot Trợ lý', template: 'tro-ly' });
    const anon = {};
    for (const [m, u, b] of [
      ['POST', '/api/genbot/bots', { name: 'X', template: 'cskh', key: KEY }],
      ['PUT', '/api/genbot/bots/bot-tro-ly', { botId: 'b2' }],
      ['PUT', '/api/genbot/bots/bot-tro-ly/key', { key: KEY }],
      ['DELETE', '/api/genbot/bots/bot-tro-ly/key', undefined],
      ['POST', '/api/genbot/bots/bot-tro-ly/check', undefined],
      ['POST', '/api/genbot/bots/bot-tro-ly/pause', { paused: true }],
      ['DELETE', '/api/genbot/bots/bot-tro-ly', undefined],
      ['POST', '/api/genbot/bots/old-claude/convert', undefined],
      ['PUT', '/api/genbot/connection', { baseUrl: 'https://evil.example' }],
      ['POST', '/api/genbot/connection/check', {}],
      ['POST', '/api/genbot/probe', { botId: 'b', key: KEY }],
      ['POST', '/api/runtimes/genbot/check', { agentId: 'bot-tro-ly', runtimeOptions: { base_url: 'https://evil.example' } }],
    ] as const) {
      expect((await call(m, u, b, anon)).status, `${m} ${u}`).toBe(401); // owner refusal (OWNER_HEADER set)
    }
    expect(genbotKeysFor(deps).get('bot-tro-ly')).toBeUndefined();
    expect(deps.agents.require('bot-tro-ly').runtimeOptions.bot_id).toBe('');
    // reads stay open
    expect((await call('GET', '/api/genbot', undefined, anon)).status).toBe(200);
  });

  it('the connection setting can be applied to every bot', async () => {
    await call('POST', '/api/genbot/bots', { name: 'Bot CSKH', template: 'cskh' });
    const r = await call('PUT', '/api/genbot/connection', { baseUrl: 'https://genbot.shop.vn/', applyToAll: true });
    expect(r.body).toMatchObject({ baseUrl: 'https://genbot.shop.vn', updated: 1 });
    expect(deps.agents.require('bot-cskh').runtimeOptions.base_url).toBe('https://genbot.shop.vn');
    expect((await call('PUT', '/api/genbot/connection', { baseUrl: 'http://10.0.0.2:8800' })).status).toBe(400);
  });
});
