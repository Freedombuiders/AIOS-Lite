import { describe, expect, it } from 'vitest';
import type { CareAssignmentDto, CareDraftDto, CareActivityItemDto } from '@modules/care/server/api/dto-ops';
import { KNOWN_REASONS, activityTone, appendActivity, reasonCode } from './activity';
import { anyDirty, dirtyKeys, resetDirtyForTests, setDirty } from './dirtyGuard';
import { canCancelScheduled, draftPatch, editFromDraft, isReviewable, parseAddresses, planApprove, validateEdit } from './draftReview';
import { toCareFailure } from './failure';
import { conflictIds, emptyRule, fromAssignment, policyFieldsFor, policyWarnings, quietModesFor, toBody, toPolicyExt, validateRule, type RuleForm } from './rules';

const accounts = [{ id: 'z1', channel: 'zalo' as const }, { id: 'm1', channel: 'email' as const }, { id: 't1', channel: 'telegram' as const }];
const rule = (over: Partial<RuleForm> = {}): RuleForm => ({ ...emptyRule(), accountId: 'z1', ...over });
const codes = (f: RuleForm) => validateRule(f, accounts).map((e) => `${e.field}:${e.code}`);

describe('rule shape per scope', () => {
  it('a valid account rule has no errors', () => {
    expect(codes(rule())).toEqual([]);
  });
  it('each scope demands and forbids the fields the store does', () => {
    expect(codes(rule({ scope: 'account', accountId: '' }))).toContain('accountId:required');
    expect(codes(rule({ scope: 'global', accountId: 'z1' }))).toContain('accountId:notAllowed');
    expect(codes(rule({ scope: 'channel', accountId: '', channel: '' }))).toContain('channel:required');
    expect(codes(rule({ scope: 'channel', accountId: 'z1', channel: 'zalo' }))).toEqual(expect.arrayContaining(['accountId:notAllowed']));
    expect(codes(rule({ scope: 'customer', accountId: '', customerId: '' }))).toContain('customerId:required');
    expect(codes(rule({ scope: 'customer', accountId: '', customerId: 'c1' }))).toEqual([]); // account optional
    expect(codes(rule({ scope: 'conversation', scopeTarget: '' }))).toContain('scopeTarget:required');
    expect(codes(rule({ scope: 'domain', accountId: 'z1', scopeTarget: 'x.vn' }))).toContain('accountId:domainNeedsEmail');
    expect(codes(rule({ scope: 'domain', accountId: 'm1', scopeTarget: 'x.vn' }))).toEqual([]);
  });
  it('priority must be an integer in range', () => {
    expect(codes(rule({ priority: 'cao' }))).toContain('priority:integer');
    expect(codes(rule({ priority: '1.5' }))).toContain('priority:integer');
    expect(codes(rule({ priority: '-5' }))).toEqual([]);
    expect(codes(rule({ priority: '2000000' }))).toContain('priority:range');
  });
  it('a DISABLED rule must be confirmed: it silences its scope', () => {
    expect(codes(rule({ enabled: false }))).toContain('confirmDisabled:required');
    expect(codes(rule({ enabled: false, confirmDisabled: true }))).toEqual([]);
  });
  it('quiet-hours mode must exist for the channel', () => {
    expect(codes(rule({ accountId: 'm1', policy: { ...emptyRule().policy, quietHoursMode: 'defer' } }))).toEqual([]);
  });
  it('counts must be non-negative integers', () => {
    expect(codes(rule({ policy: { ...emptyRule().policy, humanPauseMinutes: '-1' } }))).toContain('humanPauseMinutes:nonNegativeInteger');
  });
});

