/**
 * CC-18 link / unlink / customer timeline (AC-017, AC-033). Synthetic data in a temp-file database only.
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
import { chatMessage, createEligibleAccount, dumpCareTables, emailMessage, TEST_KEY } from '../test-fixtures.js';
import { CareIngestPipeline } from './ingest.js';
import { CareCustomerOps, UndecidedItemsError } from './customer-ops.js';
import { CareTaskService } from './tasks-and-waiting.js';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));

function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'care-customer-ops-'));
  const file = path.join(dir, 'care.db');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  createCareSchema(db);
  const stores: CareStores = createCareStores(db, TEST_KEY);
  const ingest = new CareIngestPipeline(db, stores);
  cleanups.push(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const closed = new Set<string>();
  const ops = new CareCustomerOps(db, stores, { canReadSource: (accountId) => !closed.has(accountId) });
  const tasks = new CareTaskService(db, stores);

  // Two zalo accounts and one email account, all online (every gate on at the account level).
  const zA = createEligibleAccount(stores, { channel: 'zalo', nativeAccountId: 'zalo-A' });
  const zB = createEligibleAccount(stores, { channel: 'zalo', nativeAccountId: 'zalo-B' });
  const mail = createEligibleAccount(stores, { channel: 'email', nativeAccountId: 'shop@example.com' });

  const put = (m: NormalizedMessage) => ingest.ingestNormalizedMessage(m, undefined, 1);
  // The SAME native person ID 'u-1' exists on both zalo accounts: they must never merge.
  const a1 = put(chatMessage(zA, { senderIdentityKey: 'u-1', externalConversationKey: 'peer:A', nativeMessageId: 'a1', sentAtMs: 1_000, text: 'hello from zalo A' }));
  const b1 = put(chatMessage(zB, { senderIdentityKey: 'u-1', externalConversationKey: 'peer:B', nativeMessageId: 'b1', sentAtMs: 2_000, text: 'hello from zalo B' }));
  const m1 = put(emailMessage(mail, { senderIdentityKey: 'buyer@example.com', externalConversationKey: 'thread:C', nativeMessageId: 'g1', sentAtMs: 3_000, text: 'hello by email' }));

  const idA = stores.identities.getIdentityByExternal(zA.id, 'user', 'u-1')!;
  const idB = stores.identities.getIdentityByExternal(zB.id, 'user', 'u-1')!;
  const idC = stores.identities.getIdentityByExternal(mail.id, 'email', 'buyer@example.com')!;
  const cA = stores.customers.getCustomer(idA.customerId)!;
  const cB = stores.customers.getCustomer(idB.customerId)!;
  const cC = stores.customers.getCustomer(idC.customerId)!;
  const convA = stores.conversations.getConversationByExternalKey(zA.id, 'peer:A')!;
  const convB = stores.conversations.getConversationByExternalKey(zB.id, 'peer:B')!;
  const convC = stores.conversations.getConversationByExternalKey(mail.id, 'thread:C')!;

  const revs = (...ids: string[]) => Object.fromEntries(ids.map((id) => [id, stores.customers.getCustomer(id)!.revision]));

  /** Everything an unlink has to give back exactly, without revisions / timestamps. */
  const snapshot = () => ({
    customers: stores.customers
      .listCustomers(500)
      .map((c) => ({ id: c.id, name: c.displayName, company: c.company, phone: c.phone, email: c.email, stage: c.stage, tags: c.tags, owner: c.owner }))
      .sort((x, y) => (x.id < y.id ? -1 : 1)),
    identities: [idA, idB, idC].map((i) => [i.id, stores.identities.getIdentity(i.id)!.customerId]),
    profiles: [cA, cB, cC]
      .flatMap((c) => stores.profiles.getProfilesByCustomer(c.id))
      .map((p) => [p.id, p.customerId, p.accountId, p.note])
      .sort((x, y) => (String(x[0]) < String(y[0]) ? -1 : 1)),
    tasks: [cA, cB, cC]
      .flatMap((c) => stores.tasks.listTasksByCustomer(c.id))
      .map((t) => [t.id, t.customerId, t.conversationId, t.title, t.done, t.owner])
      .sort((x, y) => (String(x[0]) < String(y[0]) ? -1 : 1)),
    primaries: [convA, convB, convC].map((c) => [c.id, stores.conversations.getConversation(c.id)!.primaryCustomerId]),
  });

  const messageRows = () =>
    db.prepare('SELECT id, conversation_id, account_id FROM care_messages ORDER BY id').all() as Array<{ id: string; conversation_id: string; account_id: string }>;

  return {
    db, stores, ops, tasks, closed, put, zA, zB, mail, idA, idB, idC, cA, cB, cC, convA, convB, convC, revs, snapshot, messageRows,
    msg: { a1: a1.messageId!, b1: b1.messageId!, m1: m1.messageId! },
  };
}

