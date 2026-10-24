// Assignment-rule form: shape validation per scope (the same constraints the store enforces),
// channel-specific policy extensions, and the body for create / update / dry-run. Tie-breaking and
// priority conflicts are NOT re-implemented here: the server's dry run is the single source.

import type { CareAssignmentDto } from '@modules/care/server/api/dto-ops';
import type { CareApiChannel } from './dto';

export const SCOPES = ['global', 'channel', 'account', 'customer', 'conversation', 'identity', 'domain'] as const;
export type RuleScope = (typeof SCOPES)[number];
export const MODES = ['observe', 'draft', 'auto'] as const;
export type RuleMode = (typeof MODES)[number];
export const GROUP_TRIGGERS = ['mention', 'keyword', 'mention_or_keyword', 'smart', 'all'] as const;
export const KINDS = ['direct', 'group', 'topic', 'email_thread'] as const;
export const DEFAULT_PRIORITY = 100;

type Need = 'none' | 'required';
export interface ScopeShape { account: Need | 'optional'; channel: Need; customer: Need | 'optional'; target: Need }

/** What each scope takes, mirroring the assignment store's validation. */
export const SCOPE_SHAPE: Record<RuleScope, ScopeShape> = {
  global: { account: 'none', channel: 'none', customer: 'none', target: 'none' },
  channel: { account: 'none', channel: 'required', customer: 'none', target: 'none' },
  account: { account: 'required', channel: 'none', customer: 'none', target: 'none' },
  customer: { account: 'optional', channel: 'none', customer: 'required', target: 'none' },
  conversation: { account: 'required', channel: 'none', customer: 'none', target: 'required' },
  identity: { account: 'required', channel: 'none', customer: 'none', target: 'required' },
  domain: { account: 'required', channel: 'none', customer: 'none', target: 'required' },
};

export type TriState = '' | 'true' | 'false';

/** Every policy field is optional: empty = "not stated", the channel default applies. */
export interface PolicyForm {
  groupTrigger: '' | (typeof GROUP_TRIGGERS)[number];
  triggerKeywords: string;
  handoffKeywords: string;
  reviewKeywords: string;
  primaryOnly: TriState;
  replyToAllMention: TriState;
  maxRepliesPerThreadDay: string;
  humanPauseMinutes: string;
  autoDelaySeconds: string;
  quietHoursMode: '' | 'auto_to_draft' | 'defer' | 'block';
  instructions: string;
  conversationKinds: Array<(typeof KINDS)[number]>;
}

export interface RuleForm {
  id: string | null;
  configVersion: number | null;
  scope: RuleScope;
  accountId: string;
  customerId: string;
  channel: '' | CareApiChannel;
  scopeTarget: string;
  priority: string;
  enabled: boolean;
  mode: RuleMode;
  agentId: string;
  instructionsRef: string;
  policy: PolicyForm;
  /** Policy keys this form does not edit (e.g. legacyScope): kept as they are. */
  extra: Record<string, unknown>;
  /** Required before saving a DISABLED rule: it silences its scope instead of falling back. */
  confirmDisabled: boolean;
}

export function emptyPolicy(): PolicyForm {
  return {
    groupTrigger: '', triggerKeywords: '', handoffKeywords: '', reviewKeywords: '', primaryOnly: '', replyToAllMention: '',
    maxRepliesPerThreadDay: '', humanPauseMinutes: '', autoDelaySeconds: '', quietHoursMode: '', instructions: '', conversationKinds: [],
  };
}

export function emptyRule(): RuleForm {
  return {
    id: null, configVersion: null, scope: 'account', accountId: '', customerId: '', channel: '', scopeTarget: '', priority: String(DEFAULT_PRIORITY),
    enabled: true, mode: 'draft', agentId: '', instructionsRef: '', policy: emptyPolicy(), extra: {}, confirmDisabled: false,
  };
}

const POLICY_KEYS = [
  'groupTrigger', 'triggerKeywords', 'handoffKeywords', 'reviewKeywords', 'primaryOnly', 'replyToAllMention', 'maxRepliesPerThreadDay',
  'humanPauseMinutes', 'autoDelaySeconds', 'quietHoursMode', 'instructions', 'conversationKinds',
] as const;

const tri = (v: unknown): TriState => (v === true ? 'true' : v === false ? 'false' : '');
const list = (v: unknown): string => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').join(', ') : '');
const numStr = (v: unknown): string => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '');

