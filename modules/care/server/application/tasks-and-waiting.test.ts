/**
 * CC-19 tasks / owner label / waiting metrics (AC-007, AC-017, AC-033). Synthetic data in a temp-file DB only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { CareError } from '../../../_lib/care-kit/errors.js';
import type { NormalizedMessage } from '../../../_lib/care-kit/types.js';
import { createCareStores, type CareStores } from '../persistence/index.js';
import { createCareSchema } from '../persistence/schema.js';
import { chatMessage, createEligibleAccount, TEST_KEY } from '../test-fixtures.js';
import { CareIngestPipeline } from './ingest.js';
import { CareCustomerOps } from './customer-ops.js';
import {
  CareTaskService,
  endOfLocalDayMs,
  isOverdue,
  listWaiting,
  localDayBoundsMs,
  overdueTasksByAccount,
  overdueTasksByOwner,
  startOfLocalDayMs,
  waitingByAccount,
  waitingByOwner,
} from './tasks-and-waiting.js';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));

function caught(fn: () => unknown): CareError {
  try {
    fn();
  } catch (err) {
    return err as CareError;
  }
  throw new Error('expected the call to throw');
}

function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'care-tasks-waiting-'));
  const file = path.join(dir, 'care.db');
  const open = () => {
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    createCareSchema(db);
    const stores: CareStores = createCareStores(db, TEST_KEY);
    return { db, stores };
  };
  const { db, stores } = open();
  cleanups.push(() => {
    try {
      db.close();
    } catch {
      /* already closed by the restart test */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const ingest = new CareIngestPipeline(db, stores);
  const tasks = new CareTaskService(db, stores);
  const zA = createEligibleAccount(stores, { channel: 'zalo', nativeAccountId: 'zalo-A' });
  const zB = createEligibleAccount(stores, { channel: 'zalo', nativeAccountId: 'zalo-B' });

  let n = 0;
  const put = (m: NormalizedMessage) => ingest.ingestNormalizedMessage(m, undefined, 1);
  const inbound = (acc: typeof zA, conv: string, at: number, over: Partial<NormalizedMessage> = {}) => {
    n += 1;
    return put(chatMessage(acc, { externalConversationKey: conv, nativeMessageId: `in-${n}`, senderIdentityKey: `who-${conv}`, sentAtMs: at, ...over }));
  };
  const outbound = (acc: typeof zA, conv: string, at: number, role: 'operator' | 'agent' | 'self' | 'system' = 'operator', over: Partial<NormalizedMessage> = {}) => {
    n += 1;
    return put(chatMessage(acc, { externalConversationKey: conv, nativeMessageId: `out-${n}`, direction: 'out', senderRole: role, senderIdentityKey: null, sentAtMs: at, ...over }));
  };
  const conv = (acc: typeof zA, key: string) => stores.conversations.getConversationByExternalKey(acc.id, key)!;
  return { db, stores, ingest, tasks, zA, zB, put, inbound, outbound, conv, file, reopen: open };
}