describe('channel extensions', () => {
  it('chat and email offer different fields; an unknown channel offers all', () => {
    expect(policyFieldsFor('zalo')).toContain('groupTrigger');
    expect(policyFieldsFor('zalo')).not.toContain('primaryOnly');
    expect(policyFieldsFor('email')).toContain('primaryOnly');
    expect(policyFieldsFor('email')).not.toContain('groupTrigger');
    expect(policyFieldsFor('')).toEqual(expect.arrayContaining(['groupTrigger', 'primaryOnly']));
  });
  it('only stated, applicable fields are written; unknown keys survive', () => {
    const f = rule({ accountId: 'z1', extra: { legacyScope: 'account_dms' }, policy: { ...emptyRule().policy, groupTrigger: 'keyword', triggerKeywords: 'giá, báo giá\nship', primaryOnly: 'true', maxRepliesPerThreadDay: '5', autoDelaySeconds: '0', conversationKinds: ['group'] } });
    expect(toPolicyExt(f, 'zalo')).toEqual({ legacyScope: 'account_dms', groupTrigger: 'keyword', triggerKeywords: ['giá', 'báo giá', 'ship'], maxRepliesPerThreadDay: 5, autoDelaySeconds: 0, conversationKinds: ['group'] }); // primaryOnly is email-only
    expect(toPolicyExt(rule(), 'zalo')).toBeNull();
  });
  it('round-trips an assignment through the form', () => {
    const a: CareAssignmentDto = { id: 'r1', scope: 'account', accountId: 'm1', customerId: null, channel: null, scopeTarget: null, priority: 7, enabled: true, mode: 'auto', agentId: 'ag', instructionsRef: null, policyExt: { primaryOnly: false, reviewKeywords: ['khiếu nại'], humanPauseMinutes: 240, custom: 1 }, configVersion: 3 };
    const form = fromAssignment(a);
    expect(form).toMatchObject({ id: 'r1', configVersion: 3, priority: '7', extra: { custom: 1 } });
    expect(form.policy).toMatchObject({ primaryOnly: 'false', reviewKeywords: 'khiếu nại', humanPauseMinutes: '240' });
    const body = toBody(form, accounts);
    expect(body).toMatchObject({ scope: 'account', accountId: 'm1', priority: 7, expectedConfigVersion: 3, mode: 'auto', agentId: 'ag' });
    expect(body.policyExt).toEqual({ custom: 1, reviewKeywords: ['khiếu nại'], primaryOnly: false, humanPauseMinutes: 240 });
    expect(toBody(form, accounts, { dryRun: true }).dryRun).toBe(true);
  });
  it('the body drops fields the scope does not take', () => {
    const body = toBody(rule({ scope: 'global', accountId: 'z1', channel: 'zalo', customerId: 'c', scopeTarget: 'x' }), accounts);
    expect(body).toMatchObject({ accountId: null, channel: null, customerId: null, scopeTarget: null });
  });
  it('reads conflict and policy details from error envelopes', () => {
    const f = toCareFailure({ status: 409, body: { code: 'CONFIGURATION_CONFLICT', message: 'm', details: { reason: 'PRIORITY_CONFLICT', assignmentIds: ['a', 'b', 3] } } });
    expect(f.reason).toBe('PRIORITY_CONFLICT');
    expect(conflictIds(f.details)).toEqual(['a', 'b']);
    expect(policyWarnings({ reason: 'INVALID_POLICY_EXT', warnings: ['policy_ext.x: bad'] })).toEqual(['policy_ext.x: bad']);
    expect(conflictIds(undefined)).toEqual([]);
  });
});

const draft = (over: Partial<CareDraftDto> = {}): CareDraftDto => ({
  id: 'd1', clientRequestId: 'cr', conversationId: 'c1', accountId: 'a1', status: 'draft', receiptLevel: null, messageId: null, retryAtMs: null, errorCode: null, createdAtMs: 1, updatedAtMs: 2,
  payloadRevision: 4, approvedRevision: null, contextRevision: 6, policyRevision: 'abcdef123456', actor: 'auto', channel: 'email', text: 'Chào anh', email: { to: ['k@x.test'], cc: ['c@x.test'], subject: 'Re: Báo giá', hasBcc: true }, ...over,
});

