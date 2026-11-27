import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs fixture without types
import { FAKE_GENBOT_KEY, startFakeGenbot } from '../../test-fixtures/runtimes/fake-genbot.mjs';
import { buildMessage, checkGenbotAgent, createBotGate, createGenbotRuntime, GENBOT_CAPABILITIES, GENBOT_MAX_MESSAGE_CHARS, GENBOT_RATE_LIMIT, readGenbotConfig, type GenbotRuntimeOptions } from './genbot.js';
import type { RunResult } from './contracts.js';
import { makeReq, tmpCwd } from './test-util.js';

interface Fake {
  url: string;
  requests: { method: string; path: string; query: Record<string, string>; headers: Record<string, string>; body: { message: string; wait: number } }[];
  aborted: unknown[];
  stats: { maxOpen: number };
  close(): Promise<void>;
}

const fakes: Fake[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((f) => f.close()));
});

async function fake(scenario: string, extra: Record<string, unknown> = {}): Promise<Fake> {
  const f = (await startFakeGenbot({ scenario, ...extra })) as Fake;
  fakes.push(f);
  return f;
}

const ENV = { GENBOT_KEY_TEST: FAKE_GENBOT_KEY };
const runtime = (opts: GenbotRuntimeOptions = {}) => createGenbotRuntime({ env: ENV, pollMs: 20, ...opts });
const options = (baseUrl: string, extra: Record<string, string> = {}) => ({ base_url: baseUrl, bot_id: 'bot_abc123', key_env: 'GENBOT_KEY_TEST', ...extra });

async function req(baseUrl: string, overrides: Parameters<typeof makeReq>[1] = {}) {
  const cwd = await tmpCwd();
  return makeReq(cwd, { tools: 'none', timeoutMs: 5_000, ...overrides, agent: { runtime: 'genbot', runtimeOptions: options(baseUrl), ...overrides.agent } });
}

/** A port nothing listens on. */
async function deadUrl(): Promise<string> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const { port } = srv.address() as { port: number };
  await new Promise<void>((r) => srv.close(() => r()));
  return `http://127.0.0.1:${port}`;
}

const keyFree = (res: unknown, events: unknown[] = []) => expect(JSON.stringify({ res, events })).not.toContain(FAKE_GENBOT_KEY);