function seedCareData(w: ReturnType<typeof world>) {
  const pA = w.stores.profiles.saveProfile(w.cA.id, { note: 'A source note' }, w.zA.id);
  const pAwide = w.stores.profiles.saveProfile(w.cA.id, { note: 'A customer-wide note' });
  const pB = w.stores.profiles.saveProfile(w.cB.id, { note: 'B source note', need: { budget: '10' } }, w.zB.id);
  const pBwide = w.stores.profiles.saveProfile(w.cB.id, { note: 'B customer-wide note' });
  const pC = w.stores.profiles.saveProfile(w.cC.id, { note: 'C source note' }, w.mail.id);
  const tA = w.tasks.createTask({ customerId: w.cA.id, title: 'call A', dueAtMs: 10_000, conversationId: w.convA.id, owner: 'lan' });
  const tAwide = w.tasks.createTask({ customerId: w.cA.id, title: 'A wide task', dueAtMs: 11_000 });
  const tB = w.tasks.createTask({ customerId: w.cB.id, title: 'call B', dueAtMs: 12_000, conversationId: w.convB.id });
  const tBwide = w.tasks.createTask({ customerId: w.cB.id, title: 'B wide task', dueAtMs: 13_000, owner: 'minh' });
  const tC = w.tasks.createTask({ customerId: w.cC.id, title: 'mail C', dueAtMs: 14_000, accountId: w.mail.id });
  return { pA, pAwide, pB, pBwide, pC, tA, tAwide, tB, tBwide, tC };
}

function linkAll(w: ReturnType<typeof world>, extra: Partial<Parameters<CareCustomerOps['link']>[0]> = {}) {
  return w.ops.link({
    identityIds: [w.idB.id, w.idC.id],
    targetCustomerId: w.cA.id,
    expectedRevisions: w.revs(w.cA.id, w.cB.id, w.cC.id),
    keepTargetForUnresolved: true, // display names differ across channels; field tests opt out below
    ...extra,
  });
}

function caught(fn: () => unknown): CareError {
  try {
    fn();
  } catch (err) {
    return err as CareError;
  }
  throw new Error('expected the call to throw');
}

describe('same-name / same-native-ID people are never merged automatically (AC-033)', () => {
  it('the same native ID on two accounts stays two identities and two customers until a link is requested', () => {
    const w = world();
    expect(w.idA.id).not.toBe(w.idB.id);
    expect(w.cA.id).not.toBe(w.cB.id);
    expect(w.cA.displayName).toBe(w.cB.displayName); // same name, still separate
    expect(w.db.prepare('SELECT COUNT(*) AS n FROM care_link_events').get()).toEqual({ n: 0 });
  });

  it('linking one account identity leaves the same native ID on the other account alone', () => {
    const w = world();
    w.ops.link({ identityIds: [w.idC.id], targetCustomerId: w.cA.id, expectedRevisions: w.revs(w.cA.id, w.cC.id), keepTargetForUnresolved: true });
    expect(w.stores.identities.getIdentity(w.idB.id)!.customerId).toBe(w.cB.id);
    expect(w.stores.identities.getIdentity(w.idA.id)!.customerId).toBe(w.cA.id);
    const timeline = w.ops.customerTimeline(w.cA.id).items;
    expect(timeline.map((i) => i.messageId).sort()).toEqual([w.msg.a1, w.msg.m1].sort());
    expect(timeline.every((i) => i.accountId !== w.zB.id)).toBe(true);
  });
});

describe('previewLink', () => {
  it('reports people, channels, accounts, conflicting fields and what would move - and writes nothing', () => {
    const w = world();
    seedCareData(w);
    w.stores.customers.updateCustomer(w.cA.id, { phone: '111', company: 'Acme' });
    w.stores.customers.updateCustomer(w.cB.id, { phone: '222', company: 'ACME ' }); // same company modulo case/space
    const before = w.snapshot();
    const eventsBefore = w.db.prepare('SELECT COUNT(*) AS n FROM care_events').get();

    const preview = w.ops.previewLink({ identityIds: [w.idB.id, w.idC.id], targetCustomerId: w.cA.id });

    expect(preview.targetCustomerId).toBe(w.cA.id);
    expect(preview.suggestedTarget).toBe(false);
    expect(preview.noop).toBe(false);
    expect(preview.people.map((p) => [p.customerId, p.role])).toEqual(
      expect.arrayContaining([[w.cA.id, 'target'], [w.cB.id, 'source'], [w.cC.id, 'source']]),
    );
    expect(preview.channels).toEqual(['email', 'zalo']);
    expect(preview.accounts.map((a) => a.accountId).sort()).toEqual([w.zB.id, w.mail.id].sort());
    expect(preview.conflicts.map((c) => c.field)).toEqual(['displayName', 'phone']);
    expect(preview.conflicts[1].values.map((v) => v.value).sort()).toEqual(['111', '222']);
    expect(preview.moves).toEqual({ profiles: 3, tasks: 3, conversations: 1 });
    expect(preview.expectedRevisions[w.cA.id]).toBe(w.stores.customers.getCustomer(w.cA.id)!.revision);

    expect(w.snapshot()).toEqual(before);
    expect(w.db.prepare('SELECT COUNT(*) AS n FROM care_events').get()).toEqual(eventsBefore);
    expect(w.db.prepare('SELECT COUNT(*) AS n FROM care_link_events').get()).toEqual({ n: 0 });
  });

  it('suggests the oldest involved customer when no target is named, and flags a noop when all is already linked', () => {
    const w = world();
    const p = w.ops.previewLink({ customerIds: [w.cA.id, w.cB.id] });
    expect(p.suggestedTarget).toBe(true);
    expect([w.cA.id, w.cB.id]).toContain(p.targetCustomerId);
    const same = w.ops.previewLink({ identityIds: [w.idA.id], targetCustomerId: w.cA.id });
    expect(same.noop).toBe(true);
  });

  it('rejects a selection with nothing to link and unknown ids', () => {
    const w = world();
    expect(caught(() => w.ops.previewLink({})).code).toBe('INVALID_COMMAND');
    expect(caught(() => w.ops.previewLink({ identityIds: ['nope'] })).code).toBe('NOT_FOUND');
  });
});

