import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { CareError } from '../../_lib/care-kit/errors.js';
import { createCareSchema, createTestCareDatabase } from './persistence/index.js';
import { CARE_SCHEMA_VERSION } from './persistence/schema.js';
import { TEST_KEY, chatMessage, emailMessage } from './test-fixtures.js';

const open: Array<() => void> = [];
afterEach(() => open.splice(0).forEach((close) => close()));

function fresh() {
  const f = createTestCareDatabase(':memory:', TEST_KEY);
  open.push(f.close);
  return f;
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof CareError) return err.code;
    throw err;
  }
  throw new Error('expected a CareError');
}

describe('Care schema: additive, idempotent, versioned (AC-004)', () => {
  it('initializes idempotently without data loss and records the schema version once', () => {
    const db = new Database(':memory:');
    open.push(() => db.close());
    createCareSchema(db);
    db.prepare(
      `INSERT INTO care_accounts (id, channel, connector_kind, native_account_id, label_enc, created_at, updated_at)
       VALUES ('acc_test', 'zalo', 'zalo-direct', 'uid_123', 'enc', 1000, 1000)`,
    ).run();

    expect(() => createCareSchema(db)).not.toThrow();
    expect(() => createCareSchema(db)).not.toThrow();

    expect(db.prepare('SELECT label_enc FROM care_accounts WHERE id = ?').get('acc_test')).toEqual({ label_enc: 'enc' });
    expect(db.prepare(`SELECT value FROM care_schema_meta WHERE key = 'schema_version'`).all()).toEqual([{ value: String(CARE_SCHEMA_VERSION) }]);
  });

  it('refuses to run against a NEWER schema version (incompatible runtime must not operate)', () => {
    const db = new Database(':memory:');
    open.push(() => db.close());
    createCareSchema(db);
    db.prepare(`UPDATE care_schema_meta SET value = ? WHERE key = 'schema_version'`).run(String(CARE_SCHEMA_VERSION + 1));
    expect(codeOf(() => createCareSchema(db))).toBe('CONFIGURATION_CONFLICT');
  });

  it('refuses an unversioned pre-release (plaintext label) care_accounts layout instead of layering on it', () => {
    const db = new Database(':memory:');
    open.push(() => db.close());
    db.exec(`CREATE TABLE care_accounts (id TEXT PRIMARY KEY, channel TEXT, connector_kind TEXT, native_account_id TEXT, label TEXT NOT NULL)`);
    expect(codeOf(() => createCareSchema(db))).toBe('CONFIGURATION_CONFLICT');
  });

  it.each(['-1', '0', '1', '2', '5', '999', 'abc', '', '3.0', ' 3', '04', '4.0'])(
    'refuses stored schema version %j (no migration path / not canonical) and does not touch the tables',
    (version) => {
      const db = new Database(':memory:');
      open.push(() => db.close());
      createCareSchema(db);
      db.prepare(`INSERT INTO care_accounts (id, channel, connector_kind, native_account_id, label_enc, created_at, updated_at) VALUES ('keep','zalo','k','n','e',1,1)`).run();
      db.prepare(`UPDATE care_schema_meta SET value = ? WHERE key = 'schema_version'`).run(version);
      const before = db.prepare(`SELECT sql FROM sqlite_master WHERE name LIKE 'care_%' ORDER BY name`).all();

      expect(codeOf(() => createCareSchema(db))).toBe('CONFIGURATION_CONFLICT');
      expect(db.prepare(`SELECT value FROM care_schema_meta WHERE key = 'schema_version'`).get()).toEqual({ value: version });
      expect(db.prepare(`SELECT sql FROM sqlite_master WHERE name LIKE 'care_%' ORDER BY name`).all()).toEqual(before);
      expect(db.prepare(`SELECT id FROM care_accounts`).all()).toEqual([{ id: 'keep' }]);
    },
  );

  it('refuses a missing version row and unversioned care tables WITHOUT creating or altering anything', () => {
    const db = new Database(':memory:');
    open.push(() => db.close());
    createCareSchema(db);
    db.exec(`DELETE FROM care_schema_meta`);
    expect(codeOf(() => createCareSchema(db))).toBe('CONFIGURATION_CONFLICT');

    const proto = new Database(':memory:');
    open.push(() => proto.close());
    proto.exec(`CREATE TABLE care_messages (id TEXT PRIMARY KEY, body TEXT)`);
    expect(codeOf(() => createCareSchema(proto))).toBe('CONFIGURATION_CONFLICT');
    const tables = (proto.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map((t) => t.name);
    expect(tables).toEqual(['care_messages']); // not even care_schema_meta was created
  });

  it('a legacy database with no Care tables initialises, and re-running stays a no-op', () => {
    const db = new Database(':memory:');
    open.push(() => db.close());
    db.exec(`CREATE TABLE zalo_messages (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO zalo_messages (body) VALUES ('legacy')`);
    expect(() => createCareSchema(db)).not.toThrow();
    const snapshot = db.prepare(`SELECT name, sql FROM sqlite_master ORDER BY name`).all();
    expect(() => createCareSchema(db)).not.toThrow();
    expect(db.prepare(`SELECT name, sql FROM sqlite_master ORDER BY name`).all()).toEqual(snapshot);
    expect(db.prepare('SELECT body FROM zalo_messages').all()).toEqual([{ body: 'legacy' }]);
  });

  it('leaves unrelated tables alone', () => {
    const db = new Database(':memory:');
    open.push(() => db.close());
    db.exec(`CREATE TABLE unrelated (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO unrelated (v) VALUES ('keep')`);
    createCareSchema(db);
    expect(db.prepare('SELECT v FROM unrelated').all()).toEqual([{ v: 'keep' }]);
  });
});

describe('Defaults are inactive; enums are enforced by the database too', () => {
  it('store default and SQL default agree: paused, every flag off, legacy owner, epoch 1', () => {
    const { stores, rawDbForTestIsolationOnly: raw } = fresh();
    const viaStore = stores.accounts.createAccount({ channel: 'zalo', connectorKind: 'k', nativeAccountId: 'a', label: 'l' });
    raw.prepare(
      `INSERT INTO care_accounts (id, channel, connector_kind, native_account_id, label_enc, created_at, updated_at) VALUES ('sql', 'zalo', 'k', 'b', 'x', 1, 1)`,
    ).run();
    const viaSql = raw.prepare(`SELECT desired_state, sync_enabled, send_enabled, ai_enabled, write_owner, owner_epoch FROM care_accounts WHERE id = 'sql'`).get();
    expect(viaSql).toEqual({ desired_state: 'paused', sync_enabled: 0, send_enabled: 0, ai_enabled: 0, write_owner: 'legacy', owner_epoch: 1 });
    expect(viaStore).toMatchObject({ desiredState: 'paused', syncEnabled: false, sendEnabled: false, aiEnabled: false, writeOwner: 'legacy', ownerEpoch: 1 });
  });

  it('stores reject invalid enums/epochs and the database CHECK constraints backstop raw writes', () => {
    const { stores, rawDbForTestIsolationOnly: raw } = fresh();
    const base = { channel: 'zalo' as const, connectorKind: 'k', nativeAccountId: 'a', label: 'l' };
    expect(codeOf(() => stores.accounts.createAccount({ ...base, channel: 'sms' as never }))).toBe('INVALID_COMMAND');
    expect(codeOf(() => stores.accounts.createAccount({ ...base, desiredState: 'running' as never }))).toBe('INVALID_COMMAND');
    expect(codeOf(() => stores.accounts.createAccount({ ...base, writeOwner: 'both' as never }))).toBe('INVALID_COMMAND');
    expect(codeOf(() => stores.accounts.createAccount({ ...base, ownerEpoch: 0 }))).toBe('INVALID_COMMAND');
    expect(codeOf(() => stores.accounts.createAccount({ ...base, nativeAccountId: '' }))).toBe('INVALID_COMMAND');

    expect(() => raw.prepare(`INSERT INTO care_accounts (id, channel, connector_kind, native_account_id, label_enc, desired_state, created_at, updated_at) VALUES ('x','zalo','k','n','e','running',1,1)`).run()).toThrow(/CHECK/);
    expect(() => raw.prepare(`INSERT INTO care_accounts (id, channel, connector_kind, native_account_id, label_enc, ai_enabled, created_at, updated_at) VALUES ('y','zalo','k','n2','e',2,1,1)`).run()).toThrow(/CHECK/);
    expect(() => raw.prepare(`INSERT INTO care_customers (id, display_name_enc, stage, created_at, updated_at) VALUES ('c','e','vip',1,1)`).run()).toThrow(/CHECK/);
  });
});

describe('Message namespaces isolate accounts and boxes (AC-002)', () => {
  it('same native id across accounts and Telegram boxes never collides; duplicates in one namespace do', () => {
    const { stores } = fresh();
    const a1 = stores.accounts.createAccount({ channel: 'zalo', connectorKind: 'zalo-direct', nativeAccountId: 'zalo_uid_1', label: 'Zalo' });
    const a2 = stores.accounts.createAccount({ channel: 'telegram', connectorKind: 'telegram-user', nativeAccountId: 'tg_phone_2', label: 'TG' });
    const c1 = stores.conversations.upsertConversation({ accountId: a1.id, externalKey: 'thread_common', kind: 'direct', title: 'T1' });
    const c2 = stores.conversations.upsertConversation({ accountId: a2.id, externalKey: 'thread_common', kind: 'direct', title: 'T2' });

    const m1 = stores.messages.insertMessage(chatMessage(a1, { nativeMessageId: 'shared', externalConversationKey: 'thread_common', text: 'one' }), c1.id);
    const m2 = stores.messages.insertMessage(chatMessage(a2, { nativeMessageId: 'shared', externalConversationKey: 'thread_common', text: 'two' }), c2.id);
    const m3 = stores.messages.insertMessage(chatMessage(a2, { nativeMessageId: 'shared', nativeMessageNamespace: 'telegram_channel_box:5', externalConversationKey: 'thread_common', text: 'three' }), c2.id);

    expect(new Set([m1.id, m2.id, m3.id]).size).toBe(3);
    expect(stores.messages.getMessageByNativeId(a1.id, 'zalo_chat', 'shared')!.text).toBe('one');
    expect(stores.messages.getMessageByNativeId(a2.id, 'telegram_common_box', 'shared')!.text).toBe('two');
    expect(stores.messages.getMessageByNativeId(a2.id, 'telegram_channel_box:5', 'shared')!.text).toBe('three');
    expect(() => stores.messages.insertMessage(chatMessage(a1, { nativeMessageId: 'shared' }), c1.id)).toThrow(/UNIQUE/);
  });
});

describe('Direct store entrypoints enforce cross-account consistency themselves (review)', () => {
  it('insertMessage rejects another account\'s conversation, another account\'s identity, bad namespace and metadata kind', () => {
    const { stores, rawDbForTestIsolationOnly: raw } = fresh();
    const a = stores.accounts.createAccount({ channel: 'zalo', connectorKind: 'k', nativeAccountId: 'a', label: 'a' });
    const b = stores.accounts.createAccount({ channel: 'zalo', connectorKind: 'k', nativeAccountId: 'b', label: 'b' });
    const mail = stores.accounts.createAccount({ channel: 'email', connectorKind: 'g', nativeAccountId: 'm@x.co', label: 'm' });
    const convA = stores.conversations.upsertConversation({ accountId: a.id, externalKey: 'k', kind: 'direct', title: 't' });
    const cust = stores.customers.createCustomer({ displayName: 'c' });
    const identityB = stores.identities.createIdentity({ customerId: cust.id, accountId: b.id, namespace: 'user', externalIdentityId: 'u' });

    expect(codeOf(() => stores.messages.insertMessage(chatMessage(b), convA.id))).toBe('INVALID_TARGET'); // conversation of account a
    expect(codeOf(() => stores.messages.insertMessage(chatMessage(a), convA.id, identityB.id))).toBe('INVALID_TARGET'); // identity of account b
    expect(codeOf(() => stores.messages.insertMessage(chatMessage(a), 'missing'))).toBe('INVALID_TARGET');
    expect(codeOf(() => stores.messages.insertMessage(chatMessage(a, { nativeMessageNamespace: 'gmail_mailbox' }), convA.id))).toBe('INVALID_TARGET');
    expect(codeOf(() => stores.messages.insertMessage(emailMessage(a), convA.id))).toBe('INVALID_TARGET'); // email metadata on zalo
    expect(codeOf(() => stores.messages.insertMessage(chatMessage(mail, { nativeMessageNamespace: 'gmail_mailbox' }), stores.conversations.upsertConversation({ accountId: mail.id, externalKey: 't', kind: 'email_thread', title: 's' }).id))).toBe('INVALID_TARGET'); // chat metadata on email
    expect(codeOf(() => stores.messages.insertTombstone(b.id, convA.id, 'zalo_chat', 'x', 1))).toBe('INVALID_TARGET');
    expect(codeOf(() => stores.messages.insertTombstone(a.id, convA.id, 'gmail_mailbox', 'x', 1))).toBe('INVALID_TARGET');
    expect(raw.prepare('SELECT count(*) AS n FROM care_messages').get()).toEqual({ n: 0 });
  });

  it('conversations, identities, jobs, events, tasks and profiles validate their foreign targets', () => {
    const { stores } = fresh();
    const a = stores.accounts.createAccount({ channel: 'zalo', connectorKind: 'k', nativeAccountId: 'a', label: 'a' });
    const mail = stores.accounts.createAccount({ channel: 'email', connectorKind: 'g', nativeAccountId: 'm@x.co', label: 'm' });
    const b = stores.accounts.createAccount({ channel: 'zalo', connectorKind: 'k', nativeAccountId: 'b', label: 'b' });
    const convA = stores.conversations.upsertConversation({ accountId: a.id, externalKey: 'k', kind: 'direct', title: 't' });
    const cust = stores.customers.createCustomer({ displayName: 'c' });

    // conversation: unknown account, kind not valid for the channel, unknown primary customer
    expect(codeOf(() => stores.conversations.upsertConversation({ accountId: 'nope', externalKey: 'k', kind: 'direct', title: 't' }))).toBe('INVALID_TARGET');
    expect(codeOf(() => stores.conversations.upsertConversation({ accountId: a.id, externalKey: 'g', kind: 'topic', title: 't' }))).toBe('INVALID_TARGET');
    expect(codeOf(() => stores.conversations.upsertConversation({ accountId: mail.id, externalKey: 'g', kind: 'direct', title: 't' }))).toBe('INVALID_TARGET');
    expect(codeOf(() => stores.conversations.upsertConversation({ accountId: a.id, externalKey: 'p', kind: 'direct', title: 't', primaryCustomerId: 'ghost' }))).toBe('INVALID_TARGET');
    // identity
    expect(codeOf(() => stores.identities.createIdentity({ customerId: 'ghost', accountId: a.id, namespace: 'user', externalIdentityId: 'u' }))).toBe('INVALID_TARGET');
    expect(codeOf(() => stores.identities.createIdentity({ customerId: cust.id, accountId: 'ghost', namespace: 'user', externalIdentityId: 'u' }))).toBe('INVALID_TARGET');
    expect(codeOf(() => stores.identities.linkIdentity('x', 'ghost'))).toBe('INVALID_TARGET');
    // jobs
    expect(codeOf(() => stores.jobs.enqueueJob({ accountId: 'ghost', jobType: 'cleanup', payload: {} }))).toBe('INVALID_TARGET');
    expect(codeOf(() => stores.jobs.enqueueJob({ accountId: b.id, jobType: 'cleanup', payload: {}, conversationId: convA.id }))).toBe('INVALID_TARGET'); // conv of another account
    expect(codeOf(() => stores.jobs.enqueueJob({ accountId: a.id, jobType: 'bogus' as never, payload: {} }))).toBe('INVALID_COMMAND');
    expect(codeOf(() => stores.jobs.enqueueJob({ accountId: a.id, jobType: 'cleanup', payload: { blob: 'x'.repeat(70_000) } }))).toBe('INVALID_COMMAND');
    // events
    expect(codeOf(() => stores.events.appendEvent({ eventId: 'e', accountId: b.id, eventType: 't', conversationId: convA.id, payload: {} }))).toBe('INVALID_TARGET');
    expect(codeOf(() => stores.events.appendEvent({ eventId: 'e', accountId: 'ghost', eventType: 't', payload: {} }))).toBe('INVALID_TARGET');
    stores.events.appendEvent({ eventId: 'dup', accountId: a.id, eventType: 't', payload: {} });
    expect(() => stores.events.appendEvent({ eventId: 'dup', accountId: a.id, eventType: 't', payload: {} })).toThrow(/UNIQUE/); // not silently ignored
    stores.events.appendEvent({ eventId: 'dup', accountId: b.id, eventType: 't', payload: {} }); // other account is fine
    // tasks / profiles / credentials / journal
    expect(codeOf(() => stores.tasks.createTask({ customerId: 'ghost', title: 't', dueAtMs: 1 }))).toBe('INVALID_TARGET');
    expect(codeOf(() => stores.tasks.createTask({ customerId: cust.id, conversationId: 'ghost', title: 't', dueAtMs: 1 }))).toBe('INVALID_TARGET');
    expect(codeOf(() => stores.profiles.saveProfile('ghost', { note: 'n' }))).toBe('INVALID_TARGET');
    expect(codeOf(() => stores.profiles.saveProfile(cust.id, { note: 'n' }, 'ghost'))).toBe('INVALID_TARGET');
    expect(codeOf(() => stores.credentials.saveCredential('ghost', 'oauth', {}))).toBe('INVALID_TARGET');
    expect(codeOf(() => stores.journal.appendSourceJournal({ accountId: 'ghost', sourceKind: 's', sourceTable: 't', sourceId: '1', operation: 'insert', payload: {} }))).toBe('INVALID_TARGET');
  });

  it('customer updates are compare-and-set on revision and keep attributes encrypted', () => {
    const { stores } = fresh();
    const c = stores.customers.createCustomer({ displayName: 'Alice', phone: '0900' });
    const v2 = stores.customers.updateCustomer(c.id, { phone: '0911', stage: 'quoted' }, c.revision);
    expect(v2).toMatchObject({ phone: '0911', stage: 'quoted', displayName: 'Alice', revision: 2 });
    expect(codeOf(() => stores.customers.updateCustomer(c.id, { phone: '0922' }, c.revision))).toBe('STALE_REVISION');
    expect(codeOf(() => stores.customers.updateCustomer(c.id, { stage: 'vip' as never }))).toBe('INVALID_COMMAND');
    expect(codeOf(() => stores.customers.updateCustomer('ghost', {}))).toBe('NOT_FOUND');
    expect(stores.customers.updateCustomer(c.id, { company: null }).company).toBeNull();
  });

  it('keyset listing caps absurd limits', () => {
    const { stores } = fresh();
    expect(stores.customers.listCustomers(10_000_000)).toEqual([]);
    expect(stores.customers.listCustomers(-5)).toEqual([]);
  });
});

describe('Assignment scopes are representable and validated (Finding 14)', () => {
  it('global/channel carry no account, customer scope carries a customer, both stored independent of any account', () => {
    const { stores } = fresh();
    const global = stores.assignments.upsertAssignment({ scope: 'global', mode: 'auto', agentId: 'jarvis_main', instructionsRef: 'global_rules.md' });
    expect(global).toMatchObject({ accountId: null, channel: null, customerId: null, scope: 'global', scopeTarget: null });

    const channel = stores.assignments.upsertAssignment({ scope: 'channel', channel: 'email', mode: 'auto', agentId: 'email_agent' });
    expect(channel).toMatchObject({ accountId: null, channel: 'email', scope: 'channel' });

    stores.customers.createCustomer({ displayName: 'VIP' }, 'cust_vip_001');
    const customer = stores.assignments.upsertAssignment({ scope: 'customer', customerId: 'cust_vip_001', mode: 'observe' });
    expect(customer).toMatchObject({ customerId: 'cust_vip_001', accountId: null, scope: 'customer' });

    expect(stores.assignments.listAssignments({ scope: 'global' }).map((a) => a.id)).toEqual([global.id]);
    expect(stores.assignments.listAssignments({ channel: 'email' }).map((a) => a.agentId)).toEqual(['email_agent']);
    expect(stores.assignments.listAssignments({ customerId: 'cust_vip_001' })[0].mode).toBe('observe');
  });

  it('rejects malformed scope shapes and foreign targets', () => {
    const { stores } = fresh();
    const zalo = stores.accounts.createAccount({ channel: 'zalo', connectorKind: 'k', nativeAccountId: 'z', label: 'z' });
    const mail = stores.accounts.createAccount({ channel: 'email', connectorKind: 'g', nativeAccountId: 'm@x.co', label: 'm' });
    const cust = stores.customers.createCustomer({ displayName: 'c' });
    const bad = (a: Parameters<typeof stores.assignments.upsertAssignment>[0]) => codeOf(() => stores.assignments.upsertAssignment(a));

    expect(bad({ scope: 'global', accountId: zalo.id, mode: 'auto', agentId: 'a' })).toBe('INVALID_TARGET');
    expect(bad({ scope: 'global', channel: 'zalo', mode: 'auto', agentId: 'a' })).toBe('INVALID_TARGET');
    expect(bad({ scope: 'channel', mode: 'auto', agentId: 'a' })).toBe('INVALID_TARGET'); // channel missing
    expect(bad({ scope: 'channel', channel: 'zalo', accountId: zalo.id, mode: 'auto', agentId: 'a' })).toBe('INVALID_TARGET');
    expect(bad({ scope: 'customer', mode: 'auto', agentId: 'a' })).toBe('INVALID_TARGET');
    expect(bad({ scope: 'customer', customerId: 'ghost', mode: 'auto', agentId: 'a' })).toBe('INVALID_TARGET');
    expect(bad({ scope: 'account', mode: 'auto', agentId: 'a' })).toBe('INVALID_TARGET');
    expect(bad({ scope: 'account', accountId: 'ghost', mode: 'auto', agentId: 'a' })).toBe('INVALID_TARGET');
    expect(bad({ scope: 'account', accountId: zalo.id, channel: 'email', mode: 'auto', agentId: 'a' })).toBe('INVALID_TARGET');
    expect(bad({ scope: 'conversation', accountId: zalo.id, mode: 'auto', agentId: 'a' })).toBe('INVALID_COMMAND'); // target missing
    expect(bad({ scope: 'identity', mode: 'auto', agentId: 'a', scopeTarget: 'x' })).toBe('INVALID_TARGET');
    expect(bad({ scope: 'domain', accountId: zalo.id, scopeTarget: 'x.com', mode: 'auto', agentId: 'a' })).toBe('INVALID_TARGET'); // not an email account
    expect(stores.assignments.upsertAssignment({ scope: 'domain', accountId: mail.id, scopeTarget: 'x.com', mode: 'auto', agentId: 'a' })).toMatchObject({ scope: 'domain', scopeTarget: 'x.com' });
    expect(bad({ scope: 'bogus' as never, mode: 'auto', agentId: 'a' })).toBe('INVALID_COMMAND');
    expect(bad({ scope: 'account', accountId: zalo.id, mode: 'bogus' as never, agentId: 'a' })).toBe('INVALID_COMMAND');
    expect(bad({ scope: 'account', accountId: zalo.id, mode: 'auto' })).toBe('INVALID_COMMAND'); // non-observe needs an agent
    expect(cust.id).toBeTruthy();
  });

  it('the database CHECK enforces the same shapes for raw writers', () => {
    const { rawDbForTestIsolationOnly: raw } = fresh();
    const insert = (cols: string, vals: string) =>
      raw.prepare(`INSERT INTO care_assignments (id, scope, ${cols}, created_at, updated_at) VALUES ('a${Math.random()}', ${vals}, 1, 1)`).run();
    expect(() => insert('channel', `'global', 'zalo'`)).toThrow(/CHECK/);
    expect(() => insert('channel', `'channel', NULL`)).toThrow(/CHECK/);
    expect(() => insert('channel', `'account', NULL`)).toThrow(/CHECK/);
    expect(() => insert('channel', `'customer', NULL`)).toThrow(/CHECK/);
    expect(() => insert('channel', `'nonsense', NULL`)).toThrow(/CHECK/);
  });

  it('config version increments on update and an expectedConfigVersion makes it compare-and-set', () => {
    const { stores } = fresh();
    const v1 = stores.assignments.upsertAssignment({ id: 'rule', scope: 'global', mode: 'draft', agentId: 'a' });
    const v2 = stores.assignments.upsertAssignment({ id: 'rule', scope: 'global', mode: 'auto', agentId: 'a', expectedConfigVersion: v1.configVersion });
    expect(v2).toMatchObject({ configVersion: 2, mode: 'auto' });
    expect(codeOf(() => stores.assignments.upsertAssignment({ id: 'rule', scope: 'global', mode: 'observe', agentId: 'a', expectedConfigVersion: 1 }))).toBe('STALE_REVISION');
  });
});

describe('Legacy links are a stable mapping (AC-011)', () => {
  it('is idempotent for the same pair and refuses to re-point either side', () => {
    const { stores } = fresh();
    stores.legacyLinks.linkLegacy('care_msg_abc', 'message', 'zalo', 'zalo_messages', '998877');
    stores.legacyLinks.linkLegacy('care_msg_abc', 'message', 'zalo', 'zalo_messages', '998877');

    expect(stores.legacyLinks.resolveCanonicalId('zalo', 'zalo_messages', '998877')).toBe('care_msg_abc');
    expect(stores.legacyLinks.resolveLegacyId('message', 'care_msg_abc', 'zalo')).toBe('998877');

    expect(codeOf(() => stores.legacyLinks.linkLegacy('care_msg_other', 'message', 'zalo', 'zalo_messages', '998877'))).toBe('CONFIGURATION_CONFLICT');
    expect(codeOf(() => stores.legacyLinks.linkLegacy('care_msg_abc', 'message', 'zalo', 'zalo_messages', '111'))).toBe('CONFIGURATION_CONFLICT');
    expect(stores.legacyLinks.resolveCanonicalId('zalo', 'zalo_messages', '998877')).toBe('care_msg_abc');
  });
});

describe('Source journal retention (CC-03)', () => {
  it('purge zeroes payloads but keeps the sequence resumable', () => {
    const { stores } = fresh();
    const a = stores.accounts.createAccount({ channel: 'zalo', connectorKind: 'k', nativeAccountId: 'a', label: 'a' });
    const seq = stores.journal.appendSourceJournal({ accountId: a.id, sourceKind: 'zalo', sourceTable: 't', sourceId: '1', operation: 'insert', payload: { body: 'JOURNAL_BODY' } });
    expect(stores.journal.readPayload(seq)).toEqual({ body: 'JOURNAL_BODY' });
    expect(stores.journal.purgePayloadsBefore(Date.now() + 1000)).toBe(1);
    expect(stores.journal.readPayload(seq)).toBeNull();
    expect(stores.journal.listUnappliedJournal().map((j) => j.seq)).toEqual([seq]);
    expect(stores.journal.markJournalApplied(seq)).toBe(true);
    expect(stores.journal.listUnappliedJournal()).toEqual([]);
  });
});
