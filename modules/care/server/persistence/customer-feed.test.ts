/**
 * The customer change feed (customer-feed.ts): one row per real change of a customer, its profiles or its tasks,
 * written in the same transaction as the change, nothing for a write that changed nothing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createCustomersApi } from '../customers-service.js';
import { chatMessage, memoryFixture, type MemoryFixture } from '../test-fixtures.js';
import { CareCustomerFeed } from './customer-feed.js';

const open: MemoryFixture[] = [];
afterEach(() => open.splice(0).forEach((f) => f.close()));
function setup() {
  const f = memoryFixture();
  open.push(f);
  const feed = new CareCustomerFeed(f.raw);
  const api = createCustomersApi(f.raw, () => f.stores);
  let cursor = feed.latest();
  /** rows written since the previous call */
  const fresh = () => {
    const r = feed.changesSince(cursor, 1000);
    cursor = r.cursor;
    return r.changes;
  };
  return { f, feed, api, fresh };
}

describe('care customer change feed', () => {
  it('records create, update, stage and tag changes of a customer, with only plaintext details', () => {
    const { f, fresh } = setup();
    const c = f.stores.customers.createCustomer({ displayName: 'Chị Lan', phone: '0901234567' });
    expect(fresh()).toMatchObject([{ customerId: c.id, entity: 'customer', op: 'insert', detail: { stage: 'new' } }]);

    const c2 = f.stores.customers.updateCustomer(c.id, { stage: 'consulting' }, c.revision);
    expect(fresh()).toMatchObject([{ op: 'update', detail: { stage_from: 'new', stage_to: 'consulting', fields: '' } }]);

    f.stores.customers.updateCustomer(c.id, { tags: 'hỏi sỉ, ô long', phone: '0909' }, c2.revision);
    const [row] = fresh();
    expect(row!.detail).toMatchObject({ stage_from: null, fields: 'sdt,the' });
    expect(JSON.stringify(row)).not.toMatch(/0909|long|Lan/); // no customer content in the feed
  });

  it('writes nothing for writes that change nothing', () => {
    const { f, fresh } = setup();
    const c = f.stores.customers.createCustomer({ displayName: 'Khách A', phone: '1', tags: 'x' });
    const p = f.stores.profiles.saveProfile(c.id, { need: { service: 'Tour' } }, f.account.id);
    const t = f.stores.tasks.createTask({ customerId: c.id, title: 'Gọi lại', dueAtMs: 1_800_000_000_000 });
    fresh();

    // same values again, and the empty patch the link flow uses as a revision lock
    const c2 = f.stores.customers.updateCustomer(c.id, { displayName: 'Khách A', phone: '1', tags: 'x', stage: 'new' }, c.revision);
    const c3 = f.stores.customers.updateCustomer(c.id, {}, c2.revision);
    expect(c3.revision).toBe(c.revision + 2); // the revision still moves (compare-and-set lock), the data does not
    f.stores.profiles.updateProfile(p.id, { need: { service: 'Tour' } }, p.revision);
    f.stores.tasks.updateTask(t.id, { title: 'Gọi lại' }, t.revision);
    f.stores.tasks.setTaskDone(t.id, false);
    f.stores.audit.reassignTask(t.id, c.id);
    f.stores.audit.reassignProfile(p.id, c.id);
    f.stores.tasks.upsertBridged({ id: t.id, customerId: c.id, title: 'Gọi lại', dueAtMs: 1_800_000_000_000, done: false });
    const bridged = f.stores.profiles.upsertBridged({ id: 'legacy-1', customerId: c.id, accountId: f.account.id, provenance: 'zalo:legacy', need: null, note: 'cũ', revision: 3, updatedAtMs: 5 });
    expect(fresh()).toHaveLength(1); // the bridged insert
    f.stores.profiles.upsertBridged({ id: bridged.id, customerId: c.id, accountId: f.account.id, provenance: 'zalo:legacy', need: null, note: 'cũ', revision: 3, updatedAtMs: 5 });
    expect(fresh()).toEqual([]);
  });

  it('records profile and task changes, moves on both customers, and deletes', () => {
    const { f, fresh } = setup();
    const a = f.stores.customers.createCustomer({ displayName: 'A' });
    const b = f.stores.customers.createCustomer({ displayName: 'B' });
    fresh();
    const p = f.stores.profiles.saveProfile(a.id, { need: { budget: '5tr' } }, f.account.id);
    f.stores.profiles.updateProfile(p.id, { note: 'gọi lại' }, p.revision);
    const t = f.stores.tasks.createTask({ customerId: a.id, title: 'Báo giá', dueAtMs: 1_800_000_000_000 });
    f.stores.tasks.setTaskDone(t.id, true);
    expect(fresh().map((r) => `${r.entity}:${r.op}`)).toEqual(['profile:insert', 'profile:update', 'task:insert', 'task:update']);

    f.stores.audit.reassignTask(t.id, b.id);
    expect(fresh().map((r) => r.customerId)).toEqual([a.id, b.id]);

    f.stores.tasks.deleteTask(t.id);
    expect(fresh()).toMatchObject([{ customerId: b.id, entity: 'task', op: 'delete' }]);

    // care has no "delete customer" path today; the trigger still covers a raw DELETE (FK children first)
    f.raw.prepare('DELETE FROM care_profiles WHERE customer_id = ?').run(a.id);
    f.raw.prepare('DELETE FROM care_customers WHERE id = ?').run(a.id);
    expect(fresh().map((r) => `${r.entity}:${r.op}`)).toEqual(['profile:delete', 'customer:delete']);
  });

  it('a rolled back write leaves no row (same transaction)', () => {
    const { f, fresh } = setup();
    const c = f.stores.customers.createCustomer({ displayName: 'A' });
    fresh();
    expect(() =>
      f.raw.transaction(() => {
        f.stores.customers.updateCustomer(c.id, { stage: 'won' }, c.revision);
        throw new Error('boom');
      })(),
    ).toThrow('boom');
    expect(fresh()).toEqual([]);
  });

  it('a customer created by ingest is in the feed', () => {
    const { f, fresh } = setup();
    f.ingest.ingestNormalizedMessage(chatMessage(f.account));
    expect(fresh().filter((r) => r.entity === 'customer' && r.op === 'insert')).toHaveLength(1);
  });
});

