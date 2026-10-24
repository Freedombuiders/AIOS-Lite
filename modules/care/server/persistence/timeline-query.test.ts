/**
 * Customer timeline query (audit.timelineMessageIds), rewritten from one OR over every conversation into three index
 * lookups (D3). The pre-rewrite statement is kept here as the ORACLE and the two must agree on every page, on every kind
 * of membership: the customer's own messages anywhere (groups too), everything in direct / email-thread conversations the
 * customer is primary of or spoke in, but nothing else (other speakers in a group, other customers, deleted rows).
 */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { CareIngestPipeline } from '../application/ingest.js';
import { createCareStores } from './index.js';
import { createCareSchema } from './schema.js';
import { chatMessage, createEligibleAccount, emailMessage, TEST_KEY } from '../test-fixtures.js';

const open: Database.Database[] = [];
afterEach(() => open.splice(0).forEach((db) => db.close()));

const ORACLE = `SELECT m.id AS id, m.sent_at AS sent_at FROM care_messages m
  WHERE m.is_deleted = 0 AND m.tombstone = 0 AND m.account_id IN (__MARKS__)
    AND (m.sender_identity_id IN (SELECT id FROM care_identities WHERE customer_id = ?)
         OR m.conversation_id IN (SELECT cv.id FROM care_conversations cv WHERE cv.kind IN ('direct','email_thread')
              AND (cv.primary_customer_id = ? OR EXISTS (SELECT 1 FROM care_messages x JOIN care_identities i ON i.id = x.sender_identity_id
                                                         WHERE x.conversation_id = cv.id AND i.customer_id = ?))))
    __CURSOR__ __ONE__ ORDER BY m.sent_at DESC, m.id DESC LIMIT ?`;

