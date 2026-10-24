import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { createCipher } from './crypto.js';
import { applyMigrations, migrateCore, openDb, tablesCreatedBy } from './db.js';
import { parseEnv, resolveEnvRefs, setEnvKey } from './env.js';
import { createEventBus } from './events.js';
import { protectValue, redactString, redactValue } from './redact.js';

describe('db', () => {
  it('applies core migrations once and supports accent-insensitive FTS', () => {
    const db = openDb(':memory:');
    expect(migrateCore(db)).toEqual(['001_core']);
    expect(migrateCore(db)).toEqual([]);
    db.prepare("INSERT INTO memories (agent_id, content) VALUES (NULL, 'Khách hàng ưu tiên báo giá VND')").run();
    const hits = db.prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'khach hang'").all();
    expect(hits).toHaveLength(1);
  });

  it('runs owner migrations in order and lists created tables', () => {
    const db = openDb(':memory:');
    const applied = applyMigrations(db, 'demo', [
      { id: '001', sql: 'CREATE TABLE demo_a (id INTEGER PRIMARY KEY);' },
      { id: '002', up: (d) => d.exec('CREATE TABLE IF NOT EXISTS demo_b (id INTEGER)') },
    ]);
    expect(applied).toEqual(['001', '002']);
    expect(tablesCreatedBy('CREATE TABLE IF NOT EXISTS "x_1" (a); create virtual table y using fts5(a);')).toEqual(['x_1', 'y']);
  });
});

describe('env + config', () => {
  it('parses, resolves refs and writes keys', () => {
    expect(parseEnv('A=1\n# c\nexport B="two words"\n')).toEqual({ A: '1', B: 'two words' });
    expect(resolveEnvRefs('x-$TOK-${TOK}', { TOK: 'k' })).toBe('x-k-k');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-env-'));
    const file = path.join(dir, '.env');
    const env: NodeJS.ProcessEnv = {};
    setEnvKey(file, 'FOO', 'bar', env);
    setEnvKey(file, 'FOO', 'baz qux', env);
    expect(parseEnv(fs.readFileSync(file, 'utf8'))).toEqual({ FOO: 'baz qux' });
    expect(env.FOO).toBe('baz qux');
  });

  it('builds config from env with defaults', () => {
    const cfg = loadConfig({ rootDir: '/tmp/aios', env: { AIOS_PORT: '5000' }, loadDotEnv: false });
    expect(cfg.port).toBe(5000);
    expect(cfg.dbPath).toBe('/tmp/aios/data/aios.db');
    expect(cfg.maxParallel).toBe(3);
  });
});

describe('crypto + redact + events', () => {
  it('round-trips encryption and passes through when disabled', () => {
    const c = createCipher('secret');
    const v = c.encrypt('xin chào');
    expect(v.startsWith('v1:')).toBe(true);
    expect(c.decrypt(v)).toBe('xin chào');
    expect(createCipher(undefined).encrypt('a')).toBe('a');
  });

  it('masks secrets', () => {
    protectValue('my-very-secret-value');
    expect(redactString('key sk-ant-abcdefghijklmnopqrstu and my-very-secret-value')).toBe('key [redacted] and [redacted]');
    expect(redactString('Authorization: Bearer abcdefghijklmnop')).toBe('Authorization: Bearer [redacted]');
    expect(redactValue({ apiKey: 'x', note: 'ok' })).toEqual({ apiKey: '[redacted]', note: 'ok' });
  });

  it('delivers typed and wildcard events', () => {
    const bus = createEventBus();
    const seen: string[] = [];
    const off = bus.on('*', (e) => seen.push(e.type));
    bus.on('custom', (e) => seen.push(e.name));
    bus.emit({ type: 'custom', name: 'care:new', payload: 1 });
    off();
    bus.emit({ type: 'custom', name: 'care:x', payload: 1 });
    expect(seen).toEqual(['care:new', 'custom', 'care:x']);
  });
});
