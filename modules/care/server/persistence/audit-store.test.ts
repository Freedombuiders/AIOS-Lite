/**
 * CC-18/19 audit schema + store: additive/idempotent schema, history ordering, encrypted field changes.
 */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createCareStores } from './index.js';
import { createCareSchema } from './schema.js';
import { ensureAuditSchema } from './audit-store.js';
import { TEST_KEY } from '../test-fixtures.js';

const open: Database.Database[] = [];
afterEach(() => open.splice(0).forEach((db) => db.close()));

function fresh() {
  const db = new Database(':memory:');
  open.push(db);
  createCareSchema(db);
  return { db, stores: createCareStores(db, TEST_KEY) };
}

describe('audit schema', () => {
  it('is idempotent and survives repeated boots', () => {
    const { db } = fresh();
    createCareSchema(db);
    createCareSchema(db);
    ensureAuditSchema(db);
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'care\\_link\\_%' ESCAPE '\\'`).all() as Array<{ name: string }>).map((t) => t.name);
    expect(tables.sort()).toEqual(['care_link_events', 'care_link_field_changes', 'care_link_moves']);
  });
});

describe('audit store', () => {
  it('keeps identity membership history in order and exposes the latest change', () => {
    const { stores } = fresh();
    stores.audit.insertLinkEvent({ id: 'L1', kind: 'link', payloadHash: 'h', targetCustomerId: 'T', refs: {}, revisions: {} });
    stores.audit.addMembership({ linkEventId: 'L1', identityId: 'i1', fromCustomerId: 'S', toCustomerId: 'T', kind: 'link' });
    stores.audit.addMembership({ linkEventId: 'L2', identityId: 'i1', fromCustomerId: 'T', toCustomerId: 'S', kind: 'unlink' });
    expect(stores.audit.latestMembership('i1')).toMatchObject({ kind: 'unlink', fromCustomerId: 'T', toCustomerId: 'S' });
    expect(stores.audit.membershipHistory('i1').map((m) => m.kind)).toEqual(['link', 'unlink']);
    expect(stores.audit.latestMembership('nobody')).toBeNull();
  });

  it('request ids are unique and look up the stored event', () => {
    const { stores } = fresh();
    const base = { kind: 'link' as const, payloadHash: 'h', targetCustomerId: 'T', refs: {}, revisions: {} };
    stores.audit.insertLinkEvent({ id: 'L1', requestId: 'r', ...base });
    expect(() => stores.audit.insertLinkEvent({ id: 'L2', requestId: 'r', ...base })).toThrow();
    expect(stores.audit.findLinkEventByRequest('r')?.id).toBe('L1');
    stores.audit.insertLinkEvent({ id: 'L3', ...base });
    stores.audit.insertLinkEvent({ id: 'L4', ...base }); // no request id: any number allowed
  });

  it('stores explicit field choices encrypted and clears them when settled', () => {
    const { db, stores } = fresh();
    stores.audit.addFieldChange({ linkEventId: 'L1', customerId: 'T', field: 'phone', sourceCustomerId: 'S', previousValue: '0901 111 222', appliedValue: '0902 333 444' });
    const raw = JSON.stringify(db.prepare('SELECT * FROM care_link_field_changes').all());
    expect(raw).not.toContain('0901 111 222');
    expect(raw).not.toContain('0902 333 444');
    const [open1] = stores.audit.listOpenFieldChanges('L1');
    expect(open1).toMatchObject({ field: 'phone', previousValue: '0901 111 222', appliedValue: '0902 333 444' });
    stores.audit.settleFieldChange(open1.seq, 'restored');
    expect(stores.audit.listOpenFieldChanges('L1')).toEqual([]);
    expect(db.prepare('SELECT previous_enc, applied_enc, outcome FROM care_link_field_changes').get()).toEqual({ previous_enc: null, applied_enc: null, outcome: 'restored' });
  });

  it('only the latest real move counts for an entity; baselines do not change its location', () => {
    const { stores } = fresh();
    stores.audit.addMove({ linkEventId: 'L1', entityType: 'task', entityId: 't', kind: 'move', fromCustomerId: 'S', toCustomerId: 'T' });
    stores.audit.addMove({ linkEventId: 'L2', entityType: 'task', entityId: 't', kind: 'baseline', fromCustomerId: 'T', toCustomerId: 'T' });
    expect(stores.audit.latestMove('task', 't')).toMatchObject({ fromCustomerId: 'S', toCustomerId: 'T', kind: 'move' });
    expect(stores.audit.hasBaseline('L2', 'task', 't')).toBe(true);
    expect(stores.audit.hasBaseline('L1', 'task', 't')).toBe(false);
  });
});
