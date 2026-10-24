import { describe, expect, it } from 'vitest';
import type { CareCustomerCareDto, CareLinkPreviewDto } from '@modules/care/server/api/dto-ops';
import { careCoreAdapter, snapshotFromCareDto } from './adapters';
import {
  buildLinkBody, buildUnlinkBody, canLink, emptyChoices, requestIdFor, toResolution, undecidedFieldNames, undecidedFromDetails, unlinkReady, unresolvedFields,
} from './link';
import { buildSaveBody, classifySaveFailure, isDirty, joinNeed, rebaseEdits, splitNeed, validate } from './model';

const dto = (over: Partial<CareCustomerCareDto> = {}): CareCustomerCareDto => ({
  conversationId: 'c1', accountId: 'a1', participantIdentityId: null,
  customer: { id: 'cu1', displayName: 'Chị Lan', company: null, phone: '0900', email: null, stage: 'consulting', tags: 'vip', owner: 'Minh', revision: 4 },
  profile: { id: 'p1', accountId: 'a1', provenance: 'care:customer_care', need: { service: 'villa', budget: '5tr', sourceMessageId: 'm9' }, note: 'gọi lại', revision: 2, updatedAtMs: 1 },
  otherProfiles: [{ id: 'p2', accountId: null, provenance: 'zalo:legacy', need: null, note: 'ghi chú cũ', revision: 7, updatedAtMs: 1 }],
  tasks: [{ id: 't1', title: 'Gọi lại', dueAtMs: 5, done: false, owner: null, revision: 3, conversationId: 'c1' }],
  writeOwner: 'core', writable: true, ...over,
});

describe('core adapter mapping', () => {
  it('maps the DTO into the shared model, keeping revisions, provenance and untouched need keys', () => {
    const s = snapshotFromCareDto(dto());
    expect(s.value).toMatchObject({ displayName: 'Chị Lan', company: '', email: '', stage: 'consulting', note: 'gọi lại' });
    expect(s.value.need).toMatchObject({ service: 'villa', budget: '5tr', dates: '' });
    expect(s.needExtra).toEqual({ sourceMessageId: 'm9' });
    expect(s.revisions).toEqual({ customer: 4, profile: 2 });
    expect(s.profileProvenance).toBe('care:customer_care');
    expect(s.otherProfiles[0]).toMatchObject({ provenance: 'zalo:legacy', revision: 7 });
    expect(s.writable).toBe(true);
  });

  it('no profile yet: profile revision is null and the first save uses 0', () => {
    const s = snapshotFromCareDto(dto({ profile: null }));
    expect(s.revisions.profile).toBeNull();
    const body = buildSaveBody(s, { ...s.value, note: 'mới' });
    expect(body).toEqual({ expectedProfileRevision: 0, profile: { note: 'mới' } });
  });

  it('an unknown stage falls back safely', () => {
    expect(snapshotFromCareDto(dto({ customer: { ...dto().customer, stage: 'weird' } })).value.stage).toBe('new');
  });

  it('save sends only what changed, each part with the revision the operator saw', () => {
    const s = snapshotFromCareDto(dto());
    expect(buildSaveBody(s, s.value)).toBeNull();
    const body = buildSaveBody(s, { ...s.value, phone: ' 0911 ', company: '', stage: 'won', need: { ...s.value.need, dates: '1-3/11' } });
    expect(body).toEqual({
      expectedCustomerRevision: 4,
      customer: { phone: '0911', stage: 'won' }, // company stayed empty -> unchanged
      expectedProfileRevision: 2,
      profile: { need: { sourceMessageId: 'm9', service: 'villa', dates: '1-3/11', budget: '5tr' } }, // the extra key rides along
    });
  });

  it('clearing a nullable field sends null, never an empty string', () => {
    const s = snapshotFromCareDto(dto());
    expect(buildSaveBody(s, { ...s.value, phone: '', tags: '' })?.customer).toEqual({ phone: null, tags: null });
  });

  it('the adapter saves through the injected io and returns the fresh server copy', async () => {
    const calls: unknown[] = [];
    const adapter = careCoreAdapter({ get: async () => dto(), put: async (b) => { calls.push(b); return dto({ customer: { ...dto().customer, revision: 5, phone: '0911' } }); } }, buildSaveBody);
    const s = await adapter.load();
    const saved = await adapter.save(s, { ...s.value, phone: '0911' });
    expect(calls).toEqual([{ expectedCustomerRevision: 4, customer: { phone: '0911' } }]);
    expect(saved.revisions.customer).toBe(5);
    expect(await adapter.save(s, s.value)).toBe(s); // nothing to save: no request
    expect(calls).toHaveLength(1);
  });
});