describe('tasks (AC-017)', () => {
  function seeded() {
    const w = world();
    w.inbound(w.zA, 'peer:1', 1_000, { senderIdentityKey: 'cust-1', nativeMessageId: 'q1' });
    w.inbound(w.zB, 'peer:2', 1_100, { senderIdentityKey: 'cust-2', nativeMessageId: 'q2' });
    const idA = w.stores.identities.getIdentityByExternal(w.zA.id, 'user', 'cust-1')!;
    const idB = w.stores.identities.getIdentityByExternal(w.zB.id, 'user', 'cust-2')!;
    return { w, c1: idA.customerId, c2: idB.customerId, conv1: w.conv(w.zA, 'peer:1'), conv2: w.conv(w.zB, 'peer:2'),
      q1: w.stores.messages.getMessageByNativeId(w.zA.id, 'zalo_chat', 'q1')!, q2: w.stores.messages.getMessageByNativeId(w.zB.id, 'zalo_chat', 'q2')! };
  }

  it('creates customer-wide, account and conversation scoped tasks with a source message link', () => {
    const { w, c1, conv1, q1 } = seeded();
    const wide = w.tasks.createTask({ customerId: c1, title: 'send brochure', dueAtMs: 5_000 });
    const acct = w.tasks.createTask({ customerId: c1, title: 'renew contract', dueAtMs: 6_000, accountId: w.zA.id });
    const conv = w.tasks.createTask({ customerId: c1, title: 'answer the question', dueAtMs: 7_000, sourceMessageId: q1.id, owner: '  lan  ' });
    expect(wide).toMatchObject({ scope: 'customer', accountId: null, conversationId: null, owner: null, done: false, revision: 1 });
    expect(acct).toMatchObject({ scope: 'account', accountId: w.zA.id, conversationId: null });
    expect(conv).toMatchObject({ scope: 'conversation', accountId: w.zA.id, conversationId: conv1.id, sourceMessageId: q1.id, owner: 'lan' });

    expect(w.tasks.listTasks({ customerId: c1, scope: 'account' }).map((t) => t.id)).toEqual([acct.id]);
    expect(w.tasks.listTasks({ accountId: w.zA.id }).map((t) => t.id).sort()).toEqual([acct.id, conv.id].sort());
    expect(w.tasks.listTasks({ conversationId: conv1.id }).map((t) => t.id)).toEqual([conv.id]);
    expect(w.tasks.listTasks({ owner: 'lan' }).map((t) => t.id)).toEqual([conv.id]);
    expect(w.tasks.listTasks({ owner: null }).map((t) => t.id).sort()).toEqual([wide.id, acct.id].sort());
  });

  it('rejects source links across accounts and across people', () => {
    const { w, c1, c2, conv1, conv2, q1, q2 } = seeded();
    const bad = (input: Parameters<CareTaskService['createTask']>[0]) => caught(() => w.tasks.createTask(input));
    expect(bad({ customerId: c1, title: 't', dueAtMs: 1, conversationId: conv2.id }).code).toBe('INVALID_TARGET'); // someone else's conversation
    expect(bad({ customerId: c1, title: 't', dueAtMs: 1, sourceMessageId: q2.id }).code).toBe('INVALID_TARGET'); // someone else's message
    expect(bad({ customerId: c1, title: 't', dueAtMs: 1, sourceMessageId: q1.id, accountId: w.zB.id }).code).toBe('INVALID_TARGET'); // cross-account
    expect(bad({ customerId: c1, title: 't', dueAtMs: 1, sourceMessageId: q1.id, conversationId: conv2.id }).code).toBe('INVALID_TARGET');
    expect(bad({ customerId: c1, title: 't', dueAtMs: 1, conversationId: conv1.id, accountId: w.zB.id }).code).toBe('INVALID_TARGET');
    expect(bad({ customerId: c1, title: 't', dueAtMs: 1, accountId: w.zB.id }).code).toBe('INVALID_TARGET'); // no identity there
    expect(bad({ customerId: c2, title: 't', dueAtMs: 1, conversationId: conv1.id }).code).toBe('INVALID_TARGET');
    expect(bad({ customerId: 'nobody', title: 't', dueAtMs: 1 }).code).toBe('INVALID_TARGET');
    expect(bad({ customerId: c1, title: '', dueAtMs: 1 }).code).toBe('INVALID_COMMAND');
    expect(bad({ customerId: c1, title: 't', dueAtMs: -1 }).code).toBe('INVALID_COMMAND');
    expect(w.tasks.listTasks()).toEqual([]); // nothing half-created
  });

  it("in a group a source message must be the customer's own", () => {
    const w = world();
    const g = (id: string, who: string) =>
      w.put(chatMessage(w.zA, { externalConversationKey: 'g:1', nativeMessageId: id, senderIdentityKey: who, sentAtMs: 2_000, metadata: { type: 'chat', conversationKind: 'group' } }));
    g('mine', 'u-1');
    g('theirs', 'u-2');
    const c1 = w.stores.identities.getIdentityByExternal(w.zA.id, 'user', 'u-1')!.customerId;
    const mine = w.stores.messages.getMessageByNativeId(w.zA.id, 'zalo_chat', 'mine')!;
    const theirs = w.stores.messages.getMessageByNativeId(w.zA.id, 'zalo_chat', 'theirs')!;
    expect(w.tasks.createTask({ customerId: c1, title: 'from my message', dueAtMs: 1, sourceMessageId: mine.id }).scope).toBe('conversation');
    expect(caught(() => w.tasks.createTask({ customerId: c1, title: 'from theirs', dueAtMs: 1, sourceMessageId: theirs.id })).code).toBe('INVALID_TARGET');
  });

  it('update / done / owner are optimistic: a stale revision is a 409 and changes nothing', () => {
    const { w, c1 } = seeded();
    const t = w.tasks.createTask({ customerId: c1, title: 'first', dueAtMs: 5_000 });
    const edited = w.tasks.updateTask(t.id, { title: 'second', dueAtMs: 8_000 }, t.revision);
    expect(edited).toMatchObject({ title: 'second', dueAtMs: 8_000, revision: t.revision + 1 });
    const stale = caught(() => w.tasks.updateTask(t.id, { title: 'lost update' }, t.revision));
    expect(stale).toMatchObject({ code: 'STALE_REVISION', status: 409 });
    expect((stale.details as any).currentRevision).toBe(edited.revision);
    expect(w.tasks.getTask(t.id)!.title).toBe('second');

    const owned = w.tasks.setOwner(t.id, 'minh', edited.revision);
    const done = w.tasks.setDone(t.id, true, owned.revision);
    expect(done).toMatchObject({ owner: 'minh', done: true, revision: owned.revision + 1 });
    const noop = w.tasks.updateTask(t.id, { done: true }, done.revision);
    expect(noop.revision).toBe(done.revision); // nothing changed, nothing bumped
    expect(w.tasks.setOwner(t.id, '  ', noop.revision).owner).toBeNull();
    expect(caught(() => w.tasks.updateTask('missing', {}, 1)).code).toBe('NOT_FOUND');
    expect(caught(() => w.tasks.updateTask(t.id, {}, Number.NaN)).code).toBe('INVALID_COMMAND');
  });

  it('the owner is only a label: any string works and nothing is authorized by it', () => {
    const { w, c1 } = seeded();
    const t = w.tasks.createTask({ customerId: c1, title: 'x', dueAtMs: 1, owner: 'not-a-real-user@nowhere' });
    expect(t.owner).toBe('not-a-real-user@nowhere');
    expect(caught(() => w.tasks.createTask({ customerId: c1, title: 'x', dueAtMs: 1, owner: 'y'.repeat(200) })).code).toBe('INVALID_COMMAND');
  });

  it('due / done / overdue: open and strictly past due', () => {
    const { w, c1 } = seeded();
    const past = w.tasks.createTask({ customerId: c1, title: 'past', dueAtMs: 1_000 });
    const edge = w.tasks.createTask({ customerId: c1, title: 'exactly now', dueAtMs: 2_000 });
    const future = w.tasks.createTask({ customerId: c1, title: 'future', dueAtMs: 3_000 });
    const finished = w.tasks.createTask({ customerId: c1, title: 'finished', dueAtMs: 500 });
    w.tasks.setDone(finished.id, true, finished.revision);

    const views = w.tasks.listTasks({ customerId: c1 }, { nowMs: 2_000 });
    expect(Object.fromEntries(views.map((t) => [t.title, t.overdue]))).toEqual({ past: true, 'exactly now': false, future: false, finished: false });
    expect(w.tasks.listTasks({ overdueBeforeMs: 2_000 }).map((t) => t.id)).toEqual([past.id]);
    expect(w.tasks.listTasks({ done: true }).map((t) => t.id)).toEqual([finished.id]);
    expect(isOverdue(edge, 2_001)).toBe(true);
    expect(isOverdue(future, 2_000)).toBe(false);
  });

  it('pages by (due, id) keyset', () => {
    const { w, c1 } = seeded();
    for (let i = 0; i < 5; i += 1) w.tasks.createTask({ customerId: c1, title: `t${i}`, dueAtMs: 1_000 + i });
    const first = w.tasks.listTasks({ limit: 2 });
    const second = w.tasks.listTasks({ limit: 2, after: { dueAtMs: first[1].dueAtMs, id: first[1].id } });
    expect([...first, ...second].map((t) => t.title)).toEqual(['t0', 't1', 't2', 't3']);
  });

  it('tasks survive a restart (new connection, new stores) with scope metadata intact', () => {
    const { w, c1, q1 } = seeded();
    const t = w.tasks.createTask({ customerId: c1, title: 'after restart', dueAtMs: 1_500, sourceMessageId: q1.id, owner: 'lan' });
    w.db.close();
    const again = w.reopen();
    cleanups.push(() => again.db.close());
    const service = new CareTaskService(again.db, again.stores);
    expect(service.getTask(t.id, 9_999)).toMatchObject({ title: 'after restart', scope: 'conversation', sourceMessageId: q1.id, owner: 'lan', overdue: true });
  });

  it('a task scoped to a closed source is hidden from listings and aggregates', () => {
    const { w, c1, c2 } = seeded();
    const open = w.tasks.createTask({ customerId: c1, title: 'open source', dueAtMs: 1, accountId: w.zA.id });
    w.tasks.createTask({ customerId: c2, title: 'closed source', dueAtMs: 1, accountId: w.zB.id });
    const gate = (a: string) => a !== w.zB.id;
    expect(w.tasks.listTasks({}, { canReadSource: gate }).map((t) => t.id)).toEqual([open.id]);
    expect(overdueTasksByAccount(w.stores, { nowMs: 10, canReadSource: gate })).toEqual([{ accountId: w.zA.id, overdue: 1, oldestDueAtMs: 1 }]);
  });

  it('tasks follow the customer through a link and keep their scope metadata', () => {
    const { w, c1, c2, conv2 } = seeded();
    const t = w.tasks.createTask({ customerId: c2, title: 'about B chat', dueAtMs: 1, conversationId: conv2.id, owner: 'minh' });
    const ops = new CareCustomerOps(w.db, w.stores, { canReadSource: () => true });
    const idB = w.stores.identities.getIdentityByExternal(w.zB.id, 'user', 'cust-2')!;
    ops.link({
      identityIds: [idB.id], targetCustomerId: c1, keepTargetForUnresolved: true,
      expectedRevisions: { [c1]: w.stores.customers.getCustomer(c1)!.revision, [c2]: w.stores.customers.getCustomer(c2)!.revision },
    });
    expect(w.tasks.getTask(t.id)).toMatchObject({ customerId: c1, scope: 'conversation', accountId: w.zB.id, conversationId: conv2.id, owner: 'minh' });
  });
});

