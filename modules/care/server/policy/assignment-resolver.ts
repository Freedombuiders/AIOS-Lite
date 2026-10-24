/**
 * Effective assignment rule for a conversation.
 *
 * Precedence (first tier with a candidate decides; nothing falls through from a decided tier):
 *   conversation -> customer -> identity (chat identity / exact email sender) -> domain (email)
 *   -> account -> channel -> global
 *
 * Inside a tier:
 *   1. kind-restricted rules (a legacy Zalo `account_dms` / `account_groups` default, or an
 *      explicit `conversationKinds`) are more specific than unrestricted ones and are
 *      considered first;
 *   2. the highest explicit `priority` wins;
 *   3. two rules at the top priority are a CONFIGURATION_CONFLICT (never an implicit pick).
 *
 * An explicit disabled rule that wins its tier is a DENY override: the conversation is silenced
 * and a broader enabled rule does NOT take over ("turning one thread off is deliberate").
 *
 * `previewEffectiveRule` runs the same walk but reports conflicts instead of throwing, so the
 * rules UI can explain a configuration before it is live.
 */

import { CareError } from '../../../_lib/care-kit/errors.js';
import type { AssignmentMode, AssignmentScope, CareAssignment, CareChannel, CareConversationKind } from '../../../_lib/care-kit/types.js';
import { resolvePolicy, ruleConversationKinds, type ResolvedPolicy } from './policy-ext.js';

export interface RuleResolveContext {
  accountId: string;
  channel: CareChannel;
  /** External conversation key (thread / group / email thread id). */
  conversationKey: string;
  conversationKind?: CareConversationKind | null;
  customerId?: string | null;
  /** Sender identity key (chat user id or email address). */
  identityKey?: string | null;
  /** Email sender address when the channel is email. */
  emailSender?: string | null;
  emailDomain?: string | null;
}

export interface EffectiveRule {
  assignmentId: string;
  tier: AssignmentScope;
  /** True when the rule won through a conversation-kind predicate (e.g. all 1-1 chats). */
  viaKindPredicate: boolean;
  enabled: boolean;
  mode: AssignmentMode;
  agentId: string;
  priority: number;
  configVersion: number;
  instructionsRef: string | null;
  /** Stable id of exactly this rule version; stored on every agent run. */
  policyRevision: string;
  policy: ResolvedPolicy;
}

export type EffectiveRuleResolution =
  | { status: 'active'; rule: EffectiveRule }
  | { status: 'denied'; reason: 'assignment_disabled'; rule: EffectiveRule }
  | { status: 'none'; reason: 'no_assignment' };

const TIER_ORDER: readonly AssignmentScope[] = ['conversation', 'customer', 'identity', 'domain', 'account', 'channel', 'global'];

export function policyRevisionOf(a: Pick<CareAssignment, 'id' | 'configVersion'>): string {
  return `${a.id}@${a.configVersion}`;
}

function normAddr(v: string | null | undefined): string | null {
  const t = v?.trim().toLowerCase();
  return t ? t : null;
}

function domainOf(ctx: RuleResolveContext): string | null {
  const explicit = normAddr(ctx.emailDomain);
  if (explicit) return explicit;
  const sender = normAddr(ctx.emailSender);
  return sender && sender.includes('@') ? sender.slice(sender.lastIndexOf('@') + 1) : null;
}

/** Does the assignment's account/channel gate admit this conversation at all? */
function inPool(a: CareAssignment, ctx: RuleResolveContext): boolean {
  if (a.accountId && a.accountId !== ctx.accountId) return false;
  if (a.channel && a.channel !== ctx.channel) return false;
  return true;
}

function matchesTier(a: CareAssignment, tier: AssignmentScope, ctx: RuleResolveContext): boolean {
  if (a.scope !== tier) return false;
  switch (tier) {
    case 'conversation':
      return a.scopeTarget === ctx.conversationKey;
    case 'customer':
      return Boolean(ctx.customerId) && (a.customerId === ctx.customerId || a.scopeTarget === ctx.customerId);
    case 'identity': {
      const target = a.scopeTarget ?? null;
      if (!target) return false;
      if (ctx.identityKey && target === ctx.identityKey) return true;
      // Email addresses compare case-insensitively; chat identity keys stay exact.
      const sender = ctx.channel === 'email' ? normAddr(ctx.emailSender ?? ctx.identityKey) : null;
      return sender !== null && normAddr(target) === sender;
    }
    case 'domain': {
      // Exact domain only: a rule for example.com does not cover sub.example.com.
      const domain = ctx.channel === 'email' ? domainOf(ctx) : null;
      return domain !== null && normAddr(a.scopeTarget) === domain;
    }
    case 'account':
      return a.accountId === ctx.accountId;
    case 'channel':
      return a.channel === ctx.channel;
    case 'global':
      return true;
  }
}

function kindAllows(a: CareAssignment, ctx: RuleResolveContext): { ok: boolean; restricted: boolean } {
  const kinds = ruleConversationKinds(a.policyExt);
  if (!kinds) return { ok: true, restricted: false };
  // Without a known conversation kind a restricted rule cannot be proven to apply.
  return { ok: Boolean(ctx.conversationKind) && kinds.includes(ctx.conversationKind!), restricted: true };
}