describe('link then unlink round trip (AC-033)', () => {
  it('restores customers, profiles, memberships, task ownership and conversation pointers exactly', () => {
    const w = world();
    seedCareData(w);
    w.stores.customers.updateCustomer(w.cA.id, { phone: '111' });
    w.stores.customers.updateCustomer(w.cB.id, { phone: '222' });
    const before = w.snapshot();
    const messagesBefore = w.messageRows();

    const linked = linkAll(w, { resolutions: { phone: { fromCustomerId: w.cB.id } }, actor: 'lan' });
    expect(linked.applied).toBe(true);
    expect(linked.movedIdentityIds.sort()).toEqual([w.idB.id, w.idC.id].sort());

    // After the link everything hangs off the target...
    expect(w.stores.identities.listIdentitiesByCustomer(w.cA.id).map((i) => i.id).sort()).toEqual([w.idA.id, w.idB.id, w.idC.id].sort());
    expect(w.stores.identities.listIdentitiesByCustomer(w.cB.id)).toEqual([]);
    expect(w.stores.profiles.getProfilesByCustomer(w.cA.id)).toHaveLength(5);
    expect(w.stores.tasks.listTasksByCustomer(w.cA.id)).toHaveLength(5);
    expect(w.stores.conversations.getConversation(w.convB.id)!.primaryCustomerId).toBe(w.cA.id);
    // ...the chosen customer-wide value applies to the target only...
    expect(w.stores.customers.getCustomer(w.cA.id)!.phone).toBe('222');
    expect(w.stores.customers.getCustomer(w.cB.id)!.phone).toBe('222');
    // ...origin scopes survive, and messages never moved.
    const origins = w.stores.audit.profileOrigins(w.cA.id);
    expect(origins.get(w.stores.profiles.getProfilesByCustomer(w.cA.id).find((p) => p.note === 'B source note')!.id)).toBe(w.cB.id);
    expect(w.stores.profiles.getProfilesByCustomer(w.cA.id).find((p) => p.note === 'B source note')!.accountId).toBe(w.zB.id);
    expect(w.messageRows()).toEqual(messagesBefore);

    const unlinked = w.ops.unlink({ identityIds: [w.idB.id, w.idC.id], expectedRevisions: w.revs(w.cA.id, w.cB.id, w.cC.id) });
    expect(unlinked.applied).toBe(true);
    expect(unlinked.returned).toEqual({ profiles: 3, tasks: 3, conversations: 1 });
    expect(unlinked.decided).toBe(0);

    expect(w.snapshot()).toEqual(before);
    expect(w.messageRows()).toEqual(messagesBefore);
  });

  it('writes an audit row, membership history and one care event per account - with no message content', () => {
    const w = world();
    seedCareData(w);
    const { linkEventId } = linkAll(w, { actor: 'lan' });
    const audit = w.stores.audit;
    const event = audit.getLinkEvent(linkEventId!)!;
    expect(event).toMatchObject({ kind: 'link', targetCustomerId: w.cA.id, actor: 'lan' });
    expect(Object.keys(event.revisions).sort()).toEqual([w.cA.id, w.cB.id, w.cC.id].sort());
    for (const [before, after] of Object.values(event.revisions)) expect(after).toBeGreaterThan(before);
    expect(audit.listMembershipsForEvent(linkEventId!).map((m) => [m.identityId, m.fromCustomerId, m.toCustomerId]).sort()).toEqual(
      [[w.idB.id, w.cB.id, w.cA.id], [w.idC.id, w.cC.id, w.cA.id]].sort(),
    );
    const events = w.stores.events.getEvent(w.zB.id, `care-link:${linkEventId}:${w.zB.id}`);
    expect(events?.eventType).toBe('customer.linked');

    const auditDump = (['care_link_events', 'care_identity_membership_history', 'care_link_moves'] as const)
      .map((t) => JSON.stringify(w.db.prepare(`SELECT * FROM ${t}`).all()))
      .join('\n');
    for (const text of ['hello from zalo A', 'hello from zalo B', 'hello by email', 'B source note', 'call B']) {
      expect(auditDump).not.toContain(text);
    }
    expect(dumpCareTables(w.db)).not.toContain('hello from zalo B'); // bodies stay encrypted everywhere
  });

  it('re-link after unlink works and keeps a full history', () => {
    const w = world();
    linkAll(w);
    w.ops.unlink({ identityIds: [w.idB.id, w.idC.id], expectedRevisions: w.revs(w.cA.id, w.cB.id, w.cC.id) });
    linkAll(w);
    expect(w.stores.identities.getIdentity(w.idB.id)!.customerId).toBe(w.cA.id);
    expect(w.stores.audit.membershipHistory(w.idB.id).map((m) => m.kind)).toEqual(['link', 'unlink', 'link']);
  });

  it('partial unlink only returns what belongs to the restored identity', () => {
    const w = world();
    const seeded = seedCareData(w);
    w.stores.customers.updateCustomer(w.cA.id, { phone: '111' });
    w.stores.customers.updateCustomer(w.cB.id, { phone: '222' });
    linkAll(w, { resolutions: { phone: { fromCustomerId: w.cB.id } } });

    const result = w.ops.unlink({ identityIds: [w.idC.id], expectedRevisions: w.revs(w.cA.id, w.cC.id) });
    expect(result.returned).toEqual({ profiles: 1, tasks: 1, conversations: 0 });
    expect(w.stores.identities.getIdentity(w.idC.id)!.customerId).toBe(w.cC.id);
    expect(w.stores.profiles.getProfile(seeded.pC.id)!.customerId).toBe(w.cC.id);
    expect(w.stores.tasks.getTask(seeded.tC.id)!.customerId).toBe(w.cC.id);
    // B is still linked and keeps everything it brought, including the customer-wide choice.
    expect(w.stores.profiles.getProfile(seeded.pB.id)!.customerId).toBe(w.cA.id);
    expect(w.stores.profiles.getProfile(seeded.pBwide.id)!.customerId).toBe(w.cA.id);
    expect(w.stores.customers.getCustomer(w.cA.id)!.phone).toBe('222');

    w.ops.unlink({ identityIds: [w.idB.id], expectedRevisions: w.revs(w.cA.id, w.cB.id) });
    expect(w.stores.customers.getCustomer(w.cA.id)!.phone).toBe('111'); // last identity of that link left
  });

  it('keeps a later edit of a chosen customer-wide field when the link is undone', () => {
    const w = world();
    w.stores.customers.updateCustomer(w.cA.id, { phone: '111' });
    w.stores.customers.updateCustomer(w.cB.id, { phone: '222' });
    linkAll(w, { resolutions: { phone: { fromCustomerId: w.cB.id } } });
    w.stores.customers.updateCustomer(w.cA.id, { phone: '999' }); // edited after the link
    w.ops.unlink({ identityIds: [w.idB.id, w.idC.id], expectedRevisions: w.revs(w.cA.id, w.cB.id, w.cC.id) });
    expect(w.stores.customers.getCustomer(w.cA.id)!.phone).toBe('999');
    const rows = w.db.prepare('SELECT outcome, previous_enc, applied_enc FROM care_link_field_changes').all();
    expect(rows).toEqual([{ outcome: 'kept_edited', previous_enc: null, applied_enc: null }]);
  });
});