describe('time zone helpers', () => {
  it('turns a local calendar date into the right instants', () => {
    // Asia/Ho_Chi_Minh is UTC+7 with no DST.
    expect(startOfLocalDayMs('2026-03-10', 'Asia/Ho_Chi_Minh')).toBe(Date.UTC(2026, 2, 9, 17, 0, 0));
    expect(endOfLocalDayMs('2026-03-10', 'Asia/Ho_Chi_Minh')).toBe(Date.UTC(2026, 2, 10, 16, 59, 59, 999));
    // New York springs forward on 2026-03-08: that local day is only 23 hours long.
    const start = startOfLocalDayMs('2026-03-08', 'America/New_York');
    const end = endOfLocalDayMs('2026-03-08', 'America/New_York');
    expect(start).toBe(Date.UTC(2026, 2, 8, 5, 0, 0));
    expect(end - start + 1).toBe(23 * 3_600_000);
    expect(endOfLocalDayMs('2026-12-31', 'UTC')).toBe(Date.UTC(2026, 11, 31, 23, 59, 59, 999));
  });

  it('a task due at end of a local day is overdue only after the local day ends', () => {
    const due = endOfLocalDayMs('2026-03-10', 'Asia/Ho_Chi_Minh');
    expect(isOverdue({ done: false, dueAtMs: due }, Date.UTC(2026, 2, 10, 16, 0, 0))).toBe(false); // 23:00 local
    expect(isOverdue({ done: false, dueAtMs: due }, Date.UTC(2026, 2, 10, 17, 0, 0))).toBe(true); // 00:00 next day local
  });

  it('computes the local day containing an instant', () => {
    const now = Date.UTC(2026, 2, 10, 20, 0, 0); // 03:00 on 2026-03-11 in Ho Chi Minh
    expect(localDayBoundsMs(now, 'Asia/Ho_Chi_Minh')).toEqual({
      startMs: Date.UTC(2026, 2, 10, 17, 0, 0),
      endMs: Date.UTC(2026, 2, 11, 16, 59, 59, 999),
    });
    expect(caught(() => startOfLocalDayMs('10/03/2026', 'UTC')).code).toBe('INVALID_COMMAND');
  });
});

