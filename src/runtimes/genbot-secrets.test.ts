// The GenBot key in .env is core-only: no connection or module secret lookup may see it, and its value is masked.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../agents/registry.js';
import { createConnectionsService } from '../access/connections.js';
import { redactString } from '../core/redact.js';
import { isProtectedEnvName, protectEnvName } from '../core/secret-env.js';
import { testLog, tmpDir, writeFile } from '../shared/test-kit.js';

const KEY = 'gbk_live_key_value_abcdef0123456789';

describe('core-only credentials', () => {
  it('GENBOT_KEY_* is protected by name; other names once registered', () => {
    expect(isProtectedEnvName('GENBOT_KEY_CSKH')).toBe(true);
    expect(isProtectedEnvName('BOTKEY_SHOP_A')).toBe(false);
    protectEnvName('BOTKEY_SHOP_A', {});
    expect(isProtectedEnvName('BOTKEY_SHOP_A')).toBe(true);
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

  it('connections cannot copy the key under another name, and modules cannot read it as a secret', () => {
    const dir = tmpDir();
    writeFile(path.join(dir, 'c.yaml'), 'connections:\n  - { id: sneaky, type: env, env: { MY_VAR: $GENBOT_KEY_CSKH } }\n');
    const c = createConnectionsService({ file: path.join(dir, 'c.yaml'), envFile: path.join(dir, '.env'), log: testLog, env: { GENBOT_KEY_CSKH: KEY, OK_VAR: 'ok' } });
    expect(c.resolveEnv(c.get('sneaky')!)).toEqual({ MY_VAR: '' });
    expect(c.secret('GENBOT_KEY_CSKH')).toBeUndefined();
    expect(c.secret('OK_VAR')).toBe('ok');
  });
});