describe('conflicting fields need an explicit customer-wide choice', () => {
  it('rejects an unresolved conflict with the typed error and writes nothing', () => {
    const w = world();
    w.stores.customers.updateCustomer(w.cA.id, { phone: '111' });
    w.stores.customers.updateCustomer(w.cB.id, { phone: '222' });
    const before = w.snapshot();
    const err = caught(() => linkAll(w, { keepTargetForUnresolved: false, resolutions: { displayName: { keep: 'target' } } }));
    expect(err).toBeInstanceOf(UndecidedItemsError);
    expect(err.status).toBe(409);
    expect((err as UndecidedItemsError).items.map((i) => i.itemKey)).toEqual(['field:phone']);
    expect(w.snapshot()).toEqual(before);
    expect(w.db.prepare('SELECT COUNT(*) AS n FROM care_link_events').get()).toEqual({ n: 0 });
  });

  it('keep-target leaves everything as is; an explicit value is applied to the target only; sources are never overwritten', () => {
    const w = world();
    w.stores.customers.updateCustomer(w.cA.id, { phone: '111' });
    w.stores.customers.updateCustomer(w.cB.id, { phone: '222' });
    linkAll(w, { resolutions: { phone: { keep: 'target' } } });
    expect(w.stores.customers.getCustomer(w.cA.id)!.phone).toBe('111');
    expect(w.stores.customers.getCustomer(w.cB.id)!.phone).toBe('222');

    w.ops.unlink({ identityIds: [w.idB.id, w.idC.id], expectedRevisions: w.revs(w.cA.id, w.cB.id, w.cC.id) });
    linkAll(w, { resolutions: { phone: { value: '333' } } });
    expect(w.stores.customers.getCustomer(w.cA.id)!.phone).toBe('333');
    expect(w.stores.customers.getCustomer(w.cB.id)!.phone).toBe('222');
  });

  it('reports profile conflicts per origin scope as informational (rows are kept separate)', () => {
    const w = world();
    w.stores.profiles.saveProfile(w.cA.id, { note: 'target says X', need: { size: 'S' } }, w.zA.id);
    w.stores.profiles.saveProfile(w.cB.id, { note: 'source says Y', need: { size: 'L' } }, w.zA.id);
    const preview = w.ops.previewLink({ customerIds: [w.cA.id, w.cB.id], targetCustomerId: w.cA.id });
    expect(preview.profileConflicts.map((c) => [c.scope, c.kind, c.key ?? null, c.resolution])).toEqual([
      [w.zA.id, 'note', null, 'kept_separate'],
      [w.zA.id, 'need', 'size', 'kept_separate'],
    ]);
  });

  it('rejects an unknown field and a resolution naming an uninvolved customer', () => {
    const w = world();
    expect(caught(() => linkAll(w, { resolutions: { nope: { keep: 'target' } } as never })).code).toBe('INVALID_COMMAND');
    expect(caught(() => linkAll(w, { resolutions: { phone: { fromCustomerId: 'someone-else' } } })).code).toBe('INVALID_COMMAND');
  });
});

