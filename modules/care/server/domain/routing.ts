/**
 * Assignment and Routing Resolution for Customer Care
 * Preserves Conversation > Customer > Identity/Sender > Domain > Account > Channel > Global precedence
 * and explicit disabled deny overrides.
 */

import { CareError } from '../../../_lib/care-kit/errors.js';
import type { AssignmentScope, CareAssignment, CareChannel } from '../../../_lib/care-kit/types.js';

export interface RoutingContext {
  accountId: string;
  channel: CareChannel;
  conversationKey: string;
  customerId?: string | null;
  identityKey?: string | null;
  emailSender?: string | null;
  emailDomain?: string | null;
}

export type RoutingResolution =
  | {
      matched: true;
      active: true;
      assignment: CareAssignment;
      tier: AssignmentScope;
    }
  | {
      matched: true;
      active: false;
      reason: 'assignment_disabled';
      assignment: CareAssignment;
      tier: AssignmentScope;
    }
  | {
      matched: false;
      active: false;
      reason: 'no_assignment';
      assignment: null;
    };

/**
 * Resolve the active assignment according to canonical precedence:
 * Conversation Override > Customer Override > Identity / Email Sender > Email Domain > Account Default > Channel Default > Global Default.
 *
 * Invariant: An explicit disabled rule (enabled: false) silences the conversation and
 * NEVER falls through to a broader scope (Explicit Deny Override).
 */
export function resolveAssignmentPrecedence(
  assignments: CareAssignment[],
  context: RoutingContext,
): RoutingResolution {
  const normEmail = context.emailSender?.trim().toLowerCase();
  const normDomain =
    context.emailDomain?.trim().toLowerCase() ||
    (normEmail && normEmail.includes('@') ? normEmail.slice(normEmail.lastIndexOf('@') + 1) : null);

  // Filter assignments relevant to this account / channel
  const candidatePool = assignments.filter((a) => {
    // If assignment specifies an account, it must match current account
    if (a.accountId && a.accountId !== context.accountId) return false;
    // If assignment specifies a channel, it must match current channel
    if (a.channel && a.channel !== context.channel) return false;
    return true;
  });

  function pickBestInTier(
    matches: CareAssignment[],
    tierName: AssignmentScope,
  ): RoutingResolution | null {
    if (matches.length === 0) return null;
    if (matches.length === 1) {
      const match = matches[0];
      if (!match.enabled) {
        return { matched: true, active: false, reason: 'assignment_disabled', assignment: match, tier: tierName };
      }
      return { matched: true, active: true, assignment: match, tier: tierName };
    }

    // Sort by priority descending
    const sorted = [...matches].sort((a, b) => b.priority - a.priority);
    if (sorted[0].priority === sorted[1].priority && sorted[0].id !== sorted[1].id) {
      throw new CareError(
        'CONFIGURATION_CONFLICT',
        `Conflicting assignments at tier '${tierName}' with equal priority ${sorted[0].priority}`,
        400,
        { assignmentA: sorted[0].id, assignmentB: sorted[1].id },
      );
    }

    const winner = sorted[0];
    if (!winner.enabled) {
      return { matched: true, active: false, reason: 'assignment_disabled', assignment: winner, tier: tierName };
    }
    return { matched: true, active: true, assignment: winner, tier: tierName };
  }

  // Tier 1: Conversation override
  const conversationMatches = candidatePool.filter(
    (a) => a.scope === 'conversation' && a.scopeTarget === context.conversationKey,
  );
  const tier1 = pickBestInTier(conversationMatches, 'conversation');
  if (tier1) return tier1;

  // Tier 2: Customer override
  if (context.customerId) {
    const customerMatches = candidatePool.filter(
      (a) => a.scope === 'customer' && (a.customerId === context.customerId || a.scopeTarget === context.customerId),
    );
    const tier2 = pickBestInTier(customerMatches, 'customer');
    if (tier2) return tier2;
  }

  // Tier 3: Identity or Email sender (exact address match)
  const identityMatches = candidatePool.filter((a) => {
    if (a.scope !== 'identity') return false;
    if (context.identityKey && a.scopeTarget === context.identityKey) return true;
    if (normEmail && a.scopeTarget?.trim().toLowerCase() === normEmail) return true;
    return false;
  });
  const tier3 = pickBestInTier(identityMatches, 'identity');
  if (tier3) return tier3;

  // Tier 4: Email domain
  if (normDomain) {
    const domainMatches = candidatePool.filter(
      (a) => a.scope === 'domain' && a.scopeTarget?.trim().toLowerCase() === normDomain,
    );
    const tier4 = pickBestInTier(domainMatches, 'domain');
    if (tier4) return tier4;
  }

  // Tier 5: Account default
  const accountMatches = candidatePool.filter((a) => a.scope === 'account');
  const tier5 = pickBestInTier(accountMatches, 'account');
  if (tier5) return tier5;

  // Tier 6: Channel default
  const channelMatches = candidatePool.filter((a) => a.scope === 'channel' && a.channel === context.channel);
  const tier6 = pickBestInTier(channelMatches, 'channel');
  if (tier6) return tier6;

  // Tier 7: Global default
  const globalMatches = candidatePool.filter((a) => a.scope === 'global');
  const tier7 = pickBestInTier(globalMatches, 'global');
  if (tier7) return tier7;

  return { matched: false, active: false, reason: 'no_assignment', assignment: null };
}