function world() {
  const db = new Database(':memory:');
  open.push(db);
  createCareSchema(db);
  const stores = createCareStores(db, TEST_KEY);
  const ingest = new CareIngestPipeline(db, stores);
  const put = (m: Parameters<CareIngestPipeline['ingestNormalizedMessage']>[0]) => ingest.ingestNormalizedMessage(m, undefined, 1);
  const zA = createEligibleAccount(stores, { channel: 'zalo', nativeAccountId: 'zalo-A' });
  const zB = createEligibleAccount(stores, { channel: 'zalo', nativeAccountId: 'zalo-B' });
  const mail = createEligibleAccount(stores, { channel: 'email', nativeAccountId: 'shop@example.com' });
  let t = 10_000;
  const at = () => (t += 1_000);

  // customer X: direct chat on A (inbound + operator replies), a group on A where X and Y both speak, an email thread
  put(chatMessage(zA, { senderIdentityKey: 'x', externalConversationKey: 'dm:x', nativeMessageId: 'x1', sentAtMs: at(), text: 'x hello' }));
  put(chatMessage(zA, { senderIdentityKey: 'op', direction: 'out', senderRole: 'operator', externalConversationKey: 'dm:x', nativeMessageId: 'x2', sentAtMs: at(), text: 'op reply' }));
  put(chatMessage(zA, { senderIdentityKey: 'x', externalConversationKey: 'dm:x', nativeMessageId: 'x3', sentAtMs: 20_000, text: 'tie 1' }));
  put(chatMessage(zA, { senderIdentityKey: 'op', direction: 'out', senderRole: 'operator', externalConversationKey: 'dm:x', nativeMessageId: 'x4', sentAtMs: 20_000, text: 'tie 2' }));
  put(chatMessage(zA, { senderIdentityKey: 'x', externalConversationKey: 'grp:1', nativeMessageId: 'g1', sentAtMs: at(), text: 'x in group' }));
  put(chatMessage(zA, { senderIdentityKey: 'y', externalConversationKey: 'grp:1', nativeMessageId: 'g2', sentAtMs: at(), text: 'y in group (not X)' }));
  put(chatMessage(zA, { senderIdentityKey: 'x', externalConversationKey: 'grp:1', nativeMessageId: 'g3', sentAtMs: at(), text: 'x again in group' }));
  put(emailMessage(mail, { senderIdentityKey: 'x@example.com', externalConversationKey: 'thread:1', nativeMessageId: 'e1', sentAtMs: at(), text: 'mail from x' }));
  put(emailMessage(mail, { senderIdentityKey: 'shop@example.com', direction: 'out', senderRole: 'operator', externalConversationKey: 'thread:1', nativeMessageId: 'e2', sentAtMs: at(), text: 'mail reply' }));
  // customer Y: own direct chat, plus the same native id on the OTHER zalo account (never merged)
  put(chatMessage(zA, { senderIdentityKey: 'y', externalConversationKey: 'dm:y', nativeMessageId: 'y1', sentAtMs: at(), text: 'y dm' }));
  put(chatMessage(zB, { senderIdentityKey: 'x', externalConversationKey: 'dm:xb', nativeMessageId: 'xb1', sentAtMs: at(), text: 'other account same native id' }));

  // the fixture connector infers 'direct' from the key; a real group conversation is marked by the connector
  db.prepare(`UPDATE care_conversations SET kind = 'group' WHERE external_key = 'grp:1'`).run();
  const customerOf = (accountId: string, kind: string, key: string) => stores.identities.getIdentityByExternal(accountId, kind as 'user', key)!.customerId;
  const X = customerOf(zA.id, 'user', 'x');
  const Y = customerOf(zA.id, 'user', 'y');
  const Z = customerOf(mail.id, 'email', 'x@example.com'); // a different customer until an operator links the identities
  // X is the PRIMARY customer of a direct conversation where X never spoke (only an operator message exists)
  put(chatMessage(zA, { senderIdentityKey: 'op', direction: 'out', senderRole: 'operator', externalConversationKey: 'dm:quiet', nativeMessageId: 'q1', sentAtMs: at(), text: 'quiet conversation, X is primary' }));
  db.prepare(`UPDATE care_conversations SET primary_customer_id = ? WHERE account_id = ? AND external_key = 'dm:quiet'`).run(X, zA.id);
  // a deleted row and a tombstoned row inside X's direct conversation must never show
  put(chatMessage(zA, { senderIdentityKey: 'x', externalConversationKey: 'dm:x', nativeMessageId: 'gone1', sentAtMs: at(), text: 'deleted' }));
  put(chatMessage(zA, { senderIdentityKey: 'x', externalConversationKey: 'dm:x', nativeMessageId: 'gone2', sentAtMs: at(), text: 'tombstoned' }));
  db.prepare(`UPDATE care_messages SET is_deleted = 1 WHERE native_message_id = 'gone1'`).run();
  db.prepare(`UPDATE care_messages SET tombstone = 1 WHERE native_message_id = 'gone2'`).run();

  const oracle = (customerId: string, accountIds: string[], limit: number, before?: { sentAtMs: number; id: string }, messageId?: string) => {
    const params: unknown[] = [...accountIds, customerId, customerId, customerId];
    let cursor = '';
    if (before) {
      cursor = 'AND (m.sent_at < ? OR (m.sent_at = ? AND m.id < ?))';
      params.push(before.sentAtMs, before.sentAtMs, before.id);
    }
    if (messageId) params.push(messageId);
    params.push(limit);
    const sql = ORACLE.replace('__MARKS__', accountIds.map(() => '?').join(',')).replace('__CURSOR__', cursor).replace('__ONE__', messageId ? 'AND m.id = ?' : '');
    return (db.prepare(sql).all(...params) as Array<{ id: string; sent_at: number }>).map((r) => ({ id: r.id, sentAtMs: Number(r.sent_at) }));
  };
  const text = (ids: Array<{ id: string }>) => ids.map((r) => stores.messages.getMessage(r.id)?.text);
  return { db, stores, zA, zB, mail, X, Y, Z, oracle, text };
}