export function fromAssignment(a: CareAssignmentDto): RuleForm {
  const ext = a.policyExt ?? {};
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ext)) if (!(POLICY_KEYS as readonly string[]).includes(k)) extra[k] = v;
  const kinds = Array.isArray(ext.conversationKinds) ? ext.conversationKinds.filter((k): k is (typeof KINDS)[number] => (KINDS as readonly string[]).includes(k as string)) : [];
  return {
    id: a.id,
    configVersion: a.configVersion,
    scope: a.scope,
    accountId: a.accountId ?? '',
    customerId: a.customerId ?? '',
    channel: a.channel ?? '',
    scopeTarget: a.scopeTarget ?? '',
    priority: String(a.priority),
    enabled: a.enabled,
    mode: a.mode,
    agentId: a.agentId,
    instructionsRef: a.instructionsRef ?? '',
    policy: {
      groupTrigger: (GROUP_TRIGGERS as readonly unknown[]).includes(ext.groupTrigger) ? (ext.groupTrigger as PolicyForm['groupTrigger']) : '',
      triggerKeywords: list(ext.triggerKeywords),
      handoffKeywords: list(ext.handoffKeywords),
      reviewKeywords: list(ext.reviewKeywords),
      primaryOnly: tri(ext.primaryOnly),
      replyToAllMention: tri(ext.replyToAllMention),
      maxRepliesPerThreadDay: numStr(ext.maxRepliesPerThreadDay),
      humanPauseMinutes: numStr(ext.humanPauseMinutes),
      autoDelaySeconds: numStr(ext.autoDelaySeconds),
      quietHoursMode: (['auto_to_draft', 'defer', 'block'] as const).find((m) => m === ext.quietHoursMode) ?? '',
      instructions: typeof ext.instructions === 'string' ? ext.instructions : '',
      conversationKinds: kinds,
    },
    extra,
    confirmDisabled: false,
  };
}

// ── which policy fields apply to a channel ────────────────────────────────────────────────────
export type PolicyField = keyof PolicyForm;
const CHAT_FIELDS: PolicyField[] = ['groupTrigger', 'triggerKeywords', 'handoffKeywords', 'replyToAllMention', 'maxRepliesPerThreadDay', 'humanPauseMinutes', 'autoDelaySeconds', 'quietHoursMode', 'instructions', 'conversationKinds'];
const EMAIL_FIELDS: PolicyField[] = ['primaryOnly', 'reviewKeywords', 'handoffKeywords', 'maxRepliesPerThreadDay', 'humanPauseMinutes', 'autoDelaySeconds', 'quietHoursMode', 'instructions', 'conversationKinds'];

/** Fields a rule can state for a channel; an unknown channel (global / customer rules) offers all of them. */
export function policyFieldsFor(channel: CareApiChannel | ''): PolicyField[] {
  if (channel === 'email') return EMAIL_FIELDS;
  if (channel === 'zalo') return CHAT_FIELDS;
  return [...new Set([...CHAT_FIELDS, ...EMAIL_FIELDS])];
}

export function quietModesFor(channel: CareApiChannel | ''): Array<'auto_to_draft' | 'defer' | 'block'> {
  if (channel === 'email') return ['defer', 'auto_to_draft', 'block'];
  return ['auto_to_draft', 'defer', 'block'];
}

/** The channel a rule applies to, from its account or its own channel. */
export function ruleChannel(form: Pick<RuleForm, 'accountId' | 'channel'>, accounts: Array<{ id: string; channel: CareApiChannel }>): CareApiChannel | '' {
  if (form.accountId) return accounts.find((a) => a.id === form.accountId)?.channel ?? '';
  return form.channel;
}

const words = (s: string): string[] => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
const intOrNull = (s: string): number | null => (/^\d{1,9}$/.test(s.trim()) ? Number(s.trim()) : null);

export function toPolicyExt(form: RuleForm, channel: CareApiChannel | ''): Record<string, unknown> | null {
  const allowed = new Set(policyFieldsFor(channel));
  const p = form.policy;
  const out: Record<string, unknown> = { ...form.extra };
  const put = (k: PolicyField, v: unknown): void => { if (allowed.has(k)) out[k] = v; };
  if (p.groupTrigger) put('groupTrigger', p.groupTrigger);
  for (const k of ['triggerKeywords', 'handoffKeywords', 'reviewKeywords'] as const) if (words(p[k]).length) put(k, words(p[k]));
  if (p.primaryOnly) put('primaryOnly', p.primaryOnly === 'true');
  if (p.replyToAllMention) put('replyToAllMention', p.replyToAllMention === 'true');
  for (const k of ['maxRepliesPerThreadDay', 'humanPauseMinutes', 'autoDelaySeconds'] as const) {
    const n = intOrNull(p[k]);
    if (n !== null) put(k, n);
  }
  if (p.quietHoursMode) put('quietHoursMode', p.quietHoursMode);
  if (p.instructions.trim()) put('instructions', p.instructions.trim());
  if (p.conversationKinds.length) put('conversationKinds', p.conversationKinds);
  return Object.keys(out).length ? out : null;
}