describe('explicit revisions', () => {
  it('a stale target or source revision is a 409 and nothing changes', () => {
    const w = world();
    seedCareData(w);
    const expected = w.revs(w.cA.id, w.cB.id, w.cC.id);
    w.stores.customers.updateCustomer(w.cB.id, { company: 'edited meanwhile' });
    const before = w.snapshot();
    const err = caught(() => w.ops.link({ identityIds: [w.idB.id, w.idC.id], targetCustomerId: w.cA.id, expectedRevisions: expected }));
    expect(err).toMatchObject({ code: 'STALE_REVISION', status: 409 });
    expect((err.details as any).customerId).toBe(w.cB.id);
    const after = w.snapshot();
    expect({ ...after, customers: null }).toEqual({ ...before, customers: null }); // moves rolled back
    expect(w.stores.identities.getIdentity(w.idB.id)!.customerId).toBe(w.cB.id);
    expect(w.stores.profiles.getProfilesByCustomer(w.cA.id)).toHaveLength(2);
    expect(w.db.prepare('SELECT COUNT(*) AS n FROM care_link_events').get()).toEqual({ n: 0 });
  });

  it('requires a revision for every involved customer', () => {
    const w = world();
    const err = caught(() => w.ops.link({ identityIds: [w.idB.id], targetCustomerId: w.cA.id, expectedRevisions: w.revs(w.cA.id) }));
    expect(err.code).toBe('INVALID_COMMAND');
  });

  it('stale revisions on unlink are rejected too', () => {
    const w = world();
    linkAll(w);
    const stale = w.revs(w.cA.id, w.cB.id, w.cC.id);
    w.stores.customers.updateCustomer(w.cA.id, { company: 'edited' });
    expect(caught(() => w.ops.unlink({ identityIds: [w.idB.id], expectedRevisions: stale })).code).toBe('STALE_REVISION');
    expect(w.stores.identities.getIdentity(w.idB.id)!.customerId).toBe(w.cA.id);
  });
});

describe('idempotency', () => {
  it('re-linking identities that are already on the target is a no-op (no audit row, no revision bump)', () => {
    const w = world();
    const first = linkAll(w);
    const targetRevision = w.stores.customers.getCustomer(w.cA.id)!.revision;
    const again = linkAll(w); // same (now stale) revisions: the no-op is decided before revisions
    expect(again).toMatchObject({ applied: false, linkEventId: null, movedIdentityIds: [] });
    expect(w.stores.customers.getCustomer(w.cA.id)!.revision).toBe(targetRevision);
    expect(w.db.prepare('SELECT COUNT(*) AS n FROM care_link_events').get()).toEqual({ n: 1 });
    expect(first.applied).toBe(true);
  });

  it('a repeated requestId replays the stored result; a different payload on the same id is a 409', () => {
    const w = world();
    const expectedRevisions = w.revs(w.cA.id, w.cB.id, w.cC.id);
    const first = linkAll(w, { requestId: 'req-1', expectedRevisions });
    const replay = linkAll(w, { requestId: 'req-1', expectedRevisions });
    expect(replay).toMatchObject({ applied: true, replayed: true, linkEventId: first.linkEventId });
    expect(w.db.prepare('SELECT COUNT(*) AS n FROM care_link_events').get()).toEqual({ n: 1 });
    const mismatch = caught(() =>
      w.ops.link({ identityIds: [w.idC.id], targetCustomerId: w.cA.id, expectedRevisions: w.revs(w.cA.id, w.cC.id), requestId: 'req-1' }),
    );
    expect(mismatch.code).toBe('DUPLICATE_REQUEST_PAYLOAD_MISMATCH');
  });

  it('unlinking twice is a no-op the second time; an identity that was never linked is rejected', () => {
    const w = world();
    linkAll(w);
    const req = { identityIds: [w.idB.id, w.idC.id], expectedRevisions: w.revs(w.cA.id, w.cB.id, w.cC.id) };
    expect(w.ops.unlink(req).applied).toBe(true);
    expect(w.ops.unlink(req)).toMatchObject({ applied: false, restored: [] });
    expect(caught(() => w.ops.unlink({ identityIds: [w.idA.id], expectedRevisions: w.revs(w.cA.id) })).code).toBe('INVALID_TARGET');
  });
});

