import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CareError } from '../../_lib/care-kit/errors.js';
import { CareIngestPipeline } from './application/ingest.js';
import {
  createUnavailableCareKey,
  decryptCareFieldStrict,
  decryptCareJson,
  encryptCareField,
  encryptCareJson,
  maskSecret,
  resolveEncryptionKey,
} from './persistence/crypto.js';
import { createTestCareDatabase } from './persistence/index.js';
import { scrubEventPayload } from './persistence/stores.js';
import { assignAuto, chatMessage, createEligibleAccount, dumpCareTables, emailMessage } from './test-fixtures.js';

describe('Care Security & Fail-Closed Decryption (AC-005, Findings 1 & 2)', () => {
  const testKeyA = crypto.createHash('sha256').update('test-encryption-key-A').digest();
  const testKeyB = crypto.createHash('sha256').update('test-encryption-key-B').digest();

  it('strictly validates encryption keys and rejects invalid lengths or non-hex characters', () => {
    // Exact 32 bytes valid Buffer
    expect(resolveEncryptionKey(testKeyA).length).toBe(32);

    // Exact 64 hex characters valid string
    const hexKey = testKeyA.toString('hex');
    expect(resolveEncryptionKey(hexKey).length).toBe(32);

    // 31 bytes Buffer rejected
    expect(() => resolveEncryptionKey(Buffer.alloc(31, 1))).toThrowError(CareError);

    // 33 bytes Buffer rejected
    expect(() => resolveEncryptionKey(Buffer.alloc(33, 1))).toThrowError(CareError);

    // 62 hex characters rejected
    expect(() => resolveEncryptionKey(hexKey.slice(0, 62))).toThrowError(CareError);

    // 66 hex characters rejected
    expect(() => resolveEncryptionKey(hexKey + 'ff')).toThrowError(CareError);

    // Non-hex characters rejected
    expect(() => resolveEncryptionKey('g'.repeat(64))).toThrowError(CareError);

    // When no key provided and env var is missing/empty, strictly throws without fallback
    const origEnv = process.env.DB_ENCRYPTION_KEY;
    try {
      delete process.env.DB_ENCRYPTION_KEY;
      expect(() => resolveEncryptionKey()).toThrowError(CareError);
      try {
        resolveEncryptionKey();
      } catch (err: any) {
        expect(err.code).toBe('CREDENTIAL_DECODE_FAILED');
      }
    } finally {
      if (origEnv !== undefined) {
        process.env.DB_ENCRYPTION_KEY = origEnv;
      }
    }
  });

  it('encrypts plaintext into valid AES-256-GCM compact hex format and roundtrips', () => {
    const plaintext = 'Secret Session Token 12345';
    const ciphertext = encryptCareField(plaintext, testKeyA);

    const parts = ciphertext.split(':');
    expect(parts.length).toBe(3);
    const [ivHex, tagHex, dataHex] = parts;
    expect(ivHex.length).toBe(24); // 12 bytes = 24 hex chars
    expect(tagHex.length).toBe(32); // 16 bytes = 32 hex chars
    expect(dataHex.length).toBeGreaterThan(0);

    const decrypted = decryptCareFieldStrict(ciphertext, testKeyA);
    expect(decrypted).toBe(plaintext);
  });

  it('correctly handles empty plaintext roundtrip without failing or producing malformed ciphertext', () => {
    const emptyPlaintext = '';
    const ciphertext = encryptCareField(emptyPlaintext, testKeyA);

    const parts = ciphertext.split(':');
    expect(parts.length).toBe(3);
    const [ivHex, tagHex, dataHex] = parts;
    expect(ivHex.length).toBe(24);
    expect(tagHex.length).toBe(32);
    expect(dataHex).toBe(''); // empty data segment

    const decrypted = decryptCareFieldStrict(ciphertext, testKeyA);
    expect(decrypted).toBe('');
  });

  it('strictly FAILS CLOSED when ciphertext is tampered with', () => {
    const plaintext = 'Super Sensitive Credential';
    const ciphertext = encryptCareField(plaintext, testKeyA);
    const [ivHex, tagHex, dataHex] = ciphertext.split(':');

    // Tamper with data segment
    const tamperedDataHex = dataHex.slice(0, -2) + (dataHex.slice(-2) === 'aa' ? 'bb' : 'aa');
    const tamperedCiphertext = `${ivHex}:${tagHex}:${tamperedDataHex}`;

    expect(() => decryptCareFieldStrict(tamperedCiphertext, testKeyA)).toThrowError(CareError);
    try {
      decryptCareFieldStrict(tamperedCiphertext, testKeyA);
    } catch (err: any) {
      expect(err.code).toBe('CREDENTIAL_DECODE_FAILED');
    }
  });

  it('strictly FAILS CLOSED when auth tag is tampered with', () => {
    const plaintext = 'Sensitive OAuth Refresh Token';
    const ciphertext = encryptCareField(plaintext, testKeyA);
    const [ivHex, tagHex, dataHex] = ciphertext.split(':');

    // Tamper with auth tag
    const tamperedTagHex = '00' + tagHex.slice(2);
    const tamperedCiphertext = `${ivHex}:${tamperedTagHex}:${dataHex}`;

    expect(() => decryptCareFieldStrict(tamperedCiphertext, testKeyA)).toThrowError(CareError);
  });

  it('strictly FAILS CLOSED when decrypting with incorrect key', () => {
    const plaintext = 'Telegram Auth Key';
    const ciphertext = encryptCareField(plaintext, testKeyA);

    // Try decrypting with testKeyB
    expect(() => decryptCareFieldStrict(ciphertext, testKeyB)).toThrowError(CareError);
    try {
      decryptCareFieldStrict(ciphertext, testKeyB);
    } catch (err: any) {
      expect(err.code).toBe('CREDENTIAL_DECODE_FAILED');
    }
  });

  it('strictly rejects non-ciphertext payloads with zero graceful plaintext fallback', () => {
    // Malformed strings that do not follow iv:tag:data
    expect(() => decryptCareFieldStrict('not-a-ciphertext', testKeyA)).toThrowError(CareError);
    expect(() => decryptCareFieldStrict('raw:plaintext', testKeyA)).toThrowError(CareError);
    expect(() => decryptCareFieldStrict('::', testKeyA)).toThrowError(CareError);
    expect(() => decryptCareFieldStrict('1234:5678:90ab', testKeyA)).toThrowError(CareError);
  });

  it('rejects odd-length ciphertext data instead of silently truncating a trailing nibble (probe 1)', () => {
    const ciphertext = encryptCareField('secret', testKeyA);
    expect(() => decryptCareFieldStrict(ciphertext + 'f', testKeyA)).toThrowError(CareError);
    const [iv, tag, data] = ciphertext.split(':');
    expect(() => decryptCareFieldStrict(`${iv}:${tag}:${data.slice(0, -1)}`, testKeyA)).toThrowError(CareError);
    expect(() => decryptCareFieldStrict(`${iv}:${tag}:${data} `, testKeyA)).toThrowError(CareError);
    // exactly-even data still decrypts
    expect(decryptCareFieldStrict(ciphertext, testKeyA)).toBe('secret');
  });

  it('an explicit empty/invalid key never falls through to the environment', () => {
    const env = process.env.DB_ENCRYPTION_KEY;
    process.env.DB_ENCRYPTION_KEY = testKeyA.toString('hex');
    try {
      expect(resolveEncryptionKey().length).toBe(32); // only `undefined` consults the environment
      expect(() => resolveEncryptionKey('')).toThrowError(CareError);
      expect(() => resolveEncryptionKey('   ')).toThrowError(CareError);
      expect(() => resolveEncryptionKey(Buffer.alloc(0))).toThrowError(CareError);
      expect(() => encryptCareField('x', '')).toThrowError(CareError);
      expect(() => decryptCareFieldStrict(encryptCareField('x', testKeyA), '')).toThrowError(CareError);
    } finally {
      if (env === undefined) delete process.env.DB_ENCRYPTION_KEY;
      else process.env.DB_ENCRYPTION_KEY = env;
    }
  });

  it('an unavailable-key marker fails closed on every encrypt, decrypt and store write', () => {
    const marker = createUnavailableCareKey('configured key is 40 hex chars');
    expect(() => resolveEncryptionKey(marker)).toThrowError(CareError);
    expect(() => encryptCareField('x', marker)).toThrowError(/unavailable/);
    const { stores, close } = createTestCareDatabase(':memory:', marker);
    try {
      expect(() => stores.accounts.createAccount({ channel: 'zalo', connectorKind: 'k', nativeAccountId: 'n', label: 'l' })).toThrowError(CareError);
      expect(() => stores.customers.createCustomer({ displayName: 'x' })).toThrowError(CareError);
    } finally {
      close();
    }
  });

  it('JSON helpers are strict: valid tag over non-JSON is corruption, not a fallback', () => {
    expect(decryptCareJson(encryptCareJson({ a: 1 }, testKeyA), testKeyA)).toEqual({ a: 1 });
    expect(() => decryptCareJson(encryptCareField('not json {', testKeyA), testKeyA)).toThrowError(CareError);
    expect(() => encryptCareJson(undefined, testKeyA)).toThrowError(CareError);
  });

  it('verifies DB data-at-rest encryption: secret markers are ABSENT in every care_* table', () => {
    const { stores, rawDbForTestIsolationOnly: raw, close } = createTestCareDatabase(':memory:', testKeyA);
    const M = (name: string) => `MARKER_${name}_XY9988`;

    const acc = stores.accounts.createAccount({
      channel: 'email', connectorKind: 'gmail-composio', nativeAccountId: 'user@example.com', label: M('ACCOUNT_LABEL'),
    });
    stores.accounts.updateAccountFlags(acc.id, { healthNote: M('HEALTH_NOTE') });

    const cust = stores.customers.createCustomer({
      displayName: M('CUST_NAME'), company: M('CUST_COMPANY'), phone: M('CUST_PHONE'), email: M('CUST_EMAIL'), tags: M('CUST_TAGS'),
    });
    const identity = stores.identities.createIdentity({
      customerId: cust.id, accountId: acc.id, namespace: 'email', externalIdentityId: 'sender@example.com',
      displayName: M('IDENT_NAME'), username: M('IDENT_USER'), avatarUrl: M('IDENT_AVATAR'),
    });
    const conv = stores.conversations.upsertConversation({
      accountId: acc.id, externalKey: 'thread_secret_1', kind: 'email_thread', title: M('CONV_TITLE'), primaryCustomerId: cust.id,
    });
    const msg = stores.messages.insertMessage(
      {
        accountId: acc.id, externalConversationKey: 'thread_secret_1', nativeMessageNamespace: 'gmail_mailbox', nativeMessageId: 'gmail_msg_001',
        senderIdentityKey: 'sender@example.com', senderRole: 'customer', direction: 'in', origin: 'live', sentAtMs: 1774880000000,
        nativeVersion: null, text: M('BODY'),
        metadata: { type: 'email', subject: M('SUBJECT'), from: 'sender@example.com', to: ['user@example.com'], headers: { 'X-Secret': M('HEADER') } },
      },
      conv.id,
      identity.id,
    );
    const profile = stores.profiles.saveProfile(cust.id, { need: { details: M('NEED') }, note: M('NOTE') });
    const task = stores.tasks.createTask({ customerId: cust.id, conversationId: conv.id, title: M('TASK'), dueAtMs: 1774900000000 });
    stores.credentials.saveCredential(acc.id, 'oauth_token', { token: M('OAUTH') });
    stores.journal.appendSourceJournal({ accountId: acc.id, sourceKind: 'email', sourceTable: 'raw_sync', sourceId: 'raw_1', operation: 'insert', payload: { secret: M('JOURNAL') } });
    stores.assignments.upsertAssignment({ scope: 'account', accountId: acc.id, mode: 'draft', agentId: 'agent', instructionsRef: M('INSTRUCTIONS') });
    stores.jobs.enqueueJob({ accountId: acc.id, jobType: 'cleanup', payload: { note: M('JOB_PAYLOAD') }, ownerEpoch: 1 });
    stores.events.appendEvent({
      eventId: 'e1', accountId: acc.id, eventType: 'message.created',
      payload: { text: M('EVENT_TEXT'), title: M('EVENT_TITLE'), errorNote: M('EVENT_ERROR'), body: M('EVENT_BODY'), nativeMessageId: 'ok-id' },
      replay: { detail: M('EVENT_REPLAY') },
    });

    const dump = dumpCareTables(raw);
    const names = [
      'ACCOUNT_LABEL', 'HEALTH_NOTE', 'CUST_NAME', 'CUST_COMPANY', 'CUST_PHONE', 'CUST_EMAIL', 'CUST_TAGS', 'IDENT_NAME', 'IDENT_USER',
      'IDENT_AVATAR', 'CONV_TITLE', 'BODY', 'SUBJECT', 'HEADER', 'NEED', 'NOTE', 'TASK', 'OAUTH', 'JOURNAL', 'INSTRUCTIONS', 'JOB_PAYLOAD',
      'EVENT_TEXT', 'EVENT_TITLE', 'EVENT_ERROR', 'EVENT_BODY', 'EVENT_REPLAY',
    ];
    for (const name of names) expect(dump, `${name} leaked in plaintext`).not.toContain(M(name));
    // non-sensitive lookup keys are plaintext by design, and the scrubbed event kept only the allowlisted id
    expect(dump).toContain('ok-id');

    // every marker still decrypts through the stores
    expect(stores.accounts.getAccount(acc.id)).toMatchObject({ label: M('ACCOUNT_LABEL'), healthNote: M('HEALTH_NOTE') });
    expect(stores.customers.getCustomer(cust.id)).toMatchObject({
      displayName: M('CUST_NAME'), company: M('CUST_COMPANY'), phone: M('CUST_PHONE'), email: M('CUST_EMAIL'), tags: M('CUST_TAGS'),
    });
    expect(stores.identities.getIdentity(identity.id)).toMatchObject({ displayName: M('IDENT_NAME'), username: M('IDENT_USER'), avatarUrl: M('IDENT_AVATAR') });
    expect(stores.conversations.getConversation(conv.id)!.title).toBe(M('CONV_TITLE'));
    const fetched = stores.messages.getMessage(msg.id)!;
    expect(fetched.text).toBe(M('BODY'));
    expect((fetched.metadata as any).headers['X-Secret']).toBe(M('HEADER'));
    expect(stores.profiles.getProfile(profile.id)).toMatchObject({ need: { details: M('NEED') }, note: M('NOTE') });
    expect(stores.tasks.getTask(task.id)!.title).toBe(M('TASK'));
    expect(stores.credentials.getCredential(acc.id, 'oauth_token')).toEqual({ token: M('OAUTH') });
    expect(stores.assignments.listAssignments(acc.id)[0].instructionsRef).toBe(M('INSTRUCTIONS'));
    expect(stores.events.getReplay(acc.id, 'e1')).toEqual({ detail: M('EVENT_REPLAY') });
    expect(stores.events.getEvent(acc.id, 'e1')!.payload).toEqual({ nativeMessageId: 'ok-id' });

    // all encrypted cells have the iv:tag:data shape
    const rawMsg = raw.prepare('SELECT body_enc, metadata_enc FROM care_messages WHERE id = ?').get(msg.id) as any;
    expect(rawMsg.body_enc.split(':')).toHaveLength(3);
    expect(rawMsg.metadata_enc.split(':')).toHaveLength(3);
    close();
  });

  it('the wrong key cannot read any encrypted entity (fail closed, no plaintext fallback)', () => {
    const f = createTestCareDatabase(':memory:', testKeyA);
    const acc = f.stores.accounts.createAccount({ channel: 'zalo', connectorKind: 'k', nativeAccountId: 'n', label: 'Shop label' });
    f.stores.customers.createCustomer({ displayName: 'Alice' }, 'c1');
    const other = createTestCareDatabase(':memory:', testKeyB);
    // same rows, different key
    const rows = f.rawDbForTestIsolationOnly.prepare('SELECT * FROM care_accounts').all() as any[];
    other.rawDbForTestIsolationOnly.prepare(
      `INSERT INTO care_accounts (id, channel, connector_kind, native_account_id, label_enc, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1)`,
    ).run(rows[0].id, rows[0].channel, rows[0].connector_kind, rows[0].native_account_id, rows[0].label_enc);
    expect(() => other.stores.accounts.getAccount(acc.id)).toThrowError(CareError);
    f.close();
    other.close();
  });

  it('event payloads are an allowlist of ID-only scalars (no text, titles, notes or nested objects)', () => {
    const scrubbed = scrubEventPayload({
      messageId: 'm1', nativeMessageId: 'n1', outcome: 'created', sentAtMs: 12,
      text: 'body', title: 'T', subject: 'S', errorNote: 'E', name: 'N', metadata: { a: 1 },
      kind: { nested: true }, nativeVersion: 'x'.repeat(300), errorCode: 'not a code!',
    });
    expect(scrubbed).toEqual({ messageId: 'm1', nativeMessageId: 'n1', outcome: 'created', sentAtMs: 12 });
    expect(scrubEventPayload({ errorCode: 'AUTH_EXPIRED' })).toEqual({ errorCode: 'AUTH_EXPIRED' });
    expect(scrubEventPayload(undefined)).toEqual({});
  });

  it('BCC is stripped (any case) from persisted message metadata and never reaches DB, timeline or ledger', () => {
    const { stores, rawDbForTestIsolationOnly: raw, close } = createTestCareDatabase(':memory:', testKeyA);
    const account = createEligibleAccount(stores, { channel: 'email', connectorKind: 'gmail-composio', nativeAccountId: 'me@shop.vn' });
    assignAuto(stores, account);
    const ingest = new CareIngestPipeline(raw, stores);
    const dirty = emailMessage(account, {
      text: 'visible body',
      metadata: {
        type: 'email', subject: 'Re', from: 'a@b.co', to: ['me@shop.vn'], cc: ['team@shop.vn'],
        bcc: ['BCC_LEAK_1@secret.example'],
        headers: { Bcc: 'BCC_LEAK_2@secret.example', BCC: 'BCC_LEAK_3@secret.example', 'x-original-bcc': 'BCC_LEAK_4@secret.example', 'Message-Id': '<id@x>' },
      } as never,
    });
    const res = ingest.ingestNormalizedMessage(dirty, undefined, 1);

    const dump = dumpCareTables(raw);
    expect(dump).not.toMatch(/BCC_LEAK/);
    const stored = stores.messages.getMessage(res.messageId!)!;
    expect(JSON.stringify(stored)).not.toMatch(/BCC_LEAK/i);
    expect(JSON.stringify(stored.metadata)).not.toMatch(/bcc/i);
    expect((stored.metadata as any).headers['Message-Id']).toBe('<id@x>'); // other headers survive
    expect((stored.metadata as any).cc).toEqual(['team@shop.vn']);

    // also stripped on the update path (edit) and from chat raw envelopes
    ingest.ingestNormalizedEvent({
      type: 'message.edited', eventId: 'ed', accountId: account.id, timestampMs: 1, epoch: 1,
      message: { ...dirty, nativeVersion: '2', metadata: { ...(dirty.metadata as object), headers: { BCC: 'BCC_LEAK_5@secret.example' } } as never },
    });
    expect(dumpCareTables(raw)).not.toMatch(/BCC_LEAK/);
    close();
  });

  it('a chat raw envelope with a bcc key is cleaned before persistence', () => {
    const { stores, rawDbForTestIsolationOnly: raw, close } = createTestCareDatabase(':memory:', testKeyA);
    const account = createEligibleAccount(stores);
    const ingest = new CareIngestPipeline(raw, stores);
    const res = ingest.ingestNormalizedMessage(
      chatMessage(account, { metadata: { type: 'chat', rawEnvelope: { data: { Bcc: 'RAW_BCC_LEAK', keep: 1 } } } as never }),
      undefined,
      1,
    );
    expect(JSON.stringify(stores.messages.getMessage(res.messageId!)!.metadata)).toBe('{"type":"chat","rawEnvelope":{"data":{"keep":1}}}');
    close();
  });

  it('masks secrets so credentials do not leak in DTOs or logs', () => {
    expect(maskSecret('secret123456789')).toBe('sec...789');
    expect(maskSecret('short')).toBe('********');
    expect(maskSecret('')).toBe('');
  });
});