export type RuleError =
  | { field: 'accountId' | 'channel' | 'customerId' | 'scopeTarget' | 'priority' | 'agentId' | 'confirmDisabled' | PolicyField; code: string };

/** Client-side checks that need no server round trip (shape per scope, number formats, the deny confirmation). */
export function validateRule(form: RuleForm, accounts: Array<{ id: string; channel: CareApiChannel }>): RuleError[] {
  const errors: RuleError[] = [];
  const shape = SCOPE_SHAPE[form.scope];
  const add = (field: RuleError['field'], code: string): void => void errors.push({ field, code });
  if (shape.account === 'required' && !form.accountId) add('accountId', 'required');
  if (shape.account === 'none' && form.accountId) add('accountId', 'notAllowed');
  if (shape.channel === 'required' && !form.channel) add('channel', 'required');
  if (shape.channel === 'none' && form.channel) add('channel', 'notAllowed');
  if (shape.customer === 'required' && !form.customerId.trim()) add('customerId', 'required');
  if (shape.customer === 'none' && form.customerId.trim()) add('customerId', 'notAllowed');
  if (shape.target === 'required' && !form.scopeTarget.trim()) add('scopeTarget', 'required');
  if (form.scope === 'domain' && form.accountId && accounts.find((a) => a.id === form.accountId)?.channel !== 'email') add('accountId', 'domainNeedsEmail');
  if (!/^-?\d{1,7}$/.test(form.priority.trim())) add('priority', 'integer');
  else if (Math.abs(Number(form.priority)) > 1_000_000) add('priority', 'range');
  for (const k of ['maxRepliesPerThreadDay', 'humanPauseMinutes', 'autoDelaySeconds'] as const) {
    if (form.policy[k].trim() && intOrNull(form.policy[k]) === null) add(k, 'nonNegativeInteger');
  }
  const channel = ruleChannel(form, accounts);
  if (form.policy.quietHoursMode && !quietModesFor(channel).includes(form.policy.quietHoursMode)) add('quietHoursMode', 'notForChannel');
  if (!form.enabled && !form.confirmDisabled) add('confirmDisabled', 'required');
  return errors;
}

export interface RuleBody {
  scope: RuleScope;
  accountId?: string | null;
  customerId?: string | null;
  channel?: string | null;
  scopeTarget?: string | null;
  priority: number;
  enabled: boolean;
  mode: RuleMode;
  agentId?: string;
  instructionsRef?: string | null;
  policyExt: Record<string, unknown> | null;
  expectedConfigVersion?: number;
  dryRun?: boolean;
}

export function toBody(form: RuleForm, accounts: Array<{ id: string; channel: CareApiChannel }>, opts: { dryRun?: boolean } = {}): RuleBody {
  const shape = SCOPE_SHAPE[form.scope];
  const channel = ruleChannel(form, accounts);
  return {
    scope: form.scope,
    accountId: shape.account === 'none' ? null : form.accountId || null,
    customerId: shape.customer === 'none' ? null : form.customerId.trim() || null,
    channel: shape.channel === 'none' ? null : form.channel || null,
    scopeTarget: shape.target === 'none' ? null : form.scopeTarget.trim() || null,
    priority: Number(form.priority.trim()),
    enabled: form.enabled,
    mode: form.mode,
    ...(form.agentId.trim() ? { agentId: form.agentId.trim() } : {}),
    instructionsRef: form.instructionsRef.trim() || null,
    policyExt: toPolicyExt(form, channel),
    ...(form.id && form.configVersion !== null ? { expectedConfigVersion: form.configVersion } : {}),
    ...(opts.dryRun ? { dryRun: true } : {}),
  };
}

/** Plain-language one-liner for a rule row. */
export function scopeLabelKey(scope: RuleScope): string {
  return `rules.scope.${scope}`;
}

/** Priority-conflict details from a 409 (assignment ids that would tie). */
export function conflictIds(details: Record<string, unknown> | undefined): string[] {
  if (!details || details.reason !== 'PRIORITY_CONFLICT' || !Array.isArray(details.assignmentIds)) return [];
  return details.assignmentIds.filter((x): x is string => typeof x === 'string');
}

export function policyWarnings(details: Record<string, unknown> | undefined): string[] {
  if (!details || details.reason !== 'INVALID_POLICY_EXT' || !Array.isArray(details.warnings)) return [];
  return details.warnings.filter((x): x is string => typeof x === 'string');
}