describe('waiting (AC-007)', () => {
  const SLA = 10_000;

  it('the SLA runs from the OLDEST unanswered inbound of a burst and is not reset by each new customer message', () => {
    const w = world();
    w.inbound(w.zA, 'peer:1', 100);
    expect(w.conv(w.zA, 'peer:1').waitingSinceMs).toBe(100);
    w.inbound(w.zA, 'peer:1', 5_000);
    w.inbound(w.zA, 'peer:1', 9_000);
    expect(w.conv(w.zA, 'peer:1').waitingSinceMs).toBe(100);

    const [item] = listWaiting(w.stores, { nowMs: 10_100, slaMs: SLA });
    expect(item).toMatchObject({ waitingSinceMs: 100, waitedMs: 10_000, breached: true });
    // measured from the newest message it would not be breached yet
    expect(10_100 - 9_000).toBeLessThan(SLA);
  });

  it('a local read does not resolve waiting; a reply from the operator, an agent or the account itself does', () => {
    const w = world();
    const q = w.inbound(w.zA, 'peer:read', 100);
    w.stores.conversations.markLocalSeen(w.conv(w.zA, 'peer:read').id, q.messageId!);
    expect(w.conv(w.zA, 'peer:read').waitingSinceMs).toBe(100);
    expect(listWaiting(w.stores, { nowMs: 500, slaMs: SLA })).toHaveLength(1);

    for (const [key, role] of [['peer:op', 'operator'], ['peer:agent', 'agent'], ['peer:self', 'self']] as const) {
      w.inbound(w.zA, key, 100);
      expect(w.conv(w.zA, key).waitingSinceMs).toBe(100);
      w.outbound(w.zA, key, 200, role);
      expect(w.conv(w.zA, key).waitingSinceMs).toBeNull();
    }
    expect(listWaiting(w.stores, { nowMs: 500, slaMs: SLA }).map((i) => i.conversationId)).toEqual([w.conv(w.zA, 'peer:read').id]);
  });

  it('a system message does not answer a customer; a new message after a reply restarts the clock at itself', () => {
    const w = world();
    w.inbound(w.zA, 'peer:1', 100);
    w.outbound(w.zA, 'peer:1', 150, 'system');
    expect(w.conv(w.zA, 'peer:1').waitingSinceMs).toBe(100);
    w.outbound(w.zA, 'peer:1', 200, 'operator');
    expect(w.conv(w.zA, 'peer:1').waitingSinceMs).toBeNull();
    w.inbound(w.zA, 'peer:1', 300);
    w.inbound(w.zA, 'peer:1', 310);
    expect(w.conv(w.zA, 'peer:1').waitingSinceMs).toBe(300);
  });

  it('history, recovery, system and echoed messages never create waiting', () => {
    const w = world();
    w.inbound(w.zA, 'peer:hist', 100, { origin: 'history' });
    w.inbound(w.zA, 'peer:rec', 100, { origin: 'recovery' });
    w.inbound(w.zA, 'peer:sys', 100, { senderRole: 'system' });
    w.outbound(w.zA, 'peer:echo', 100, 'self'); // our own send echoed back
    for (const key of ['peer:hist', 'peer:rec', 'peer:sys', 'peer:echo']) expect(w.conv(w.zA, key).waitingSinceMs).toBeNull();
    expect(listWaiting(w.stores, { nowMs: 100_000, slaMs: SLA })).toEqual([]);
  });

  it('group / topic messages wait only when directed at the account, and the scope can narrow further', () => {
    const w = world();
    const group = (key: string, at: number, mentions: Array<{ uid: string }> = []) =>
      w.inbound(w.zA, key, at, { metadata: { type: 'chat', conversationKind: 'group', mentions } as never });
    group('g:casual', 100);
    group('g:mention', 100, [{ uid: w.zA.nativeAccountId }]);
    group('g:other', 100, [{ uid: 'somebody-else' }]);
    group('g:scoped', 100, [{ uid: w.zA.nativeAccountId }]);
    expect(w.conv(w.zA, 'g:casual').waitingSinceMs).toBeNull();
    expect(w.conv(w.zA, 'g:other').waitingSinceMs).toBeNull();
    expect(listWaiting(w.stores, { nowMs: 500, slaMs: SLA }).map((i) => i.conversationId).sort()).toEqual(
      [w.conv(w.zA, 'g:mention').id, w.conv(w.zA, 'g:scoped').id].sort(),
    );
    const scoped = listWaiting(w.stores, { nowMs: 500, slaMs: SLA, groupInScope: (r) => r.conversationId === w.conv(w.zA, 'g:scoped').id });
    expect(scoped.map((i) => i.conversationId)).toEqual([w.conv(w.zA, 'g:scoped').id]);
    // a narrowing predicate never adds rows the projection did not mark waiting
    expect(listWaiting(w.stores, { nowMs: 500, slaMs: SLA, groupInScope: () => true })).toHaveLength(2);
  });

  it('counts waiting and SLA breaches per owner and per account, oldest first', () => {
    const w = world();
    const ownerOf = (acc: typeof w.zA, key: string, owner: string | null) => {
      const id = w.stores.identities.getIdentityByExternal(acc.id, 'user', `who-${key}`)!;
      if (owner) w.stores.customers.updateCustomer(id.customerId, { owner });
    };
    w.inbound(w.zA, 'a1', 1_000);
    w.inbound(w.zA, 'a2', 4_000);
    w.inbound(w.zB, 'b1', 8_000);
    w.inbound(w.zB, 'b2', 9_000);
    w.inbound(w.zB, 'b3', 100); // customer without an owner
    ownerOf(w.zA, 'a1', 'lan');
    ownerOf(w.zA, 'a2', 'lan');
    ownerOf(w.zB, 'b1', 'minh');
    ownerOf(w.zB, 'b2', 'minh');
    const opts = { nowMs: 12_000, slaMs: 5_000 };

    expect(waitingByOwner(w.stores, opts)).toEqual([
      { owner: null, waiting: 1, breached: 1, oldestWaitingSinceMs: 100 },
      { owner: 'lan', waiting: 2, breached: 2, oldestWaitingSinceMs: 1_000 },
      { owner: 'minh', waiting: 2, breached: 0, oldestWaitingSinceMs: 8_000 },
    ]);
    expect(waitingByAccount(w.stores, opts)).toEqual(
      [
        { accountId: w.zA.id, waiting: 2, breached: 2, oldestWaitingSinceMs: 1_000 },
        { accountId: w.zB.id, waiting: 3, breached: 1, oldestWaitingSinceMs: 100 },
      ].sort((x, y) => (x.accountId < y.accountId ? -1 : 1)),
    );
    expect(listWaiting(w.stores, { ...opts, accountId: w.zA.id })).toHaveLength(2);
    expect(listWaiting(w.stores, opts).map((i) => i.waitingSinceMs)).toEqual([100, 1_000, 4_000, 8_000, 9_000]);
  });

  it('a closed source contributes no rows and no counts to the aggregates', () => {
    const w = world();
    w.inbound(w.zA, 'a1', 100);
    w.inbound(w.zB, 'b1', 100);
    const canReadSource = (id: string) => id !== w.zB.id;
    expect(listWaiting(w.stores, { nowMs: 1_000, slaMs: 1, canReadSource }).map((i) => i.accountId)).toEqual([w.zA.id]);
    expect(waitingByAccount(w.stores, { nowMs: 1_000, slaMs: 1, canReadSource })).toHaveLength(1);
    expect(waitingByOwner(w.stores, { nowMs: 1_000, slaMs: 1, canReadSource })).toEqual([{ owner: null, waiting: 1, breached: 1, oldestWaitingSinceMs: 100 }]);
  });

  it('a deleted source conversation is not counted as waiting', () => {
    const w = world();
    w.inbound(w.zA, 'a1', 100);
    w.stores.conversations.setStatus(w.conv(w.zA, 'a1').id, 'source_deleted');
    expect(listWaiting(w.stores, { nowMs: 1_000, slaMs: 1 })).toEqual([]);
  });

  it('rejects a negative SLA', () => {
    const w = world();
    expect(caught(() => listWaiting(w.stores, { nowMs: 1, slaMs: -1 })).code).toBe('INVALID_COMMAND');
  });
});