describe('genbot capabilities, config and message', () => {
  it('declares a confined, text-only runtime: no MCP, no files, no cost, a 20,000-char request cap', () => {
    expect(GENBOT_CAPABILITIES).toMatchObject({ resume: false, systemPrompt: 'inline', reportsCost: false, images: false, documents: false, noTools: true, mcp: false, readsFiles: false, maxPromptChars: 20_000 });
    expect(GENBOT_CAPABILITIES.enforces).toMatchObject({ context: 'hard', mcp: 'hard', fileRead: 'hard', fileWrite: 'hard', shell: 'hard' });
    // the note must not oversell: GenBot's own memory and instructions are outside AIOS's brain filter
    expect(GENBOT_CAPABILITIES.enforces.note).toMatch(/bộ nhớ đã lưu trong GenBot/);
    expect(GENBOT_RATE_LIMIT).toEqual({ limit: 10, windowMs: 60_000 });
  });

  it('buildMessage joins system prompt and prompt, and refuses (never cuts) a message over 20,000 chars', () => {
    expect(buildMessage({ systemPrompt: 'Bạn là CSKH.', prompt: 'Khách hỏi giá' })).toEqual({ ok: true, message: 'Bạn là CSKH.\n\nKhách hỏi giá' });
    expect(buildMessage({ systemPrompt: '', prompt: 'a'.repeat(GENBOT_MAX_MESSAGE_CHARS) }).ok).toBe(true);
    const over = buildMessage({ systemPrompt: '', prompt: 'a'.repeat(GENBOT_MAX_MESSAGE_CHARS + 1) });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toMatchObject({ family: 'config', message: expect.stringContaining('20.001') });
  });

  it('readGenbotConfig names every missing value', () => {
    const r = readGenbotConfig({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join(' ')).toMatch(/base_url[\s\S]*bot_id/);
    // key_env is optional now (the key is pasted in the app); when given it must still be a GENBOT_KEY_* name
    if (!r.ok) expect(r.problems.join(' ')).not.toMatch(/key_env/);
    expect(readGenbotConfig({ base_url: 'http://127.0.0.1:8800/', bot_id: 'b', key_env: 'GENBOT_KEY_A' })).toEqual({ ok: true, config: { baseUrl: 'http://127.0.0.1:8800', botId: 'b', keyEnv: 'GENBOT_KEY_A' } });
    expect(readGenbotConfig({ base_url: 'http://127.0.0.1:8800/', bot_id: 'b' })).toEqual({ ok: true, config: { baseUrl: 'http://127.0.0.1:8800', botId: 'b' } });
    expect(readGenbotConfig({ base_url: 'http://127.0.0.1:8800/', bot_id: 'b', key_env: 'OPENAI_API_KEY' }).ok).toBe(false);
  });

  it.each([
    ['http://127.0.0.1:8800', true],
    ['http://localhost:8800', true],
    ['http://[::1]:8800', true],
    ['https://genbot.shop.vn', true],
    ['https://genbot.shop.vn/base', true],
    ['http://genbot.shop.vn', false],
    ['http://192.168.1.10:8800', false],
    ['ftp://127.0.0.1', false],
    ['https://user:pw@genbot.shop.vn', false],
    ['https://genbot.shop.vn/?x=1', false],
  ])('transport: %s allowed=%s', (url, allowed) => {
    expect(readGenbotConfig({ base_url: url, bot_id: 'b', key_env: 'GENBOT_KEY_A' }).ok).toBe(allowed);
  });

  it('key_env must be a GENBOT_KEY_* name, and a key pasted there is never echoed', () => {
    for (const bad of ['OPENAI_API_KEY', 'COMPOSIO_API_KEY', 'genbot_key_a', 'gbk-abc.def']) {
      const r = readGenbotConfig({ base_url: 'http://127.0.0.1:1', bot_id: 'b', key_env: bad });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.problems.join(' ')).not.toContain(bad);
    }
  });
});

