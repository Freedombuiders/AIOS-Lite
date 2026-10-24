/**
 * Applies the side effects an agent turn deliberately does not perform itself. The turn reports
 * them in `outcome.effects`; the worker that consumed the job calls this once per outcome.
 */

import type { CareStores } from '../persistence/index.js';
import type { AgentTurnEffect } from './agent-turn.js';

export function applyAgentTurnEffects(
  stores: Pick<CareStores, 'conversations'>,
  conversationId: string,
  effects: readonly AgentTurnEffect[],
): void {
  for (const effect of effects) {
    // Idempotent: setOptedOut leaves the revision alone when the flag already holds.
    if (effect === 'mark_opted_out') stores.conversations.setOptedOut(conversationId, true);
  }
}
