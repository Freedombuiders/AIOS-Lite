/**
 * Typed view of an assignment's imported policy extension (`CareAssignment.policyExt`).
 *
 * Every field is honoured on its own: a field the rule states keeps the rule's value, a field it
 * does not state takes the CHANNEL default (the value the legacy source used). Nothing is reset
 * to a common ceiling and nothing is inherited from a broader rule (a legacy assignment won as a
 * whole). Invalid values are dropped with a warning instead of being coerced.
 */

import type { CareAssignment, CareChannel, CareConversationKind } from '../../../_lib/care-kit/types.js';

export type GroupTrigger = 'mention' | 'keyword' | 'mention_or_keyword' | 'smart' | 'all';
export type QuietHoursMode = 'auto_to_draft' | 'defer' | 'block';
export type PolicyFieldSource = 'rule' | 'default';

export interface AutoDelayRange {
  minSeconds: number;
  maxSeconds: number;
}

export interface EffectivePolicy {
  /** Email: only the Primary category triggers the agent. */
  primaryOnly: boolean;
  /** Email: a match makes the reply wait for a person (never auto-sends). */
  reviewKeywords: string[];
  /** Chat groups: keyword trigger list. */
  triggerKeywords: string[];
  /** Advisory topics for the prompt; never an automatic hand-off. */
  handoffKeywords: string[];
  groupTrigger: GroupTrigger;
  /** Chat groups: an @all mention counts as addressing the account. */
  replyToAllMention: boolean;
  /** null = no per-conversation daily cap. */
  maxRepliesPerThreadDay: number | null;
  /** 0 disables the human-pause window. */
  humanPauseMinutes: number;
  autoDelay: AutoDelayRange;
  quietHoursMode: QuietHoursMode;
  instructions: string;
  /** Conversation kinds this rule is limited to (null = every kind). */
  conversationKinds: CareConversationKind[] | null;
}

export type PolicyField = keyof EffectivePolicy;

export interface ResolvedPolicy {
  values: EffectivePolicy;
  sources: Record<PolicyField, PolicyFieldSource>;
  warnings: string[];
}

/** Channel defaults = what the legacy source applied when a row did not say. */
export const CHANNEL_POLICY_DEFAULTS: Record<CareChannel, EffectivePolicy> = {
  zalo: {
    primaryOnly: false,
    reviewKeywords: [],
    triggerKeywords: [],
    handoffKeywords: [],
    groupTrigger: 'mention_or_keyword',
    replyToAllMention: false,
    maxRepliesPerThreadDay: 30,
    humanPauseMinutes: 30,
    // Legacy Zalo jittered auto replies 3-12 s so they do not look scripted.
    autoDelay: { minSeconds: 3, maxSeconds: 12 },
    quietHoursMode: 'auto_to_draft',
    instructions: '',
    conversationKinds: null,
  },
  email: {
    primaryOnly: true,
    reviewKeywords: [],
    triggerKeywords: [],
    handoffKeywords: [],
    groupTrigger: 'all',
    replyToAllMention: false,
    maxRepliesPerThreadDay: 3,
    humanPauseMinutes: 240,
    autoDelay: { minSeconds: 120, maxSeconds: 120 },
    quietHoursMode: 'defer',
    instructions: '',
    conversationKinds: null,
  },
  // Telegram AI is disabled by design in V1; the values exist so the type is total.
  telegram: {
    primaryOnly: false,
    reviewKeywords: [],
    triggerKeywords: [],
    handoffKeywords: [],
    groupTrigger: 'mention_or_keyword',
    replyToAllMention: false,
    maxRepliesPerThreadDay: 0,
    humanPauseMinutes: 30,
    autoDelay: { minSeconds: 0, maxSeconds: 0 },
    quietHoursMode: 'block',
    instructions: '',
    conversationKinds: null,
  },
};

export const POLICY_FIELDS = Object.keys(CHANNEL_POLICY_DEFAULTS.zalo) as PolicyField[];