describe('genbot run', () => {
  it('200: ok with the reply as output, no usage, three status events, wait capped at 50 s', async () => {
    const f = await fake('ok');
    const r = await req(f.url, { systemPrompt: 'Bạn là CSKH.', prompt: 'Khách hỏi giá', timeoutMs: 600_000 });
    const res = await runtime().run(r);
    expect(res).toMatchObject({ ok: true, output: 'Dạ, shop chào chị ạ.' });
    expect(res.usage).toBeUndefined();
    expect(f.requests).toHaveLength(1);
    const sent = f.requests[0]!;
    expect(sent.method).toBe('POST');
    expect(sent.path).toBe('/hooks/api/bots/bot_abc123/messages');
    expect(sent.headers.authorization).toBe(`Bearer ${FAKE_GENBOT_KEY}`);
    expect(sent.body).toEqual({ message: 'Bạn là CSKH.\n\nKhách hỏi giá', wait: 50 });
    expect(r.events.filter((e) => e.type === 'status').map((e) => (e as { message: string }).message)).toEqual(['Đã gửi tin tới GenBot (bot bot_abc123).', 'Đang chờ GenBot trả lời…', 'Đã nhận trả lời từ GenBot.']);
    keyFree(res, r.events);
  });

  it('wait is min(50, timeoutMs in seconds)', async () => {
    const f = await fake('ok');
    await runtime().run(await req(f.url, { timeoutMs: 20_000 }));
    expect(f.requests[0]!.body.wait).toBe(20);
  });

  it('202 working, then the thread read answers: ok, GETs carry the key and the thread id', async () => {
    const f = await fake('working', { workingPolls: 2 });
    const res = await runtime().run(await req(f.url));
    expect(res).toMatchObject({ ok: true, output: 'Dạ, shop chào chị ạ.' });
    const gets = f.requests.filter((q) => q.method === 'GET');
    expect(gets).toHaveLength(3);
    expect(gets[0]!.query).toEqual({ thread: 't1' });
    expect(gets[0]!.headers.authorization).toBe(`Bearer ${FAKE_GENBOT_KEY}`);
    expect(f.requests.filter((q) => q.method === 'POST')).toHaveLength(1);
  });

  it('202 working until the time is up: timeout, and the POST is never sent again', async () => {
    const f = await fake('working-forever');
    const res = await runtime().run(await req(f.url, { timeoutMs: 1_200 }));
    expect(res.error?.family).toBe('timeout');
    expect(f.requests.filter((q) => q.method === 'POST')).toHaveLength(1);
  });

  it('202 needs_approval: access, naming the thread so the owner can open it in GenBot', async () => {
    const f = await fake('approval');
    const res = await runtime().run(await req(f.url));
    expect(res.error?.family).toBe('access');
    expect(res.error?.message).toContain('đang chờ bạn duyệt trong app GenBot');
    expect(res.error?.message).toContain('t1');
  });

  it('200 with an empty reply is not success', async () => {
    const f = await fake('empty');
    const res = await runtime().run(await req(f.url));
    expect(res.ok).toBe(false);
    expect(res.error?.family).toBe('unknown');
  });

  it('a GET that reads an empty reply (turn failed after the 202) is not success', async () => {
    const f = await fake('working-empty');
    const res = await runtime().run(await req(f.url));
    expect(res.ok).toBe(false);
    expect(res.error?.family).toBe('unknown');
  });

  it('thread gone (404 on the GET): config with clearSession, and polling stops', async () => {
    const f = await fake('working-gone');
    const res = await runtime().run(await req(f.url));
    expect(res).toMatchObject({ ok: false, clearSession: true, error: { family: 'config' } });
    expect(f.requests.filter((q) => q.method === 'GET')).toHaveLength(2);
  });

  it('a redirect is not followed (the key would go with it): config', async () => {
    const f = await fake('redirect');
    const res = await runtime().run(await req(f.url));
    expect(res.error?.family).toBe('config');
    expect(res.error?.message).toContain('302');
    expect(f.requests).toHaveLength(1);
  });

  it.each([
    [401, 'auth'],
    [403, 'config'],
    [400, 'config'],
    [413, 'config'],
    [415, 'config'],
    [404, 'config'],
    [409, 'transient'],
    [502, 'unknown'],
  ])('HTTP %i: %s', async (status, family) => {
    const f = await fake(`status:${status}`);
    const r = await req(f.url);
    const res = await runtime().run(r);
    expect(res.ok).toBe(false);
    expect(res.error?.family).toBe(family);
    expect(res.error?.message).toContain(String(status));
    keyFree(res, r.events);
  });

  it('a wrong key gets auth and is not echoed', async () => {
    const f = await fake('ok');
    const res = await createGenbotRuntime({ env: { GENBOT_KEY_TEST: 'gbk_wrong_key_0000000000' } }).run(await req(f.url));
    expect(res.error?.family).toBe('auth');
    expect(res.error?.message).not.toContain('gbk_wrong_key_0000000000');
  });

  it('HTTP 429: quota with retryAfter about a minute later', async () => {
    const f = await fake('status:429');
    const before = Date.now();
    const res = await runtime().run(await req(f.url));
    expect(res.error?.family).toBe('quota');
    const at = Date.parse(res.error?.retryAfter ?? '');
    expect(at - before).toBeGreaterThanOrEqual(59_000);
    expect(at - before).toBeLessThan(62_000);
  });

  it('server not listening: transient', async () => {
    const r = await req(await deadUrl());
    const res = await runtime().run(r);
    expect(res.error?.family).toBe('transient');
    keyFree(res, r.events);
  });

  it('cancel mid-call: cancelled, the HTTP request is really closed, and nothing is re-sent', async () => {
    const f = await fake('hang');
    const ctl = new AbortController();
    const pending = runtime().run(await req(f.url, { signal: ctl.signal }));
    await new Promise((r) => setTimeout(r, 150));
    expect(f.requests).toHaveLength(1);
    ctl.abort();
    const res = await pending;
    expect(res.error?.family).toBe('cancelled');
    await new Promise((r) => setTimeout(r, 100));
    expect(f.aborted).toHaveLength(1);
    expect(f.requests).toHaveLength(1);
  });

  it('prompt of 20,001 chars: config, and no HTTP request is sent', async () => {
    const f = await fake('ok');
    const res = await runtime().run(await req(f.url, { systemPrompt: '', prompt: 'x'.repeat(20_001) }));
    expect(res.error?.family).toBe('config');
    expect(res.error?.message).toContain('20.001');
    expect(f.requests).toHaveLength(0);
  });

  it('missing bot_id: config, no request', async () => {
    const f = await fake('ok');
    const res = await runtime().run(await req(f.url, { agent: { runtime: 'genbot', runtimeOptions: { base_url: f.url, key_env: 'GENBOT_KEY_TEST' } } }));
    expect(res.error?.family).toBe('config');
    expect(res.error?.message).toContain('bot_id');
    expect(f.requests).toHaveLength(0);
  });

  it('plain http to another machine: config, no request', async () => {
    const res = await runtime().run(await req('http://genbot.example.test:8800'));
    expect(res.error?.family).toBe('config');
    expect(res.error?.message).toContain('https://');
  });

  it('key_env pointing at an empty variable: config, naming the variable only', async () => {
    const f = await fake('ok');
    const res = await createGenbotRuntime({ env: {} }).run(await req(f.url));
    expect(res.error?.family).toBe('config');
    expect(res.error?.message).toContain('GENBOT_KEY_TEST');
    expect(f.requests).toHaveLength(0);
  });

  it('the key never shows in any returned string, even when GenBot echoes it', async () => {
    const f = await fake('ok', { reply: `khoá của bạn là ${FAKE_GENBOT_KEY}` });
    const r = await req(f.url);
    const res = await runtime().run(r);
    expect(res.ok).toBe(true);
    keyFree(res, r.events);
    const e = await fake('status:400');
    const r2 = await req(e.url);
    keyFree(await runtime().run(r2), r2.events);
  });
});