describe('form model', () => {
  it('dirty ignores surrounding whitespace', () => {
    const s = snapshotFromCareDto(dto());
    expect(isDirty(s.value, { ...s.value, displayName: ' Chị Lan ' })).toBe(false);
    expect(isDirty(s.value, { ...s.value, note: 'khác' })).toBe(true);
  });
  it('validates required name, email shape and lengths', () => {
    const v = snapshotFromCareDto(dto()).value;
    expect(validate({ ...v, displayName: '  ' }).displayName).toBe('required');
    expect(validate({ ...v, email: 'khong-hop-le' }).email).toBe('email');
    expect(validate({ ...v, email: 'a@b.test' })).toEqual({});
  });
  it('need split/join round-trips and drops empties', () => {
    const { fields, extra } = splitNeed({ service: 'x', other: 1 });
    expect(joinNeed(fields, extra)).toEqual({ other: 1, service: 'x' });
    expect(joinNeed(splitNeed(null).fields, {})).toBeNull();
  });
  it('rebase keeps my edits on top of the other writer', () => {
    const base = snapshotFromCareDto(dto()).value;
    const mine = { ...base, phone: '0911', note: 'của tôi' };
    const theirs = { ...base, stage: 'won' as const, note: 'của họ', owner: 'Hà' };
    const { value, overlapping } = rebaseEdits(base, mine, theirs);
    expect(value).toMatchObject({ phone: '0911', stage: 'won', owner: 'Hà', note: 'của tôi' });
    expect(overlapping).toEqual(['note']); // both changed the note: mine wins, the operator is told
  });
  it('classifies save failures: legacy-owned is a state, not an error', () => {
    const f = (o: object) => ({ status: 409, code: 'X', message: 'm', ...o });
    expect(classifySaveFailure(f({ code: 'CONFIGURATION_CONFLICT', reason: 'LEGACY_OWNED' }))).toEqual({ kind: 'legacy_owned' });
    expect(classifySaveFailure(f({ code: 'ACCOUNT_FROZEN', reason: 'ACCOUNT_DRAINING' }))).toEqual({ kind: 'draining' });
    expect(classifySaveFailure(f({ code: 'STALE_REVISION', reason: 'PROFILE_REVISION' }))).toEqual({ kind: 'stale', part: 'profile' });
    expect(classifySaveFailure(f({ code: 'STALE_REVISION', reason: 'CUSTOMER_REVISION' }))).toEqual({ kind: 'stale', part: 'customer' });
    expect(classifySaveFailure(f({ status: 404, code: 'NOT_FOUND' }))).toEqual({ kind: 'gone' });
    expect(classifySaveFailure(f({ status: 500, code: 'INTERNAL_ERROR', message: 'boom' }))).toEqual({ kind: 'other', message: 'boom' });
  });
});

const preview = (over: Partial<CareLinkPreviewDto> = {}): CareLinkPreviewDto => ({
  targetCustomerId: 'T', suggestedTarget: false, noop: false,
  people: [{ customerId: 'T', role: 'target', displayName: 'A', revision: 3, movingIdentityIds: [] }, { customerId: 'S', role: 'source', displayName: 'B', revision: 5, movingIdentityIds: ['i1'] }],
  identities: [], accounts: [], channels: ['zalo'],
  conflicts: [{ field: 'phone', values: [{ customerId: 'T', value: '1' }, { customerId: 'S', value: '2' }] }, { field: 'owner', values: [{ customerId: 'T', value: 'x' }, { customerId: 'S', value: 'y' }] }],
  profileConflicts: [], moves: { profiles: 1, tasks: 2, conversations: 3 }, expectedRevisions: { T: 3, S: 5 }, ...over,
});

