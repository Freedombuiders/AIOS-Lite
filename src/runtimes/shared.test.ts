import { mkdir, mkdtemp, readdir, stat, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildChildEnv, classifyMessage, createRunDir, findBinary } from './shared.js';

describe('buildChildEnv', () => {
  const base = {
    PATH: '/bin',
    HOME: '/h',
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SESSION: 's',
    CLAUDE_CODE_PARENT_SESSION: 'p',
    CLAUDE_CODE_SSE_PORT: '123',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
    AIOS_TOKEN: 't',
    AIOS_ENCRYPTION_KEY: 'k',
    COMPOSIO_API_KEY: 'c',
    OTHER_SECRET: 'keep-me',
    AIOS_STRIP_ENV: 'OTHER_SECRET2, X',
    OTHER_SECRET2: 'strip-me',
  };

  it('strips nested-session markers and AIOS secrets', () => {
    const env = buildChildEnv({ base });
    expect(Object.keys(env).filter((k) => k.startsWith('CLAUDE'))).toEqual(['CLAUDE_CODE_OAUTH_TOKEN']);
    for (const k of ['AIOS_TOKEN', 'AIOS_ENCRYPTION_KEY', 'COMPOSIO_API_KEY', 'OTHER_SECRET2']) expect(env[k]).toBeUndefined();
    expect(env.PATH).toBe('/bin');
    expect(env.OTHER_SECRET).toBe('keep-me');
  });

  it('adds granted vars last (an agent may be granted a stripped name explicitly)', () => {
    const env = buildChildEnv({ base, envVars: { COMPOSIO_API_KEY: 'granted', GH: 'x' }, extra: { HOME: '/x' }, adapter: { A: '1' } });
    expect(env.COMPOSIO_API_KEY).toBe('granted');
    expect(env.GH).toBe('x');
    expect(env.HOME).toBe('/x');
    expect(env.A).toBe('1');
  });
});

describe('classifyMessage', () => {
  it.each([
    ['Invalid API key · Please run /login', 'auth'],
    ['You exceeded your current quota', 'quota'],
    ["You've hit your usage limit", 'quota'],
    ['Overloaded, try again', 'transient'],
    ['something odd', 'unknown'],
  ])('%s -> %s', (m, family) => expect(classifyMessage(m)).toBe(family));
});

describe('createRunDir', () => {
  it('creates a private dir under .aios and removes it', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'aios-rd-'));
    const rd = await createRunDir(cwd);
    expect(path.dirname(rd.dir)).toBe(path.join(cwd, '.aios'));
    const f = await rd.write('x.json', '{}');
    expect((await stat(f)).mode & 0o777).toBe(0o600);
    await rd.cleanup();
    expect(await readdir(path.join(cwd, '.aios'))).toEqual([]);
  });
});

describe('findBinary', () => {
  it('finds names on PATH and absolute paths, and returns undefined otherwise', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aios-bin-'));
    await mkdir(dir, { recursive: true });
    const bin = path.join(dir, 'mytool');
    await writeFile(bin, '#!/bin/sh\n');
    await chmod(bin, 0o755);
    expect(await findBinary('mytool', dir)).toBe(bin);
    expect(await findBinary(bin)).toBe(bin);
    expect(await findBinary('definitely-not-installed-xyz', dir)).toBeUndefined();
  });
});
