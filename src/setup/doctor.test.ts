import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkAgents, checkBrainGit, checkGenbot, checkNode, formatChecks, runDoctor, type DoctorEnv } from './doctor.js';
import type { Fetch } from './release.js';

const ROOT = '/repo';

interface FakeOpts {
  nodeVersion?: string;
  genbot?: { path: string; version: string } | null;
  genbotProcess?: boolean;
  genbotLog?: string;
  /** logical 127.0.0.1 ports that answer, and how */
  http?: Record<number, (pathname: string, init?: RequestInit) => Response>;
  open?: number[];
  tools?: string[];
  files?: Record<string, string>;
  dirs?: string[];
  token?: string;
  probe?: boolean;
  platform?: NodeJS.Platform;
}

function fakeEnv(o: FakeOpts = {}): DoctorEnv & { requests: string[] } {
  const requests: string[] = [];
  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    requests.push(`${init?.method ?? 'GET'} ${u.port}${u.pathname}${init?.headers && (init.headers as Record<string, string>).authorization ? ' +token' : ''}`);
    const h = o.http?.[Number(u.port)];
    if (!h) throw new TypeError('fetch failed');
    return h(u.pathname, init);
  }) as Fetch;
  const files: Record<string, string> = { [path.join(ROOT, 'package.json')]: '{"engines":{"node":">=22"}}', ...o.files };
  return {
    requests,
    platform: o.platform ?? 'darwin',
    nodeVersion: o.nodeVersion ?? 'v25.9.0',
    rootDir: ROOT,
    apiPort: 4380,
    ...(o.token ? { token: o.token } : {}),
    fetch: doFetch,
    exec: async () => ({ code: 1, stdout: '', stderr: '' }),
    portOpen: async (p) => (o.open ?? []).includes(p) || Boolean(o.http?.[p]),
    findGenbot: async () => (o.genbot === undefined ? { path: '/Applications/GenBot.app', version: '1.0.4' } : o.genbot),
    genbotRunning: async () => o.genbotProcess ?? false,
    genbotLog: () => ({ file: '/Users/a/Library/Logs/GenBot/server.log', tail: o.genbotLog ?? '' }),
    which: async (cmd) => (o.tools ?? ['yt-dlp', 'ffmpeg']).includes(cmd),
    readFile: (f) => files[f] ?? null,
    exists: (p) => Object.keys(files).includes(p) || (o.dirs ?? []).includes(p),
    home: '/Users/a',
    probe: o.probe ?? false,
  };
}

const aiosHealth = () => Response.json({ ok: true, version: '0.1.0', uptimeSec: 5 });
const genbotHealth = () => Response.json({ app: 'openmausbot' });

function bots(list: unknown[]) {
  return (pathname: string, init?: RequestInit) => {
    if (pathname === '/api/health') return aiosHealth();
    if (pathname === '/api/genbot') return Response.json({ bots: list });
    if (pathname.endsWith('/check') && init?.method === 'POST') return Response.json({ summary: { ok: pathname.includes('bot-cskh'), message: pathname.includes('bot-cskh') ? 'pong' : 'GenBot 401' } });
    return new Response('{}', { status: 404 });
  };
}

const card = (id: string, extra: object = {}) => ({ id, name: id, botId: `gb_${id}`, enabled: true, key: { hasKey: true, source: 'store' }, ...extra });

describe('node', () => {
  it('passes at or above engines, fails below with the install command', () => {
    expect(checkNode(fakeEnv()).status).toBe('ok');
    const old = checkNode(fakeEnv({ nodeVersion: 'v20.1.0' }));
    expect(old.status).toBe('fail');
    expect(old.fix).toMatch(/brew install node@22/);
    expect(checkNode(fakeEnv({ nodeVersion: 'v20.1.0', platform: 'win32' })).fix).toMatch(/winget install OpenJS\.NodeJS\.LTS/);
  });
});