export interface TierCandidate {
  assignmentId: string;
  priority: number;
  enabled: boolean;
  viaKindPredicate: boolean;
}

export interface TierTrace {
  tier: AssignmentScope;
  candidates: TierCandidate[];
  /** Winner of this tier, absent when the tier has no candidate or the tie is unresolved. */
  selectedId?: string;
  conflict?: { priority: number; assignmentIds: string[] };
}

type Walk =
  | { outcome: 'decided'; assignment: CareAssignment; tier: AssignmentScope; viaKind: boolean; trace: TierTrace[] }
  | { outcome: 'conflict'; tier: AssignmentScope; priority: number; assignmentIds: string[]; trace: TierTrace[] }
  | { outcome: 'none'; trace: TierTrace[] };

function walk(assignments: readonly CareAssignment[], ctx: RuleResolveContext): Walk {
  const pool = assignments.filter((a) => inPool(a, ctx));
  const trace: TierTrace[] = [];
  for (const tier of TIER_ORDER) {
    const matches: Array<{ a: CareAssignment; restricted: boolean }> = [];
    for (const a of pool) {
      if (!matchesTier(a, tier, ctx)) continue;
      const kind = kindAllows(a, ctx);
      if (kind.ok) matches.push({ a, restricted: kind.restricted });
    }
    const entry: TierTrace = {
      tier,
      candidates: matches.map(({ a, restricted }) => ({
        assignmentId: a.id,
        priority: a.priority,
        enabled: a.enabled,
        viaKindPredicate: restricted,
      })),
    };
    trace.push(entry);
    if (matches.length === 0) continue;

    // Kind-restricted rules are the more specific subtier: they decide before unrestricted ones.
    const restricted = matches.filter((m) => m.restricted);
    const subtier = restricted.length > 0 ? restricted : matches;
    const top = Math.max(...subtier.map((m) => m.a.priority));
    const winners = subtier.filter((m) => m.a.priority === top);
    if (winners.length > 1) {
      const ids = winners.map((w) => w.a.id).sort();
      entry.conflict = { priority: top, assignmentIds: ids };
      return { outcome: 'conflict', tier, priority: top, assignmentIds: ids, trace };
    }
    entry.selectedId = winners[0].a.id;
    return { outcome: 'decided', assignment: winners[0].a, tier, viaKind: winners[0].restricted, trace };
  }
  return { outcome: 'none', trace };
}

function toEffectiveRule(a: CareAssignment, tier: AssignmentScope, viaKind: boolean, channel: CareChannel): EffectiveRule {
  return {
    assignmentId: a.id,
    tier,
    viaKindPredicate: viaKind,
    enabled: a.enabled,
    mode: a.mode,
    agentId: a.agentId,
    priority: a.priority,
    configVersion: a.configVersion,
    instructionsRef: a.instructionsRef ?? null,
    policyRevision: policyRevisionOf(a),
    policy: resolvePolicy(a, channel),
  };
}

export function conflictError(tier: AssignmentScope, priority: number, assignmentIds: string[]): CareError {
  return new CareError(
    'CONFIGURATION_CONFLICT',
    `Conflicting assignments at tier '${tier}' with equal priority ${priority}`,
    400,
    { tier, priority, assignmentIds },
  );
}

/**
 * Throws CareError('CONFIGURATION_CONFLICT') when two rules tie at the top priority of the
 * deciding tier. A disabled winner is returned as `denied`, never skipped.
 */
export function resolveEffectiveRule(assignments: readonly CareAssignment[], ctx: RuleResolveContext): EffectiveRuleResolution {
  const w = walk(assignments, ctx);
  if (w.outcome === 'conflict') throw conflictError(w.tier, w.priority, w.assignmentIds);
  if (w.outcome === 'none') return { status: 'none', reason: 'no_assignment' };
  const rule = toEffectiveRule(w.assignment, w.tier, w.viaKind, ctx.channel);
  return w.assignment.enabled
    ? { status: 'active', rule }
    : { status: 'denied', reason: 'assignment_disabled', rule };
}

export interface EffectiveRulePreview {
  outcome: 'active' | 'denied' | 'none' | 'conflict';
  rule?: EffectiveRule;
  conflict?: { tier: AssignmentScope; priority: number; assignmentIds: string[] };
  /** Every tier that was examined, in order, with its candidates. */
  trace: TierTrace[];
  warnings: string[];
}

/** Same walk as `resolveEffectiveRule` but never throws: a conflict is reported in the result. */
export function previewEffectiveRule(assignments: readonly CareAssignment[], ctx: RuleResolveContext): EffectiveRulePreview {
  const w = walk(assignments, ctx);
  if (w.outcome === 'conflict') {
    return { outcome: 'conflict', conflict: { tier: w.tier, priority: w.priority, assignmentIds: w.assignmentIds }, trace: w.trace, warnings: [] };
  }
  if (w.outcome === 'none') return { outcome: 'none', trace: w.trace, warnings: [] };
  const rule = toEffectiveRule(w.assignment, w.tier, w.viaKind, ctx.channel);
  return { outcome: w.assignment.enabled ? 'active' : 'denied', rule, trace: w.trace, warnings: rule.policy.warnings };
}
