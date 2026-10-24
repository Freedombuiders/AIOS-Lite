import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { CareError } from '../../_lib/care-kit/errors.js';
import { encryptCareField } from './persistence/crypto.js';
import { createCareStores } from './persistence/index.js';
import { CARE_SCHEMA_VERSION, createCareSchema } from './persistence/schema.js';
import { CARE_SCHEMA_V3_DDL } from './persistence/schema-v3.fixture.js';
import { TEST_KEY } from './test-fixtures.js';

const open: Array<() => void> = [];
afterEach(() => open.splice(0).forEach((close) => close()));

/** A genuine accepted-foundation (schema 3) database: the frozen v3 DDL, then real rows. */
function v3Database(): Database.Database {
  const db = new Database(':memory:');
  open.push(() => db.close());
  for (const ddl of CARE_SCHEMA_V3_DDL) db.exec(ddl);
  db.prepare(`INSERT INTO care_schema_meta (key, value) VALUES ('schema_version', '3')`).run();
  return db;
}

const layout = (db: Database.Database) =>
  db
    .prepare(`SELECT type, name, sql FROM sqlite_master WHERE name LIKE 'care\\_%' ESCAPE '\\' ORDER BY type, name`)
    .all()
    .map((r: any) => `${r.type}:${r.name}:${String(r.sql).replace(/\s+/g, ' ')}`);