describe('genbot', () => {
  it('running: harness on 8799 and Bot API on 8800', async () => {
    const r = await checkGenbot(fakeEnv({ http: { 8799: genbotHealth, 8800: () => new Response(null, { status: 404 }) } }));
    expect(r.checks.map((c) => [c.id, c.status])).toEqual([
      ['genbot.installed', 'ok'],
      ['genbot.harness', 'ok'],
      ['genbot.botapi', 'ok'],
    ]);
    expect(r.checks[0]!.message).toContain('1.0.4');
  });

  it('app open but harness down is an error with its fix', async () => {
    const r = await checkGenbot(fakeEnv({ genbotProcess: true }));
    const harness = r.checks.find((c) => c.id === 'genbot.harness')!;
    expect(harness.status).toBe('fail');
    expect(harness.fix).toMatch(/--resume/);
  });

  it('names a harness that crashes at start, from GenBot\'s own log', async () => {
    const r = await checkGenbot(fakeEnv({ genbotProcess: true, genbotLog: '[t] spawned pid=1\nError: Invalid restore recovery paths.\n[t] exited code=1\n' }));
    const harness = r.checks.find((c) => c.id === 'genbot.harness')!;
    expect(harness.message).toContain('Invalid restore recovery paths');
    expect(harness.fix).toContain('/Users/a/Library/Logs/GenBot/server.log');
  });

  it('not installed on a supported machine: fail with npm run setup; on Linux: a warning', async () => {
    expect((await checkGenbot(fakeEnv({ genbot: null }))).checks[0]).toMatchObject({ status: 'fail', fix: 'npm run setup' });
    expect((await checkGenbot(fakeEnv({ genbot: null, platform: 'linux' }))).checks[0]!.status).toBe('warn');
  });

  it('another program on 8799 is named, not taken for GenBot', async () => {
    const r = await checkGenbot(fakeEnv({ http: { 8799: () => Response.json({ ok: true }) } }));
    expect(r.checks.find((c) => c.id === 'genbot.harness')!.message).toMatch(/chương trình khác/);
  });
});

describe('agents', () => {
  it('needs the app running', async () => {
    expect((await checkAgents(fakeEnv(), false, true))[0]!.status).toBe('skip');
  });

  it('reports missing bot id and missing key without sending anything', async () => {
    const env = fakeEnv({ http: { 4380: bots([card('bot-cskh'), card('bot-noi-dung', { botId: '' }), card('bot-tro-ly', { key: { hasKey: false, source: null } })]) } });
    const out = await checkAgents(env, true, true);
    expect(out.map((c) => [c.id, c.status])).toEqual([
      ['agent.bot-cskh', 'ok'],
      ['agent.bot-noi-dung', 'warn'],
      ['agent.bot-tro-ly', 'fail'],
    ]);
    expect(out[0]!.message).toMatch(/--probe/);
    expect(env.requests.some((r) => r.startsWith('POST'))).toBe(false);
  });

  it('--probe needs the owner token; with it, each bot is checked through the owner-only route', async () => {
    const noToken = await checkAgents(fakeEnv({ probe: true, http: { 4380: bots([card('bot-cskh')]) } }), true, true);
    expect(noToken[0]).toMatchObject({ status: 'skip' });
    expect(noToken[0]!.fix).toMatch(/AIOS_TOKEN/);
    const env = fakeEnv({ probe: true, token: 't0ken', http: { 4380: bots([card('bot-cskh'), card('bot-tro-ly')]) } });
    const out = await checkAgents(env, true, true);
    expect(out.map((c) => c.status)).toEqual(['ok', 'fail']);
    expect(out[1]!.message).toMatch(/GenBot 401/);
    expect(env.requests).toContain('POST 4380/api/genbot/bots/bot-cskh/check +token');
  });
});

describe('brain git', () => {
  const yaml = `folders:\n  - id: mau\n    name: Mẫu\n    path: ./brain/mau\n  - id: vault\n    name: Vault\n    path: ~/vault\n  - id: tracked\n    name: Tracked\n    path: /data/tracked\n  - id: gone\n    name: Gone\n    path: /nowhere\n`;
  it('ok for a repo or a sample inside the app, warns with git init otherwise', () => {
    const env = fakeEnv({ files: { [path.join(ROOT, 'config', 'brain.yaml')]: yaml }, dirs: ['/repo/brain/mau', '/Users/a/vault', '/data/tracked', '/data/tracked/.git'] });
    const out = checkBrainGit(env);
    expect(out.map((c) => [c.id, c.status])).toEqual([
      ['brain.mau', 'ok'],
      ['brain.vault', 'warn'],
      ['brain.tracked', 'ok'],
      ['brain.gone', 'warn'],
    ]);
    expect(out[1]!.fix).toBe('git -C "/Users/a/vault" init');
  });
});

describe('runDoctor', () => {
  it('one line per item, a fix line under each problem, and a summary', async () => {
    const env = fakeEnv({ tools: ['ffmpeg'], http: { 4380: bots([card('bot-cskh')]), 8799: genbotHealth, 8800: () => new Response(null, { status: 404 }) }, open: [5173] });
    const checks = await runDoctor(env);
    const ids = checks.map((c) => c.id);
    expect(ids).toEqual(['node', 'port.api', 'port.web', 'genbot.installed', 'genbot.harness', 'genbot.botapi', 'agent.bot-cskh', 'tool.yt-dlp', 'tool.ffmpeg', 'brain']);
    const lines = formatChecks(checks);
    expect(lines).toContain('chú  yt-dlp: chưa có; chỉ cần cho Dream 100 (không bắt buộc)');
    expect(lines).toContain('      cách sửa: brew install yt-dlp');
    expect(lines.at(-1)).toBe('Không có lỗi, 1 lưu ý.');
  });
});