describe('unlink with customer-wide items that have no source (AC-033)', () => {
  it('rejects with the typed error listing the undecided items and writes nothing', () => {
    const w = world();
    seedCareData(w);
    linkAll(w);
    const postNote = w.stores.profiles.saveProfile(w.cA.id, { note: 'written after linking' });
    const postTask = w.tasks.createTask({ customerId: w.cA.id, title: 'follow up everyone', dueAtMs: 99_000 });
    const before = w.snapshot();
    const eventsBefore = w.db.prepare('SELECT COUNT(*) AS n FROM care_link_events').get();

    const err = caught(() => w.ops.unlink({ identityIds: [w.idB.id, w.idC.id], expectedRevisions: w.revs(w.cA.id, w.cB.id, w.cC.id) }));
    expect(err).toBeInstanceOf(UndecidedItemsError);
    const keys = (err as UndecidedItemsError).items.map((i) => i.itemKey).sort();
    expect(keys).toEqual([`profile:${postNote.id}`, `task:${postTask.id}`].sort());
    expect((err as UndecidedItemsError).items[0].candidateCustomerIds.sort()).toEqual([w.cA.id, w.cB.id, w.cC.id].sort());
    expect(w.snapshot()).toEqual(before);
    expect(w.stores.identities.getIdentity(w.idB.id)!.customerId).toBe(w.cA.id);
    expect(w.db.prepare('SELECT COUNT(*) AS n FROM care_link_events').get()).toEqual(eventsBefore);
  });

  it('an explicit choice keeps each item exactly once where the user said, nothing is deleted or duplicated', () => {
    const w = world();
    seedCareData(w);
    linkAll(w);
    const postNote = w.stores.profiles.saveProfile(w.cA.id, { note: 'written after linking' });
    const postTask = w.tasks.createTask({ customerId: w.cA.id, title: 'follow up everyone', dueAtMs: 99_000 });
    const totals = () => ({
      profiles: (w.db.prepare('SELECT COUNT(*) AS n FROM care_profiles').get() as any).n,
      tasks: (w.db.prepare('SELECT COUNT(*) AS n FROM care_tasks').get() as any).n,
    });
    const before = totals();

    const result = w.ops.unlink({
      identityIds: [w.idB.id, w.idC.id],
      expectedRevisions: w.revs(w.cA.id, w.cB.id, w.cC.id),
      decisions: { [`profile:${postNote.id}`]: w.cA.id, [`task:${postTask.id}`]: w.cB.id },
    });
    expect(result.decided).toBe(2);
    expect(w.stores.profiles.getProfile(postNote.id)!.customerId).toBe(w.cA.id);
    expect(w.stores.tasks.getTask(postTask.id)!.customerId).toBe(w.cB.id);
    expect(totals()).toEqual(before);
  });

  it('rejects a decision for an item that needs none or names a customer outside the unlink', () => {
    const w = world();
    const seeded = seedCareData(w);
    linkAll(w);
    const post = w.tasks.createTask({ customerId: w.cA.id, title: 'wide', dueAtMs: 5 });
    const req = { identityIds: [w.idB.id, w.idC.id], expectedRevisions: w.revs(w.cA.id, w.cB.id, w.cC.id) };
    expect(caught(() => w.ops.unlink({ ...req, decisions: { [`task:${post.id}`]: 'stranger' } })).code).toBe('INVALID_COMMAND');
    expect(caught(() => w.ops.unlink({ ...req, decisions: { [`task:${post.id}`]: w.cA.id, [`task:${seeded.tB.id}`]: w.cA.id } })).code).toBe('INVALID_COMMAND');
  });

  it('a post-link account-scoped task goes back to the one source that owns that account without a prompt', () => {
    const w = world();
    linkAll(w);
    const scoped = w.tasks.createTask({ customerId: w.cA.id, title: 'about the B chat', dueAtMs: 5, conversationId: w.convB.id });
    w.ops.unlink({ identityIds: [w.idB.id, w.idC.id], expectedRevisions: w.revs(w.cA.id, w.cB.id, w.cC.id) });
    expect(w.stores.tasks.getTask(scoped.id)!.customerId).toBe(w.cB.id);
  });

  it("the target's own customer-wide items stay with it without a prompt", () => {
    const w = world();
    const seeded = seedCareData(w);
    linkAll(w);
    w.ops.unlink({ identityIds: [w.idB.id, w.idC.id], expectedRevisions: w.revs(w.cA.id, w.cB.id, w.cC.id) });
    expect(w.stores.tasks.getTask(seeded.tAwide.id)!.customerId).toBe(w.cA.id);
    expect(w.stores.profiles.getProfile(seeded.pAwide.id)!.customerId).toBe(w.cA.id);
  });
});

