// GenBot keys pasted in the app: encrypted at rest, masked everywhere, never in a child environment.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCipher } from '../core/crypto.js';
import { migrateCore, openDb } from '../core/db.js';
import { redactString } from '../core/redact.js';
import { createClaudeRuntime } from '../runtimes/claude.js';
import { buildChildEnv } from '../runtimes/shared.js';
import { fixture, makeReq, tmpCwd } from '../runtimes/test-util.js';
import { tmpDir } from '../shared/test-kit.js';
import { createGenbotKeyStore, validateGenbotKey } from './genbot-keys.js';

const KEY = 'gbk_store_test_key_0123456789abcdef';

function freshStore(secret = 'enc-secret') {
  const db = openDb(path.join(tmpDir(), 'aios.db'));
  migrateCore(db);
  return { db, store: createGenbotKeyStore({ db, cipher: createCipher(secret) }) };
}

describe('genbot key store', () => {
  it('stores the key encrypted, by agent id; status shows only that a key exists and its last four characters', () => {
    const { db, store } = freshStore();
    expect(store.status('bot-cskh')).toEqual({ hasKey: false, last4: '', updatedAt: null });
    const s = store.set('bot-cskh', `  ${KEY}  `);
    expect(s).toMatchObject({ hasKey: true, last4: 'cdef' });
    expect(JSON.stringify(s)).not.toContain(KEY);
    const row = db.prepare("SELECT values_enc FROM integration_credentials WHERE integration_id = 'genbot-key:bot-cskh'").get() as { values_enc: string };
    expect(row.values_enc.startsWith('v1:')).toBe(true);
    expect(row.values_enc).not.toContain(KEY);
    expect(store.get('bot-cskh')).toBe(KEY);
    expect(store.get('other')).toBeUndefined();
    // a different encryption key cannot read it back
    expect(createGenbotKeyStore({ db, cipher: createCipher('another-secret') }).get('bot-cskh')).toBeUndefined();
  });

  it('rotating replaces the key; removing deletes it', () => {
    const { store } = freshStore();
    store.set('b', KEY);
    store.set('b', 'gbk_rotated_key_value_zzzz9999');
    expect(store.get('b')).toBe('gbk_rotated_key_value_zzzz9999');
    expect(store.status('b').last4).toBe('9999');
    store.remove('b');
    expect(store.get('b')).toBeUndefined();
    expect(store.status('b').hasKey).toBe(false);
  });

  it('refuses an empty or malformed key without echoing it', () => {
    expect(() => validateGenbotKey('')).toThrow('Chưa dán khoá');
    const bad = 'has space inside the key value';
    try {
      validateGenbotKey(bad);
      throw new Error('should fail');
    } catch (e) {
      expect((e as Error).message).toMatch(/không hợp lệ/);
      expect((e as Error).message).not.toContain(bad);
    }
  });

  it('a stored key is masked in any string that reaches a log, an error or an event, from the moment it is loaded', () => {
    const { db } = freshStore('boot-secret');
    const key = 'gbk_loaded_at_boot_value_4567wxyz';
    createGenbotKeyStore({ db, cipher: createCipher('boot-secret') }).set('b', key);
    // a new process: protectAll at boot registers every stored key before anything runs
    const again = createGenbotKeyStore({ db, cipher: createCipher('boot-secret') });
    expect(again.protectAll()).toBe(1);
    expect(redactString(`GenBot 401 với khoá ${key}`)).toBe('GenBot 401 với khoá [redacted]');
  });

  it('is never put in a child environment: not in a granted variable, an override, nor a fake CLI child', async () => {
    const { store } = freshStore();
    const key = 'gbk_child_env_test_value_ABCD1234';
    store.set('bot-x', key);
    const env = buildChildEnv({ base: { PATH: '/bin', SOME_VAR: key }, extra: { COPY: `Bearer ${key}` }, envVars: { GRANTED: key, OK: 'v' } });
    expect(Object.keys(env).sort()).toEqual(['OK', 'PATH']);

    const cwd = await tmpCwd();
    const rec = path.join(cwd, 'rec.jsonl');
    const rt = createClaudeRuntime(fixture('fake-claude.mjs'), { FAKE_SCENARIO: 'ok', FAKE_RECORD: rec, SNEAKY: key });
    const res = await rt.run(makeReq(cwd, { access: { envVars: { GRANTED_KEY: key, GRANTED_OK: 'v' } } }));
    expect(res.ok).toBe(true);
    const r = JSON.parse((await readFile(rec, 'utf8')).trim()) as { env: Record<string, string> };
    expect(r.env.GRANTED_OK).toBe('v');
    expect(r.env.SNEAKY).toBeUndefined();
    expect(r.env.GRANTED_KEY).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain(key);
  });
});