describe('overdue task counts per owner and per account', () => {
  it('counts open past-due tasks only, with the account taken from scope metadata or the conversation', () => {
    const w = world();
    w.inbound(w.zA, 'peer:1', 1_000, { senderIdentityKey: 'c1' });
    w.inbound(w.zB, 'peer:2', 1_000, { senderIdentityKey: 'c2' });
    const c1 = w.stores.identities.getIdentityByExternal(w.zA.id, 'user', 'c1')!.customerId;
    const c2 = w.stores.identities.getIdentityByExternal(w.zB.id, 'user', 'c2')!.customerId;
    w.tasks.createTask({ customerId: c1, title: 'a', dueAtMs: 100, owner: 'lan', conversationId: w.conv(w.zA, 'peer:1').id });
    w.tasks.createTask({ customerId: c1, title: 'b', dueAtMs: 200, owner: 'lan', accountId: w.zA.id });
    w.tasks.createTask({ customerId: c1, title: 'c', dueAtMs: 300 }); // no owner, customer-wide
    w.tasks.createTask({ customerId: c2, title: 'd', dueAtMs: 400, owner: 'minh', conversationId: w.conv(w.zB, 'peer:2').id });
    w.tasks.createTask({ customerId: c2, title: 'e', dueAtMs: 9_000, owner: 'minh' }); // not due yet
    const done = w.tasks.createTask({ customerId: c2, title: 'f', dueAtMs: 50, owner: 'minh' });
    w.tasks.setDone(done.id, true, done.revision);

    expect(overdueTasksByOwner(w.stores, { nowMs: 1_000 })).toEqual([
      { owner: null, overdue: 1, oldestDueAtMs: 300 },
      { owner: 'lan', overdue: 2, oldestDueAtMs: 100 },
      { owner: 'minh', overdue: 1, oldestDueAtMs: 400 },
    ]);
    expect(overdueTasksByAccount(w.stores, { nowMs: 1_000 })).toEqual(
      [
        { accountId: null, overdue: 1, oldestDueAtMs: 300 },
        { accountId: w.zA.id, overdue: 2, oldestDueAtMs: 100 },
        { accountId: w.zB.id, overdue: 1, oldestDueAtMs: 400 },
      ].sort((x, y) => ((x.accountId ?? '') < (y.accountId ?? '') ? -1 : 1)),
    );
  });
});