describe('link request', () => {
  it('every conflicting field needs a choice unless the operator keeps the target for the rest', () => {
    const p = preview();
    expect(unresolvedFields(p, emptyChoices())).toEqual(['phone', 'owner']);
    expect(canLink(p, emptyChoices())).toBe(false);
    expect(canLink(p, { ...emptyChoices(), fields: { phone: { mode: 'target' } } })).toBe(false);
    expect(canLink(p, { fields: { phone: { mode: 'target' }, owner: { mode: 'customer', customerId: 'S' } }, keepTargetForUnresolved: false })).toBe(true);
    expect(canLink(p, { fields: {}, keepTargetForUnresolved: true })).toBe(true);
    expect(canLink(preview({ noop: true, conflicts: [] }), emptyChoices())).toBe(false);
  });
  it('builds the body with the preview revisions and the API resolution shapes', () => {
    const body = buildLinkBody({ customerIds: ['S'] }, preview(), { fields: { phone: { mode: 'customer', customerId: 'S' }, owner: { mode: 'custom', value: '  ' } }, keepTargetForUnresolved: false }, 'req-1');
    expect(body).toEqual({
      customerIds: ['S'], targetCustomerId: 'T', expectedRevisions: { T: 3, S: 5 },
      resolutions: { phone: { fromCustomerId: 'S' }, owner: { value: null } }, requestId: 'req-1',
    });
    expect(toResolution({ mode: 'target' })).toEqual({ keep: 'target' });
    expect(buildLinkBody({ identityIds: ['i1'] }, preview({ conflicts: [] }), { fields: {}, keepTargetForUnresolved: true }, 'r').keepTargetForUnresolved).toBe(true);
  });
  it('a retry reuses the request id; a changed payload gets a new one', () => {
    let n = 0;
    const gen = () => `id-${++n}`;
    const a = requestIdFor({ x: 1 }, null, gen);
    expect(requestIdFor({ x: 1 }, a, gen)).toBe(a);
    expect(requestIdFor({ x: 2 }, a, gen).id).toBe('id-2');
  });
  it('reads UNDECIDED_ITEMS from the error details and names the fields', () => {
    const details = { reason: 'UNDECIDED_ITEMS', items: [
      { itemKey: 'field:phone', type: 'field', id: 'phone', accountId: null, candidateCustomerIds: ['T', 'S'] },
      { itemKey: 'task:t9', type: 'task', id: 't9', accountId: 'a1', candidateCustomerIds: ['T', 'S'] }, 'junk', { itemKey: 1 },
    ] };
    const items = undecidedFromDetails(details);
    expect(items).toHaveLength(2);
    expect(undecidedFieldNames(items)).toEqual(['phone']);
    expect(undecidedFromDetails({ reason: 'OTHER' })).toEqual([]);
    expect(undecidedFromDetails(undefined)).toEqual([]);
  });
  it('unlink needs a valid keeper for every undecided item', () => {
    const items = [{ itemKey: 'task:t9', type: 'task', id: 't9', accountId: null, candidateCustomerIds: ['T', 'S'] }];
    expect(unlinkReady(items, {})).toBe(false);
    expect(unlinkReady(items, { 'task:t9': 'X' })).toBe(false);
    expect(unlinkReady(items, { 'task:t9': 'S' })).toBe(true);
    expect(buildUnlinkBody(['i1'], { T: 3 }, { 'task:t9': 'S' }, 'r')).toEqual({ identityIds: ['i1'], expectedRevisions: { T: 3 }, decisions: { 'task:t9': 'S' }, requestId: 'r' });
    expect(buildUnlinkBody(['i1'], { T: 3 }, {}, 'r').decisions).toBeUndefined();
  });
});