const GROUP_TRIGGERS: readonly GroupTrigger[] = ['mention', 'keyword', 'mention_or_keyword', 'smart', 'all'];
const QUIET_MODES: Record<CareChannel, readonly QuietHoursMode[]> = {
  zalo: ['auto_to_draft', 'defer', 'block'],
  email: ['defer', 'auto_to_draft', 'block'],
  telegram: ['block'],
};
const KINDS: readonly CareConversationKind[] = ['direct', 'group', 'topic', 'email_thread'];
/** Legacy Zalo nick-wide defaults: `account_dms` (1-1 chats) and `account_groups`. */
const LEGACY_KIND_SCOPES: Record<string, CareConversationKind[]> = {
  account_dms: ['direct'],
  account_groups: ['group', 'topic'],
};

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** Conversation kinds a rule is limited to, from `conversationKinds` or a legacy nick-wide scope. */
export function ruleConversationKinds(policyExt: Record<string, unknown> | null | undefined): CareConversationKind[] | null {
  if (!policyExt) return null;
  const explicit = policyExt.conversationKinds;
  if (isStringArray(explicit) && explicit.length > 0 && explicit.every((k) => (KINDS as readonly string[]).includes(k))) {
    return explicit as CareConversationKind[];
  }
  const legacy = policyExt.legacyScope;
  if (typeof legacy === 'string' && LEGACY_KIND_SCOPES[legacy]) return LEGACY_KIND_SCOPES[legacy];
  return null;
}

export function resolvePolicy(
  assignment: Pick<CareAssignment, 'policyExt'>,
  channel: CareChannel,
): ResolvedPolicy {
  const ext = assignment.policyExt ?? {};
  const base = CHANNEL_POLICY_DEFAULTS[channel];
  const values: EffectivePolicy = {
    ...base,
    reviewKeywords: [...base.reviewKeywords],
    triggerKeywords: [...base.triggerKeywords],
    handoffKeywords: [...base.handoffKeywords],
    autoDelay: { ...base.autoDelay },
  };
  const sources = Object.fromEntries(POLICY_FIELDS.map((f) => [f, 'default'])) as Record<PolicyField, PolicyFieldSource>;
  const warnings: string[] = [];
  const has = (k: string): boolean => Object.prototype.hasOwnProperty.call(ext, k) && ext[k] !== undefined && ext[k] !== null;
  const bad = (k: string, why: string): void => void warnings.push(`policy_ext.${k}: ${why}`);

  const take = <K extends PolicyField>(field: K, value: EffectivePolicy[K]): void => {
    values[field] = value;
    sources[field] = 'rule';
  };

  if (has('primaryOnly')) (typeof ext.primaryOnly === 'boolean' ? take('primaryOnly', ext.primaryOnly) : bad('primaryOnly', 'not a boolean'));
  if (has('replyToAllMention')) (typeof ext.replyToAllMention === 'boolean' ? take('replyToAllMention', ext.replyToAllMention) : bad('replyToAllMention', 'not a boolean'));
  for (const k of ['reviewKeywords', 'triggerKeywords', 'handoffKeywords'] as const) {
    if (!has(k)) continue;
    if (isStringArray(ext[k])) take(k, (ext[k] as string[]).map((s) => s.trim()).filter(Boolean));
    else bad(k, 'not a string list');
  }
  if (has('groupTrigger')) {
    if (typeof ext.groupTrigger === 'string' && (GROUP_TRIGGERS as readonly string[]).includes(ext.groupTrigger)) take('groupTrigger', ext.groupTrigger as GroupTrigger);
    else bad('groupTrigger', 'unknown trigger kind');
  }
  // A missing/non-numeric legacy value is "not stated" (default), 0 is a legitimate stated value.
  if (has('maxRepliesPerThreadDay')) (isCount(ext.maxRepliesPerThreadDay) ? take('maxRepliesPerThreadDay', ext.maxRepliesPerThreadDay) : bad('maxRepliesPerThreadDay', 'not a non-negative integer'));
  if (has('humanPauseMinutes')) (isCount(ext.humanPauseMinutes) ? take('humanPauseMinutes', ext.humanPauseMinutes) : bad('humanPauseMinutes', 'not a non-negative integer'));
  if (has('autoDelaySeconds')) {
    if (isCount(ext.autoDelaySeconds)) take('autoDelay', { minSeconds: ext.autoDelaySeconds, maxSeconds: ext.autoDelaySeconds });
    else bad('autoDelaySeconds', 'not a non-negative integer');
  }
  if (has('quietHoursMode')) {
    if (typeof ext.quietHoursMode === 'string' && (QUIET_MODES[channel] as readonly string[]).includes(ext.quietHoursMode)) take('quietHoursMode', ext.quietHoursMode as QuietHoursMode);
    else bad('quietHoursMode', `not valid for ${channel}`);
  }
  if (has('instructions')) (typeof ext.instructions === 'string' ? take('instructions', ext.instructions) : bad('instructions', 'not a string'));

  const kinds = ruleConversationKinds(ext);
  if (kinds) take('conversationKinds', kinds);
  else if (has('conversationKinds')) bad('conversationKinds', 'unknown conversation kind');

  return { values, sources, warnings };
}