describe('Care schema 3 -> 4 additive migration (accepted foundation data must survive)', () => {
  it('migrates a populated v3 database in place without losing or rewriting a single row', () => {
    const db = v3Database();
    // Populate through the ACCEPTED stores' own SQL shapes: raw rows so no v4 code is involved.
    const stores3 = createCareStores(db, TEST_KEY); // v3 tables are enough for these stores
    const acc = stores3.accounts.createAccount({ channel: 'zalo', connectorKind: 'zalo-direct', nativeAccountId: 'uid-1', label: 'Shop thật', desiredState: 'active', writeOwner: 'core', aiEnabled: true, syncEnabled: true });
    const cust = stores3.customers.createCustomer({ displayName: 'Khách A', phone: '0901234567', email: 'a@example.com' });
    const conv = stores3.conversations.upsertConversation({ accountId: acc.id, externalKey: 'user:1', kind: 'direct', title: 'Hội thoại bí mật', primaryCustomerId: cust.id });
    stores3.messages.insertMessage({
      accountId: acc.id, externalConversationKey: 'user:1', nativeMessageNamespace: 'zalo_chat', nativeMessageId: 'z-1', nativeVersion: null,
      direction: 'in', senderRole: 'customer', senderIdentityKey: 'u1', origin: 'live', sentAtMs: 1_700_000_000_000, text: 'Xin chào', metadata: { type: 'chat' },
    }, conv.id);
    // v3-shaped row (the v3 table has no policy_ext_enc column, so the current store cannot write it)
    db.prepare(
      `INSERT INTO care_assignments (id, account_id, customer_id, scope, scope_target, channel, priority, enabled, mode, agent_id, instructions_ref_enc, config_version, created_at, updated_at)
       VALUES ('asg-1', ?, NULL, 'account', NULL, NULL, 100, 1, 'auto', 'agent-1', ?, 1, 1, 1)`,
    ).run(acc.id, encryptCareField('ref-1', TEST_KEY));
    stores3.jobs.enqueueJob({ accountId: acc.id, jobType: 'cleanup', payload: { n: 1 } });
    stores3.checkpoints.advance(acc.id, { namespace: 'zalo_chat', cursor: 'c-1', position: '10' });
    stores3.journal.appendSourceJournal({ accountId: acc.id, sourceKind: 'zalo', sourceTable: 'zalo_messages', sourceId: '1', operation: 'insert', payload: { x: 1 } });
    stores3.legacyLinks.linkLegacy(conv.id, 'conversation', 'zalo', 'zalo_threads', '7');

    const rowsBefore = (table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    const tables = ['care_accounts', 'care_customers', 'care_conversations', 'care_messages', 'care_assignments', 'care_jobs', 'care_sync_state', 'care_source_journal', 'care_legacy_links'];
    const before = Object.fromEntries(tables.map((t) => [t, rowsBefore(t)]));

    createCareSchema(db);

    for (const t of tables) expect(rowsBefore(t), `${t} must be untouched`).toEqual(before[t].map((r: any) => (t === 'care_assignments' ? { ...r, policy_ext_enc: null } : r)));
    expect(db.prepare(`SELECT value FROM care_schema_meta WHERE key='schema_version'`).get()).toEqual({ value: String(CARE_SCHEMA_VERSION) });
    for (const t of ['care_capture_accounts', 'care_bridge_state', 'care_bridge_artifacts', 'care_journal_pins']) {
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t), t).toBeTruthy();
    }
    expect((db.prepare(`PRAGMA table_info(care_assignments)`).all() as any[]).map((c) => c.name)).toContain('policy_ext_enc');

    // the accepted data is still readable with the SAME key through the current stores
    const stores = createCareStores(db, TEST_KEY);
    expect(stores.accounts.getAccount(acc.id)).toMatchObject({ label: 'Shop thật', writeOwner: 'core', desiredState: 'active' });
    expect(stores.customers.getCustomer(cust.id)).toMatchObject({ displayName: 'Khách A', phone: '0901234567' });
    expect(stores.messages.getMessageByNativeId(acc.id, 'zalo_chat', 'z-1')!.text).toBe('Xin chào');
    expect(stores.assignments.getAssignment('asg-1')).toMatchObject({ agentId: 'agent-1', instructionsRef: 'ref-1', configVersion: 1 });
    expect(stores.checkpoints.get(acc.id, 'zalo_chat')).toMatchObject({ cursor: 'c-1', position: '10' });
    expect(stores.legacyLinks.resolveCanonicalId('zalo', 'zalo_threads', '7')).toBe(conv.id);
  });

  it('is idempotent and a migrated database has exactly the layout of a fresh v4 install', () => {
    const migrated = v3Database();
    createCareSchema(migrated);
    const once = layout(migrated);
    createCareSchema(migrated);
    createCareSchema(migrated);
    expect(layout(migrated)).toEqual(once);

    const fresh = new Database(':memory:');
    open.push(() => fresh.close());
    createCareSchema(fresh);
    expect(layout(fresh)).toEqual(once);
  });

  it('refuses versions with no migration path and leaves them untouched', () => {
    for (const version of ['2', '1', '5', '0', '-3']) {
      const db = v3Database();
      db.prepare(`UPDATE care_schema_meta SET value = ? WHERE key = 'schema_version'`).run(version);
      const before = layout(db);
      expect(() => createCareSchema(db), version).toThrow(CareError);
      expect(layout(db)).toEqual(before);
      expect(db.prepare(`SELECT value FROM care_schema_meta`).get()).toEqual({ value: version });
    }
  });

  it('a failure after the additions (version bump refused) rolls the WHOLE step back, leaving a clean v3', () => {
    const db = v3Database();
    db.exec(`CREATE TRIGGER block_version BEFORE UPDATE ON care_schema_meta BEGIN SELECT RAISE(FAIL, 'version bump refused'); END;`);
    expect(() => createCareSchema(db)).toThrow('version bump refused');
    expect(db.prepare(`SELECT value FROM care_schema_meta WHERE key='schema_version'`).get()).toEqual({ value: '3' });
    for (const t of ['care_capture_accounts', 'care_bridge_state', 'care_bridge_artifacts', 'care_journal_pins']) {
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE name=?`).get(t), t).toBeUndefined();
    }
    expect((db.prepare(`PRAGMA table_info(care_assignments)`).all() as any[]).map((c) => c.name)).not.toContain('policy_ext_enc');
    // once the obstacle is gone the same call completes
    db.exec('DROP TRIGGER block_version');
    createCareSchema(db);
    expect(db.prepare(`SELECT value FROM care_schema_meta WHERE key='schema_version'`).get()).toEqual({ value: '4' });
  });
});