describe('care customers service', () => {
  it('pages over every customer with a cursor, past the 500 cap of listCustomers', () => {
    const { f, api } = setup();
    for (let i = 0; i < 620; i++) f.stores.customers.createCustomer({ displayName: `K${i}` });
    const seen = new Set<string>();
    let after: string | null = null;
    let pages = 0;
    do {
      const page = api.list({ after, limit: 250 });
      for (const c of page.items) seen.add(c.id);
      after = page.next;
      pages++;
    } while (after);
    expect(seen.size).toBe(620);
    expect(pages).toBe(3);
  });

  it('returns decrypted fields, merged needs, open tasks by due date and the history', () => {
    const { f, api } = setup();
    const c = f.stores.customers.createCustomer({ displayName: 'Chị Lan', phone: '0901', tags: 'hỏi sỉ, ô long;; ' });
    f.stores.profiles.saveProfile(c.id, { need: { service: 'Trà sen', budget: '2tr' } }, f.account.id);
    f.raw.prepare('UPDATE care_profiles SET updated_at = 1 WHERE customer_id = ?').run(c.id); // older
    f.stores.profiles.saveProfile(c.id, { need: { service: 'Ô long' }, note: 'thích quà' }, null);
    const late = f.stores.tasks.createTask({ customerId: c.id, title: 'Gửi mẫu', dueAtMs: 1_900_000_000_000 });
    f.stores.tasks.createTask({ customerId: c.id, title: 'Báo giá', dueAtMs: 1_800_000_000_000 });
    const done = f.stores.tasks.createTask({ customerId: c.id, title: 'Xong rồi', dueAtMs: 1_700_000_000_000 });
    f.stores.tasks.setTaskDone(done.id, true);

    const v = api.get(c.id)!;
    expect(v).toMatchObject({ displayName: 'Chị Lan', phone: '0901', stage: 'new', tags: ['hỏi sỉ', 'ô long'], careNote: 'thích quà' });
    expect(v.need).toEqual([
      { field: 'service', value: 'Ô long' },
      { field: 'budget', value: '2tr' },
    ]);
    expect(v.openTasks.map((t) => t.title)).toEqual(['Báo giá', 'Gửi mẫu']);
    expect(api.history(c.id, 3)[0]).toMatchObject({ entity: 'task', op: 'update', taskTitle: 'Xong rồi' });
    expect(api.history(c.id).find((e) => e.entityId === late.id)?.taskTitle).toBe('Gửi mẫu');
    expect(api.get('missing')).toBeNull();
  });
});
