/**
 * `waiting_since` of the conversation projection is computed in one pass (waitingSince). It must equal the nested
 * NOT EXISTS statement it replaced on every combination of the three answering rules (explicit linkage, native order,
 * timestamps) including the "unordered" corners. The old statement is kept here as the ORACLE and a seeded random
 * generator drives both over many small conversations.
 */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createCareStores } from './index.js';
import { createCareSchema } from './schema.js';
import { createEligibleAccount, TEST_KEY } from '../test-fixtures.js';

const open: Database.Database[] = [];
afterEach(() => open.splice(0).forEach((db) => db.close()));

const ORACLE = `SELECT MIN(q.sent_at) AS since FROM care_messages q
  WHERE q.conversation_id = @c AND q.is_deleted = 0 AND q.direction = 'in'
    AND q.sender_role = 'customer' AND q.live_observed = 1
    AND (@mention = 0 OR q.directed_at_account = 1)
    AND NOT EXISTS (
      SELECT 1 FROM care_messages r
      WHERE r.conversation_id = q.conversation_id AND r.is_deleted = 0 AND r.direction = 'out'
        AND r.sender_role IN ('operator','agent','self')
        AND (
          (r.reply_to_ref IS NOT NULL AND (r.reply_to_ref = q.native_message_id OR r.reply_to_ref = q.ref_id))
          OR (r.native_message_namespace = q.native_message_namespace
              AND r.native_order_key IS NOT NULL AND q.native_order_key IS NOT NULL
              AND r.native_order_key > q.native_order_key)
          OR ((r.native_message_namespace <> q.native_message_namespace
               OR r.native_order_key IS NULL OR q.native_order_key IS NULL)
              AND r.sent_at > q.sent_at)
        )
    )`;

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('waiting_since: one-pass projection equals the nested NOT EXISTS oracle', () => {
  it('2 000 random conversations (mixed namespaces, missing order keys, linkage, ties, deleted rows, groups)', () => {
    const db = new Database(':memory:');
    open.push(db);
    createCareSchema(db);
    const stores = createCareStores(db, TEST_KEY);
    const zalo = createEligibleAccount(stores, { channel: 'zalo', nativeAccountId: 'z' });
    const rand = prng(20261010);
    const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
    const insert = db.prepare(
      `INSERT INTO care_messages (id, conversation_id, account_id, native_message_namespace, native_message_id, direction, sender_role,
         body_enc, metadata_enc, origin, sent_at, native_order_key, ref_id, reply_to_ref, live_observed, directed_at_account, is_deleted, tombstone, created_at)
       VALUES (@id, @conv, @acc, @ns, @nid, @dir, @role, 'b', 'm', 'live', @sent, @key, @ref, @reply, @live, @directed, @deleted, 0, 1)`,
    );
    const namespaces = ['zalo_direct', 'zalo_group'];
    let answeredCases = 0;
    let waitingCases = 0;
    for (let c = 0; c < 2000; c += 1) {
      const kind = c % 4 === 0 ? 'group' : 'direct';
      const conv = stores.conversations.upsertConversation({ accountId: zalo.id, externalKey: `k${c}`, kind, title: 't' });
      const n = 1 + Math.floor(rand() * 9);
      for (let i = 0; i < n; i += 1) {
        const inbound = rand() < 0.55;
        const hasKey = rand() < 0.6;
        const nid = `${c}-${i}`;
        insert.run({
          id: `m${c}-${i}`,
          conv: conv.id,
          acc: zalo.id,
          ns: pick(namespaces),
          nid,
          dir: inbound ? 'in' : 'out',
          role: inbound ? (rand() < 0.9 ? 'customer' : 'system') : pick(['operator', 'agent', 'self', 'operator', 'system']),
          sent: 1_000 + Math.floor(rand() * 8) * 10, // few distinct values => many ties
          key: hasKey ? String(Math.floor(rand() * 12)).padStart(40, '0') : null,
          ref: rand() < 0.3 ? `ref-${c}-${Math.floor(rand() * 4)}` : null,
          reply: !inbound && rand() < 0.35 ? pick([`${c}-${Math.floor(rand() * n)}`, `ref-${c}-${Math.floor(rand() * 4)}`, 'unrelated']) : null,
          live: inbound ? (rand() < 0.8 ? 1 : 0) : 1,
          directed: rand() < 0.5 ? 1 : 0,
          deleted: rand() < 0.1 ? 1 : 0,
        });
      }
      const expected = (db.prepare(ORACLE).get({ c: conv.id, mention: kind === 'group' ? 1 : 0 }) as { since: number | null }).since;
      const got = stores.conversations.recomputeProjection(conv.id).waitingSinceMs;
      expect(got ?? null, `conversation ${c} (${kind})`).toBe(expected ?? null);
      if (expected === null) answeredCases += 1;
      else waitingCases += 1;
    }
    // the generator must exercise both outcomes, or the comparison proves nothing
    expect(answeredCases).toBeGreaterThan(200);
    expect(waitingCases).toBeGreaterThan(200);
  });

  it('a 3 000-message conversation: same answer, and the one-pass projection is not slower than the quadratic oracle', () => {
    const db = new Database(':memory:');
    open.push(db);
    createCareSchema(db);
    const stores = createCareStores(db, TEST_KEY);
    const zalo = createEligibleAccount(stores, { channel: 'zalo', nativeAccountId: 'z' });
    const conv = stores.conversations.upsertConversation({ accountId: zalo.id, externalKey: 'big', kind: 'direct', title: 't' });
    const insert = db.prepare(
      `INSERT INTO care_messages (id, conversation_id, account_id, native_message_namespace, native_message_id, direction, sender_role,
         body_enc, metadata_enc, origin, sent_at, native_order_key, live_observed, directed_at_account, is_deleted, tombstone, created_at)
       VALUES (?, ?, ?, 'zalo_chat', ?, ?, ?, 'b', 'm', 'live', ?, ?, 1, 0, 0, 0, 1)`,
    );
    db.transaction(() => {
      // customers keep writing, the operator answers only the first half: the second half stays waiting
      for (let i = 0; i < 3000; i += 1) {
        const inbound = i % 3 !== 0;
        insert.run(`b${i}`, conv.id, zalo.id, `n${i}`, inbound ? 'in' : 'out', inbound ? 'customer' : 'operator', 1_000 + i, String(i).padStart(40, '0'));
      }
    })();
    db.prepare(`DELETE FROM care_messages WHERE direction = 'out' AND sent_at > 2000`).run(); // no operator reply in the second half
    const t0 = performance.now();
    const expected = (db.prepare(ORACLE).get({ c: conv.id, mention: 0 }) as { since: number | null }).since;
    const oracleMs = performance.now() - t0;
    const t1 = performance.now();
    const got = stores.conversations.recomputeProjection(conv.id).waitingSinceMs;
    const newMs = performance.now() - t1;
    expect(got).toBe(expected);
    expect(got).not.toBeNull();
    // measured, not asserted tightly: the oracle is quadratic in the conversation, the rewrite is one pass
    console.info(`[waiting_since 3000 msgs] oracle ${oracleMs.toFixed(1)} ms, one-pass recompute ${newMs.toFixed(1)} ms`);
    expect(newMs).toBeLessThan(oracleMs);
  });
});