describe('previewUnlink is read-only and shares its planning with unlink', () => {
  const totalChanges = (w: ReturnType<typeof world>) => (w.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;

  it('reports the undecided items and the return counts without a single write', () => {
    const w = world();
    seedCareData(w);
    linkAll(w);
    const postNote = w.stores.profiles.saveProfile(w.cA.id, { note: 'written after linking' });
    const postTask = w.tasks.createTask({ customerId: w.cA.id, title: 'follow up everyone', dueAtMs: 99_000 });
    const before = w.snapshot();
    const changes = totalChanges(w);
    const links = w.db.prepare('SELECT COUNT(*) AS n FROM care_link_events').get();

    const open = w.ops.previewUnlink({ identityIds: [w.idB.id, w.idC.id] });
    expect(open.noop).toBe(false);
    expect(open.undecided.map((i) => i.itemKey).sort()).toEqual([`profile:${postNote.id}`, `task:${postTask.id}`].sort());
    expect(open.undecided[0].candidateCustomerIds.sort()).toEqual([w.cA.id, w.cB.id, w.cC.id].sort());

    const decided = w.ops.previewUnlink({
      identityIds: [w.idB.id, w.idC.id],
      decisions: { [`profile:${postNote.id}`]: w.cA.id, [`task:${postTask.id}`]: w.cB.id },
    });
    expect(decided.undecided).toEqual([]);
    expect(decided.decided).toBe(2);

    expect(totalChanges(w)).toBe(changes); // SQLite counted no INSERT/UPDATE/DELETE on this connection
    expect(w.snapshot()).toEqual(before);
    expect(w.db.prepare('SELECT COUNT(*) AS n FROM care_link_events').get()).toEqual(links);
  });

  it('predicts exactly what unlink then does (same planner: counts and undecided keys cannot drift)', () => {
    const w = world();
    seedCareData(w);
    linkAll(w);
    const postNote = w.stores.profiles.saveProfile(w.cA.id, { note: 'written after linking' });
    const postTask = w.tasks.createTask({ customerId: w.cA.id, title: 'follow up everyone', dueAtMs: 99_000 });
    const decisions = { [`profile:${postNote.id}`]: w.cA.id, [`task:${postTask.id}`]: w.cB.id };
    const preview = w.ops.previewUnlink({ identityIds: [w.idB.id, w.idC.id], decisions });
    const result = w.ops.unlink({ identityIds: [w.idB.id, w.idC.id], expectedRevisions: w.revs(w.cA.id, w.cB.id, w.cC.id), decisions });
    expect(preview.returned).toEqual(result.returned);
    expect(preview.decided).toBe(result.decided);
  });

  it('is a noop for an already restored identity, and keeps the same errors as unlink', () => {
    const w = world();
    linkAll(w);
    w.ops.unlink({ identityIds: [w.idB.id], expectedRevisions: w.revs(w.cA.id, w.cB.id) });
    expect(w.ops.previewUnlink({ identityIds: [w.idB.id] }).noop).toBe(true);
    expect(caught(() => w.ops.previewUnlink({ identityIds: [] })).code).toBe('INVALID_COMMAND');
    expect(caught(() => w.ops.previewUnlink({ identityIds: ['nope'] })).code).toBe('NOT_FOUND');
    expect(caught(() => w.ops.previewUnlink({ identityIds: [w.idA.id] })).code).toBe('INVALID_TARGET'); // never linked
    const post = w.tasks.createTask({ customerId: w.cA.id, title: 'wide', dueAtMs: 5 });
    linkAll(w, { identityIds: [w.idB.id], expectedRevisions: w.revs(w.cA.id, w.cB.id) });
    expect(caught(() => w.ops.previewUnlink({ identityIds: [w.idB.id], decisions: { [`task:${post.id}`]: 'stranger' } })).code).toBe('INVALID_COMMAND');
  });
});

describe('customer timeline (AC-010 / AC-033)', () => {
  it('merges the linked conversations newest first and every item carries its original conversation', () => {
    const w = world();
    linkAll(w);
    const page = w.ops.customerTimeline(w.cA.id);
    expect(page.items.map((i) => [i.messageId, i.conversationId, i.channel])).toEqual([
      [w.msg.m1, w.convC.id, 'email'],
      [w.msg.b1, w.convB.id, 'zalo'],
      [w.msg.a1, w.convA.id, 'zalo'],
    ]);
    expect(page.nextCursor).toBeNull();
    for (const item of page.items) expect(item.replyTarget).toEqual({ conversationId: item.conversationId, accountId: item.accountId });
  });

  it('a source whose read gate is closed contributes nothing - before the link, after it and after the unlink', () => {
    const w = world();
    w.closed.add(w.zB.id);
    expect(w.ops.customerTimeline(w.cB.id).items).toEqual([]);

    linkAll(w);
    const linked = w.ops.customerTimeline(w.cA.id).items;
    expect(linked.map((i) => i.messageId)).toEqual([w.msg.m1, w.msg.a1]);
    expect(linked.some((i) => i.accountId === w.zB.id)).toBe(false);

    w.ops.unlink({ identityIds: [w.idB.id, w.idC.id], expectedRevisions: w.revs(w.cA.id, w.cB.id, w.cC.id) });
    expect(w.ops.customerTimeline(w.cB.id).items).toEqual([]); // unlink never widens access
    expect(w.ops.customerTimeline(w.cA.id).items.map((i) => i.messageId)).toEqual([w.msg.a1]);

    w.closed.clear();
    expect(w.ops.customerTimeline(w.cB.id).items.map((i) => i.messageId)).toEqual([w.msg.b1]);
  });

  it('a throwing gate is treated as closed', () => {
    const w = world();
    const ops = new CareCustomerOps(w.db, w.stores, {
      canReadSource: () => {
        throw new Error('gate offline');
      },
    });
    expect(ops.customerTimeline(w.cA.id).items).toEqual([]);
  });

  it('paginates with a stable cursor across conversations', () => {
    const w = world();
    for (let i = 0; i < 6; i += 1) {
      w.put(chatMessage(w.zA, { senderIdentityKey: 'u-1', externalConversationKey: 'peer:A', nativeMessageId: `extra-${i}`, sentAtMs: 5_000 + i * 10, text: `extra ${i}` }));
      w.put(chatMessage(w.zB, { senderIdentityKey: 'u-1', externalConversationKey: 'peer:B', nativeMessageId: `extraB-${i}`, sentAtMs: 5_005 + i * 10, text: `extraB ${i}` }));
    }
    linkAll(w);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: ReturnType<typeof w.ops.customerTimeline> = w.ops.customerTimeline(w.cA.id, { limit: 4, cursor });
      seen.push(...page.items.map((i) => i.messageId));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 20);
    expect(seen).toHaveLength(15);
    expect(new Set(seen).size).toBe(15);
    const all = w.ops.customerTimeline(w.cA.id, { limit: 100 }).items;
    expect(seen).toEqual(all.map((i) => i.messageId));
    expect(all.map((i) => i.sentAtMs)).toEqual([...all.map((i) => i.sentAtMs)].sort((x, y) => y - x));
    expect(caught(() => w.ops.customerTimeline(w.cA.id, { cursor: 'garbage' })).code).toBe('INVALID_CURSOR');
  });

  it("includes only the customer's own messages in a group, never the other members'", () => {
    const w = world();
    const group = (id: string, at: number, who: string, text: string) =>
      w.put(chatMessage(w.zA, {
        senderIdentityKey: who, externalConversationKey: 'g:1', nativeMessageId: id, sentAtMs: at, text,
        metadata: { type: 'chat', conversationKind: 'group' },
      }));
    group('g-mine', 4_000, 'u-1', 'my group message');
    group('g-other', 4_100, 'u-9', 'somebody else talking');
    const items = w.ops.customerTimeline(w.cA.id).items;
    expect(items.map((i) => i.text)).toContain('my group message');
    expect(items.map((i) => i.text)).not.toContain('somebody else talking');
  });

  it('never exposes deleted messages', () => {
    const w = world();
    w.stores.messages.softDeleteMessage(w.msg.a1);
    expect(w.ops.customerTimeline(w.cA.id).items).toEqual([]);
  });
});

