/**
 * CareProfileStore.updateProfile (compare-and-set on revision), the CONVERSATION_STATUSES constant and
 * CareMessageStore.listByConversation, added in the CC-23 follow-up.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CareError } from '../../../_lib/care-kit/errors.js';
import { memoryFixture, chatMessage, type MemoryFixture } from '../test-fixtures.js';
import { CONVERSATION_STATUSES } from './conversation-store.js';

const open: MemoryFixture[] = [];
afterEach(() => open.splice(0).forEach((f) => f.close()));
const fixture = () => {
  const f = memoryFixture();
  open.push(f);
  return f;
};

function caught(fn: () => unknown): CareError {
  try {
    fn();
  } catch (err) {
    return err as CareError;
  }
  throw new Error('expected the call to throw');
}

describe('CareProfileStore.updateProfile (compare-and-set)', () => {
  function seeded() {
    const f = fixture();
    const customer = f.stores.customers.createCustomer({ displayName: 'Khach A' });
    const p = f.stores.profiles.saveProfile(customer.id, { need: { service: 'Tour' }, note: 'ghi chu' }, f.account.id, 'care:customer_care');
    return { f, customer, p };
  }

  it('changes only the fields in the patch, bumps the revision once and stamps the given time', () => {
    const { f, p } = seeded();
    const next = f.stores.profiles.updateProfile(p.id, { note: 'moi' }, p.revision, 1_700_000_000_000);
    expect(next).toMatchObject({ note: 'moi', need: { service: 'Tour' }, revision: p.revision + 1, updatedAtMs: 1_700_000_000_000, accountId: f.account.id });
    const cleared = f.stores.profiles.updateProfile(p.id, { need: null }, next.revision);
    expect(cleared.need).toBeNull();
    expect(cleared.note).toBe('moi');
  });

  it('a stale revision is a 409 carrying the current one, and nothing is written', () => {
    const { f, p } = seeded();
    f.stores.profiles.updateProfile(p.id, { note: 'first writer' }, p.revision);
    const err = caught(() => f.stores.profiles.updateProfile(p.id, { note: 'second writer' }, p.revision));
    expect(err.code).toBe('STALE_REVISION');
    expect(err.status).toBe(409);
    expect((err.details as { currentRevision: number }).currentRevision).toBe(p.revision + 1);
    expect(f.stores.profiles.getProfile(p.id)!.note).toBe('first writer');
  });

  it('a no-op patch keeps the revision, and an unknown profile is 404', () => {
    const { f, p } = seeded();
    expect(f.stores.profiles.updateProfile(p.id, { note: 'ghi chu', need: { service: 'Tour' } }, p.revision).revision).toBe(p.revision);
    expect(caught(() => f.stores.profiles.updateProfile('missing', { note: 'x' }, 1)).code).toBe('NOT_FOUND');
  });

  it('can rewrite provenance when given, and stores the note encrypted', () => {
    const { f, p } = seeded();
    const next = f.stores.profiles.updateProfile(p.id, { provenance: 'care:other' }, p.revision);
    expect(next.provenance).toBe('care:other');
    const raw = f.raw.prepare('SELECT note_enc FROM care_profiles WHERE id = ?').get(p.id) as { note_enc: string };
    expect(raw.note_enc).not.toContain('ghi chu');
  });
});

describe('conversation status constants and message listing', () => {
  it('CONVERSATION_STATUSES are the labels the bridge writes, and the read model offers them before any row uses them', () => {
    expect([...CONVERSATION_STATUSES]).toEqual(['active', 'source_deleted']);
  });

  it('listByConversation is newest-first, inclusive of the anchor, and skips deleted rows and tombstones', () => {
    const f = fixture();
    const ids: string[] = [];
    for (let i = 1; i <= 5; i += 1) {
      const r = f.ingest.ingestNormalizedMessage(chatMessage(f.account, { externalConversationKey: 'peer:1', nativeMessageId: `m${i}`, sentAtMs: i * 1000, text: `tin ${i}` }), undefined, 1);
      ids.push(r.messageId!);
    }
    const conv = f.stores.conversations.getConversationByExternalKey(f.account.id, 'peer:1')!;
    expect(f.stores.messages.listByConversation(conv.id).map((m) => m.text)).toEqual(['tin 5', 'tin 4', 'tin 3', 'tin 2', 'tin 1']);
    const upTo = f.stores.messages.listByConversation(conv.id, { limit: 2, upTo: { sentAtMs: 3000, id: ids[2] } });
    expect(upTo.map((m) => m.text)).toEqual(['tin 3', 'tin 2']);
    f.stores.messages.softDeleteMessage(ids[3]);
    expect(f.stores.messages.listByConversation(conv.id).map((m) => m.text)).toEqual(['tin 5', 'tin 3', 'tin 2', 'tin 1']);
  });
});