describe('customer timeline: three index lookups equal the pre-rewrite OR query', () => {
  it('first page, every account subset, both customers: same ids in the same order', () => {
    const w = world();
    const all = [w.zA.id, w.zB.id, w.mail.id];
    for (const customerId of [w.X, w.Y, w.Z]) {
      for (const accountIds of [all, [w.zA.id], [w.zB.id], [w.mail.id], [w.zA.id, w.mail.id]]) {
        expect(w.stores.audit.timelineMessageIds({ customerId, accountIds, limit: 100 })).toEqual(w.oracle(customerId, accountIds, 100));
      }
    }
  });

  it('membership: own group messages yes, other speakers in the group no, quiet primary conversation yes, deleted/tombstoned no', () => {
    const w = world();
    const rows = w.stores.audit.timelineMessageIds({ customerId: w.X, accountIds: [w.zA.id, w.mail.id], limit: 100 });
    const texts = w.text(rows);
    expect(texts).toEqual(expect.arrayContaining(['x hello', 'op reply', 'x in group', 'x again in group', 'quiet conversation, X is primary']));
    expect(texts).not.toContain('mail from x'); // the email identity belongs to another customer
    expect(w.text(w.stores.audit.timelineMessageIds({ customerId: w.Z, accountIds: [w.mail.id], limit: 100 }))).toEqual(['mail reply', 'mail from x']);
    expect(texts).not.toContain('y in group (not X)');
    expect(texts).not.toContain('y dm');
    expect(texts).not.toContain('deleted');
    expect(texts).not.toContain('tombstoned');
    expect(texts).not.toContain('other account same native id'); // other account is not asked for
    expect(w.text(w.stores.audit.timelineMessageIds({ customerId: w.Y, accountIds: [w.zA.id], limit: 100 }))).toEqual(expect.arrayContaining(['y dm', 'y in group (not X)']));
  });

  it('keyset paging through ties (same sent_at) visits every row exactly once and matches the oracle page by page', () => {
    const w = world();
    const accountIds = [w.zA.id, w.zB.id, w.mail.id];
    const seen: string[] = [];
    let before: { sentAtMs: number; id: string } | undefined;
    for (let page = 0; page < 20; page += 1) {
      const got = w.stores.audit.timelineMessageIds({ customerId: w.X, accountIds, limit: 3, ...(before ? { before } : {}) });
      expect(got).toEqual(w.oracle(w.X, accountIds, 3, before));
      if (got.length === 0) break;
      seen.push(...got.map((r) => r.id));
      before = { sentAtMs: got[got.length - 1].sentAtMs, id: got[got.length - 1].id };
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(w.oracle(w.X, accountIds, 100).map((r) => r.id));
  });

  it('membership check for one message (reply targets) agrees with the oracle', () => {
    const w = world();
    const accountIds = [w.zA.id, w.zB.id, w.mail.id];
    const rows = w.stores.audit.timelineMessageIds({ customerId: w.X, accountIds, limit: 100 });
    const outsider = w.db.prepare(`SELECT id FROM care_messages WHERE native_message_id = 'y1'`).get() as { id: string };
    for (const id of [rows[0].id, rows[rows.length - 1].id, outsider.id]) {
      expect(w.stores.audit.timelineMessageIds({ customerId: w.X, accountIds, limit: 1, messageId: id })).toEqual(w.oracle(w.X, accountIds, 1, undefined, id));
    }
    expect(w.stores.audit.timelineMessageIds({ customerId: w.X, accountIds, limit: 1, messageId: outsider.id })).toEqual([]);
  });

  it('empty account list and unknown customer return nothing', () => {
    const w = world();
    expect(w.stores.audit.timelineMessageIds({ customerId: w.X, accountIds: [], limit: 10 })).toEqual([]);
    expect(w.stores.audit.timelineMessageIds({ customerId: 'nobody', accountIds: [w.zA.id], limit: 10 })).toEqual([]);
  });

  it('the plan uses the sender / primary-customer / timeline indexes and never scans care_messages or care_conversations', () => {
    const w = world();
    const captured: string[] = [];
    const orig = w.db.prepare.bind(w.db);
    (w.db as unknown as { prepare: (s: string) => unknown }).prepare = (sql: string) => {
      if (/WITH ident/.test(sql)) captured.push(sql);
      return orig(sql);
    };
    const before = { sentAtMs: 99_999_999, id: 'zzz' };
    w.stores.audit.timelineMessageIds({ customerId: w.X, accountIds: [w.zA.id, w.mail.id], limit: 10 });
    w.stores.audit.timelineMessageIds({ customerId: w.X, accountIds: [w.zA.id, w.mail.id], limit: 10, before });
    expect(captured.length).toBe(2);
    // plan text from the same statement shapes (bound with the real parameter counts)
    const plan = (cursor: boolean) => {
      const sql = captured[cursor ? 1 : 0];
      const n = (sql.match(/\?/g) ?? []).length;
      const params: unknown[] = [w.X, w.X, w.zA.id, w.mail.id, ...(cursor ? [1, 1, 'a'] : []), w.zA.id, w.mail.id, ...(cursor ? [1, 1, 'a'] : []), 10];
      expect(params.length).toBe(n);
      return (orig(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map((r) => r.detail);
    };
    for (const cursor of [false, true]) {
      const lines = plan(cursor);
      expect(lines.join('\n')).toMatch(/idx_care_messages_sender/);
      expect(lines.join('\n')).toMatch(/idx_care_messages_timeline/);
      expect(lines.join('\n')).toMatch(/idx_care_conversations_customer/);
      // a SCAN of a real table would show up as "SCAN m" / "SCAN cv" (CTE / co-routine scans are result sets)
      expect(lines.filter((l) => /^SCAN (m|cv|care_messages|care_conversations)\b/.test(l)), `cursor=${cursor}`).toEqual([]);
      expect(lines.filter((l) => /MULTI-INDEX OR/.test(l)), `cursor=${cursor}`).toEqual([]);
    }
  });
});