describe('genbot per-bot gate', () => {
  it('the 11th call in a window waits for a free slot', async () => {
    const f = await fake('ok');
    const windowMs = 700;
    const rt = runtime({ gate: createBotGate({ limit: 10, windowMs }) });
    const start = Date.now();
    for (let i = 0; i < 10; i++) expect((await rt.run(await req(f.url))).ok).toBe(true);
    const res = await rt.run(await req(f.url));
    expect(res.ok).toBe(true);
    expect(f.requests).toHaveLength(11);
    expect(Date.now() - start).toBeGreaterThanOrEqual(windowMs - 20);
  });

  it('a wait past timeoutMs gives quota with retryAfter and sends nothing', async () => {
    const f = await fake('ok');
    const rt = runtime();
    for (let i = 0; i < 10; i++) await rt.run(await req(f.url));
    const res = await rt.run(await req(f.url, { timeoutMs: 1_000 }));
    expect(res.error?.family).toBe('quota');
    expect(Date.parse(res.error?.retryAfter ?? '')).toBeGreaterThan(Date.now() + 50_000);
    expect(f.requests).toHaveLength(10);
  });

  it('the window is per bot (base_url + bot_id), not per env name', async () => {
    const f = await fake('ok');
    const rt = createGenbotRuntime({ env: { GENBOT_KEY_TEST: FAKE_GENBOT_KEY, GENBOT_KEY_SAME_BOT: FAKE_GENBOT_KEY } });
    for (let i = 0; i < 10; i++) await rt.run(await req(f.url));
    // a second env name for the same bot does not get ten more calls
    const sameBot = await rt.run(await req(f.url, { timeoutMs: 1_000, agent: { runtime: 'genbot', runtimeOptions: options(f.url, { key_env: 'GENBOT_KEY_SAME_BOT' }) } }));
    expect(sameBot.error?.family).toBe('quota');
    // another bot on the same GenBot is not held back
    const otherBot = await rt.run(await req(f.url, { timeoutMs: 1_000, agent: { runtime: 'genbot', runtimeOptions: options(f.url, { bot_id: 'bot_x' }) } }));
    expect(otherBot.ok).toBe(true);
  });

  it('caps turns open at once per bot', async () => {
    const f = await fake('slow:150');
    const rt = runtime({ gate: createBotGate({ concurrency: 2 }) });
    const results = await Promise.all(Array.from({ length: 5 }, async () => rt.run(await req(f.url))));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(f.stats.maxOpen).toBe(2);
  });

  it('a turn that cannot get a concurrency slot in time: timeout, nothing sent', async () => {
    const f = await fake('hang');
    const rt = runtime({ gate: createBotGate({ concurrency: 1 }) });
    const ctl = new AbortController();
    const first = rt.run(await req(f.url, { signal: ctl.signal }));
    await new Promise((r) => setTimeout(r, 50));
    const second = await rt.run(await req(f.url, { timeoutMs: 300 }));
    expect(second.error?.family).toBe('timeout');
    expect(f.requests).toHaveLength(1);
    ctl.abort();
    await first;
  });

  it('the gate waits with a fake clock and stops when aborted', async () => {
    let t = 0;
    const gate = createBotGate({ limit: 1, windowMs: 60_000, now: () => t });
    const ctl = new AbortController();
    const a = await gate.acquire('K', 1_000, ctl.signal);
    expect(a.ok).toBe(true);
    if (a.ok) a.release();
    expect(await gate.acquire('K', 1_000, ctl.signal)).toEqual({ ok: false, reason: 'rate', retryAt: 60_000 });
    t = 60_001;
    expect((await gate.acquire('K', 70_000, ctl.signal)).ok).toBe(true);
    ctl.abort();
    expect(await gate.acquire('K', 200_000, ctl.signal)).toEqual({ ok: false, reason: 'aborted' });
  });
});