describe('draft review', () => {
  it('no edit: approve exactly the loaded revision', () => {
    const d = draft();
    expect(draftPatch(d, editFromDraft(d))).toBeNull();
    expect(planApprove(d, editFromDraft(d))).toEqual({ kind: 'approve', revision: 4 });
  });
  it('an edit saves first (against the loaded revision) and only then approves the NEW one', () => {
    const d = draft();
    const e = { ...editFromDraft(d), text: 'Chào anh, em gửi báo giá', cc: 'c@x.test, moi@x.test' };
    const plan = planApprove(d, e, 9);
    expect(plan).toEqual({ kind: 'save_then_approve', patch: { expectedRevision: 4, text: 'Chào anh, em gửi báo giá', cc: ['c@x.test', 'moi@x.test'], currentContextRevision: 9 } });
  });
  it('recipient changes are case-insensitive no-ops; BCC is never part of the patch', () => {
    const d = draft();
    const patch = draftPatch(d, { ...editFromDraft(d), to: 'K@X.test' });
    expect(patch).toBeNull();
    const withEdit = draftPatch(d, { ...editFromDraft(d), subject: 'Re: Khác' });
    expect(JSON.stringify(withEdit)).not.toMatch(/bcc/i);
  });
  it('chat drafts only patch text', () => {
    const d = draft({ channel: 'zalo', email: null });
    expect(draftPatch(d, { ...editFromDraft(d), text: 'khác' })).toEqual({ expectedRevision: 4, text: 'khác' });
  });
  it('validates text, recipients and subject', () => {
    const d = draft();
    expect(validateEdit(d, { ...editFromDraft(d), text: ' ', to: '', subject: '' })).toEqual(['textRequired', 'toRequired', 'subjectRequired']);
    expect(validateEdit(d, { ...editFromDraft(d), to: 'khong-phai-mail' })).toContain('toInvalid');
    expect(validateEdit(d, editFromDraft(d))).toEqual([]);
    expect(parseAddresses('A <a@x.test>; b@y.test, a@x.test, rac').invalid).toEqual(['rac']);
    expect(parseAddresses('A <a@x.test>; b@y.test, a@x.test').list).toEqual(['a@x.test', 'b@y.test']);
  });
  it('only drafts are reviewable; only scheduled sends can be cancelled', () => {
    expect(isReviewable(draft())).toBe(true);
    expect(isReviewable(draft({ status: 'pending' }))).toBe(false);
    expect(canCancelScheduled(draft({ status: 'pending' }))).toBe(true);
    expect(canCancelScheduled(draft({ status: 'retry_wait' }))).toBe(true);
    expect(canCancelScheduled(draft({ status: 'sending' }))).toBe(false);
    expect(canCancelScheduled(draft({ status: 'sent' }))).toBe(false);
  });
});

describe('activity feed', () => {
  const run = (id: string, over: Partial<Extract<CareActivityItemDto, { kind: 'run' }>> = {}): CareActivityItemDto => ({ kind: 'run', atMs: 5, id, accountId: 'a', conversationId: 'c', status: 'skipped', skipReason: 'quiet_hours', mode: 'auto', triggerKind: 'inbound', draftRef: null, ...over });
  it('known skip reasons have wording; odd values never render', () => {
    expect(KNOWN_REASONS.has('thread_quota')).toBe(true);
    expect(reasonCode('quiet_hours')).toBe('quiet_hours');
    expect(reasonCode('<script>alert(1)</script>')).toBeNull();
    expect(reasonCode(null)).toBeNull();
  });
  it('tones follow status', () => {
    expect(activityTone(run('1', { status: 'drafted' }))).toBe('done');
    expect(activityTone(run('1', { status: 'failed' }))).toBe('failed');
    expect(activityTone({ kind: 'delivery', atMs: 1, id: 'd', accountId: 'a', conversationId: null, status: 'uncertain', statusReason: null, actor: 'auto', receiptLevel: null })).toBe('failed');
  });
  it('pages append without duplicating items that moved', () => {
    expect(appendActivity([run('1'), run('2')], [run('2'), run('3')]).map((i) => i.id)).toEqual(['1', '2', '3']);
  });
});

describe('dirty guard', () => {
  it('tracks unsaved forms by key', () => {
    resetDirtyForTests();
    expect(anyDirty()).toBe(false);
    setDirty('customer:c1', true);
    expect(anyDirty()).toBe(true);
    setDirty('customer:c1', false);
    expect(dirtyKeys()).toEqual([]);
  });
});