describe('reply target (AC-033)', () => {
  it('is always the ORIGINAL conversation, even though another channel is online', () => {
    const w = world();
    linkAll(w);
    expect(w.stores.accounts.getAccount(w.zA.id)!.desiredState).toBe('active');
    expect(w.ops.resolveReplyTarget(w.cA.id, { messageId: w.msg.b1 })).toEqual({ conversationId: w.convB.id, accountId: w.zB.id, channel: 'zalo' });
    expect(w.ops.resolveReplyTarget(w.cA.id, { conversationId: w.convC.id })).toEqual({ conversationId: w.convC.id, accountId: w.mail.id, channel: 'email' });
    const fromTimeline = w.ops.customerTimeline(w.cA.id).items.find((i) => i.messageId === w.msg.m1)!;
    expect(fromTimeline.replyTarget.conversationId).toBe(w.convC.id);
  });

  it('refuses a conversation that is not part of the customer, a closed source and a mismatched pair', () => {
    const w = world();
    linkAll(w);
    // cA owns convA/B/C after the link; before it, cC did not own convA.
    expect(caught(() => w.ops.resolveReplyTarget('not-a-customer', { conversationId: w.convA.id })).code).toBe('NOT_FOUND');
    w.closed.add(w.zB.id);
    expect(caught(() => w.ops.resolveReplyTarget(w.cA.id, { messageId: w.msg.b1 })).code).toBe('NOT_FOUND');
    expect(caught(() => w.ops.resolveReplyTarget(w.cA.id, { messageId: w.msg.a1, conversationId: w.convC.id })).code).toBe('INVALID_TARGET');
    w.closed.clear();
    w.ops.unlink({ identityIds: [w.idB.id, w.idC.id], expectedRevisions: w.revs(w.cA.id, w.cB.id, w.cC.id) });
    expect(caught(() => w.ops.resolveReplyTarget(w.cA.id, { messageId: w.msg.b1 })).code).toBe('NOT_FOUND'); // no longer linked
    expect(w.ops.resolveReplyTarget(w.cB.id, { messageId: w.msg.b1 }).conversationId).toBe(w.convB.id);
  });
});

describe('construction', () => {
  it('requires the read gate (fail closed: no default)', () => {
    const w = world();
    expect(() => new CareCustomerOps(w.db, w.stores, {} as never)).toThrow(CareError);
  });
});