describe('genbot doctor and per-agent check', () => {
  it('Runtime.doctor stays generic: info only, pass, no request', async () => {
    const rep = await runtime().doctor({ probe: true });
    expect(rep.status).toBe('pass');
    expect(rep.checks.map((c) => c.code)).toEqual(['genbot.http']);
  });

  it('checkGenbotAgent checks config, key and connection without sending a message', async () => {
    const f = await fake('ok');
    const rep = await checkGenbotAgent(runtime(), { runtimeOptions: options(f.url) }, { env: ENV });
    expect(rep.status).toBe('pass');
    expect(rep.checks.map((c) => c.code)).toEqual(['genbot.config', 'genbot.key', 'genbot.connect']);
    expect(f.requests).toHaveLength(0);
    keyFree(rep);
  });

  it('checkGenbotAgent flags missing values, a missing key and a dead address', async () => {
    const missing = await checkGenbotAgent(runtime(), { runtimeOptions: { base_url: 'http://127.0.0.1:1' } }, { env: ENV });
    expect(missing.status).toBe('fail');
    const dead = await checkGenbotAgent(runtime(), { runtimeOptions: options(await deadUrl()) }, { env: {} });
    expect(dead.status).toBe('fail');
    expect(dead.checks.find((c) => c.code === 'genbot.key')?.level).toBe('error');
    expect(dead.checks.find((c) => c.code === 'genbot.connect')?.level).toBe('error');
  });

  it('probe sends one real message and needs a reply', async () => {
    const f = await fake('ok');
    const ok = await checkGenbotAgent(runtime(), { runtimeOptions: options(f.url) }, { probe: true, env: ENV });
    expect(ok.checks.find((c) => c.code === 'genbot.probe')?.level).toBe('info');
    expect(f.requests).toHaveLength(1);
    const g = await fake('approval');
    const bad = await checkGenbotAgent(runtime(), { runtimeOptions: options(g.url) }, { probe: true, env: ENV });
    expect(bad.status).toBe('fail');
  });
});

describe('genbot result typing', () => {
  it('never fills usage with zeros', async () => {
    const f = await fake('ok');
    const res: RunResult = await runtime().run(await req(f.url));
    expect('usage' in res).toBe(false);
  });
});
