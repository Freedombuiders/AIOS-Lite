// The GenBot key in .env is core-only: no CLI child, connection or module secret lookup may see it, and its value is masked.
import { readFile } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../agents/registry.js';
import { createConnectionsService } from '../access/connections.js';
import { redactString } from '../core/redact.js';
import { isProtectedEnvName, protectEnvName } from '../core/secret-env.js';
import { testLog, tmpDir, writeFile } from '../shared/test-kit.js';
import { createClaudeRuntime } from './claude.js';
import { createCodexRuntime } from './codex.js';
import { buildChildEnv } from './shared.js';
import { fixture, makeReq, tmpCwd } from './test-util.js';

const KEY = 'gbk_live_key_value_abcdef0123456789';
const touched: string[] = [];
const setEnv = (k: string, v: string) => {
  process.env[k] = v;
  touched.push(k);
};
afterEach(() => {
  for (const k of touched.splice(0)) delete process.env[k];
});

describe('core-only credentials', () => {
  it('GENBOT_KEY_* is protected by name; other names once registered', () => {
    expect(isProtectedEnvName('GENBOT_KEY_CSKH')).toBe(true);
    expect(isProtectedEnvName('BOTKEY_SHOP_A')).toBe(false);
    protectEnvName('BOTKEY_SHOP_A', {});
    expect(isProtectedEnvName('BOTKEY_SHOP_A')).toBe(true);
  });

  it('buildChildEnv drops them from every layer: base, extra, adapter and granted vars', () => {
    protectEnvName('BOTKEY_LAYER', {});
    const env = buildChildEnv({
      base: { PATH: '/bin', GENBOT_KEY_CSKH: KEY, BOTKEY_LAYER: KEY },
      extra: { GENBOT_KEY_EXTRA: KEY, EXTRA_OK: '1' },
      adapter: { GENBOT_KEY_ADAPTER: KEY },
      envVars: { GENBOT_KEY_GRANTED: KEY, BOTKEY_LAYER: KEY, GH: 'x' },
    });
    expect(Object.keys(env).sort()).toEqual(['EXTRA_OK', 'GH', 'PATH']);
  });

  it('registering a name masks its value in logs, errors and events', () => {
    protectEnvName('BOTKEY_MASK', { BOTKEY_MASK: KEY });
    expect(redactString(`lỗi: khoá ${KEY} sai`)).toBe('lỗi: khoá [redacted] sai');
  });

  it('loading an agent registers its key_env', () => {
    const root = tmpDir();
    writeFile(path.join(root, 'agents/cskh/agent.yaml'), 'name: CSKH\nruntime: genbot\nruntime_options:\n  base_url: http://127.0.0.1:8800\n  bot_id: b1\n  key_env: BOTKEY_FROM_AGENT\n');
    fs.mkdirSync(path.join(root, 'workspaces'), { recursive: true });
    expect(isProtectedEnvName('BOTKEY_FROM_AGENT')).toBe(false);
    createAgentRegistry({ agentsDir: path.join(root, 'agents'), workspacesDir: path.join(root, 'workspaces') });
    expect(isProtectedEnvName('BOTKEY_FROM_AGENT')).toBe(true);
  });

  it('a fake Claude CLI child does not see the key, even when granted or passed as extra env', async () => {
    setEnv('GENBOT_KEY_CSKH', KEY);
    setEnv('BOTKEY_CHILD', KEY);
    protectEnvName('BOTKEY_CHILD');
    const cwd = await tmpCwd();
    const rec = path.join(cwd, 'rec.jsonl');
    const rt = createClaudeRuntime(fixture('fake-claude.mjs'), { FAKE_SCENARIO: 'ok', FAKE_RECORD: rec, GENBOT_KEY_OTHER: KEY, EXTRA_VISIBLE: 'yes' });
    const res = await rt.run(makeReq(cwd, { access: { envVars: { GENBOT_KEY_CSKH: KEY, GRANTED_OK: 'v' } } }));
    expect(res.ok).toBe(true);
    const r = JSON.parse((await readFile(rec, 'utf8')).trim()) as { env: Record<string, string> };
    expect(r.env.EXTRA_VISIBLE).toBe('yes');
    expect(r.env.GRANTED_OK).toBe('v');
    expect(Object.keys(r.env).filter((k) => k.startsWith('GENBOT_') || k.startsWith('BOTKEY_'))).toEqual([]);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it('a fake Codex CLI child does not see the key either', async () => {
    setEnv('GENBOT_KEY_CSKH', KEY);
    const cwd = await tmpCwd();
    const rec = path.join(cwd, 'rec.jsonl');
    await createCodexRuntime(fixture('fake-codex.mjs'), { FAKE_SCENARIO: 'ok', FAKE_RECORD: rec }).run(makeReq(cwd));
    const line = (await readFile(rec, 'utf8')).trim().split('\n')[0]!;
    expect(line).not.toContain(KEY);
    expect(line).not.toContain('GENBOT_KEY_CSKH');
  });

  it('connections cannot copy the key under another name, and modules cannot read it as a secret', () => {
    const dir = tmpDir();
    writeFile(path.join(dir, 'c.yaml'), 'connections:\n  - { id: sneaky, type: env, env: { MY_VAR: $GENBOT_KEY_CSKH } }\n');
    const c = createConnectionsService({ file: path.join(dir, 'c.yaml'), envFile: path.join(dir, '.env'), log: testLog, env: { GENBOT_KEY_CSKH: KEY, OK_VAR: 'ok' } });
    expect(c.resolveEnv(c.get('sneaky')!)).toEqual({ MY_VAR: '' });
    expect(c.secret('GENBOT_KEY_CSKH')).toBeUndefined();
    expect(c.secret('OK_VAR')).toBe('ok');
  });
});
