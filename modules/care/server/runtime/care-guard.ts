/**
 * DispatchGuard for the Care outbox dispatcher (CC-11 port), built on the ONE dispatch gate (gates.ts) plus the
 * mandatory data-eligibility rules of the policy package. Runs immediately before the connector RPC for every
 * actor; a throw is treated by the dispatcher as a deferral (fail closed).
 *
 * Mapping to the dispatcher's three outcomes:
 *   defer  - a switch, flag, ownership change or cooldown that can heal: stays pending, re-checked later;
 *   review - the intent can no longer be trusted as written (backlog held, stale epoch, lost lock): a human decides;
 *   cancel - never send (opt-out, a person answered first).
 */
import type Database from 'better-sqlite3';
import type { CareAccountRecord } from '../../../_lib/care-kit/types.js';
import type { DispatchGuard, DispatchGuardContext, DispatchGuardDecision } from '../application/dispatch.js';
import { createSqliteConversationReader, type ConversationReader } from '../application/agent-context.js';
import type { CareStores } from '../persistence/index.js';
import type { OwnershipLock } from '../persistence/ownership-store.js';
import { evaluateEligibility, type CarePolicyActor, type KillSwitchState } from '../policy/eligibility.js';
import { evaluateDispatchGate, type DispatchDenyCode } from './gates.js';

export const OUTBOX_BACKLOG_KIND = 'outbox_intent';

const GATE_REVIEW: ReadonlySet<DispatchDenyCode> = new Set(['BACKLOG_HELD', 'STALE_EPOCH', 'EPOCH_REQUIRED', 'LOCK_LOST', 'ACCOUNT_NOT_FOUND', 'INVALID_SOURCE']);

const ELIGIBILITY_CANCEL: ReadonlySet<string> = new Set(['opted_out', 'human_active', 'stale_context']);
const ELIGIBILITY_REVIEW: ReadonlySet<string> = new Set(['marketing_consent_missing', 'telegram_ai_blocked', 'write_owner_not_core']);

function policyActor(intent: DispatchGuardContext['intent']): CarePolicyActor {
  if (intent.purpose === 'campaign') return 'marketing';
  return intent.actor === 'auto' ? 'auto_care_reply' : intent.actor === 'approved' ? 'approved_care_draft' : 'manual_care_reply';
}

export interface CareGuardDeps {
  db: Database.Database;
  stores: CareStores;
  /** Layered policy switches (module / ai / auto-send; channel and account overrides). */
  killSwitches: () => KillSwitchState;
  /** The holder lock this process holds for the account, if any (the dispatcher may also run outside the worker). */
  lockFor?: (accountId: string) => OwnershipLock | undefined;
  reader?: ConversationReader;
  cooldownUntilMs?: (account: CareAccountRecord) => number | null;
}

export function createCareDispatchGuard(deps: CareGuardDeps): DispatchGuard {
  const reader = deps.reader ?? createSqliteConversationReader(deps.db, deps.stores);
  return {
    evaluate(ctx: DispatchGuardContext): DispatchGuardDecision {
      const { intent, account, conversation, nowMs } = ctx;
      const gate = evaluateDispatchGate(deps.db, account.id, ctx.command.ownerEpoch, 'core', 'job', {
        operation: 'send',
        actorType: intent.actor,
        item: { kind: OUTBOX_BACKLOG_KIND, id: intent.id },
        lock: deps.lockFor?.(account.id),
        nowMs,
      });
      if (!gate.allow) {
        return { allow: false, action: GATE_REVIEW.has(gate.code) ? 'review' : 'defer', reason: `gate:${gate.code}` };
      }

      const actor = policyActor(intent);
      const lastHuman = conversation ? reader.lastHumanReplyAtMs(conversation.id) : null;
      const cooldown = deps.cooldownUntilMs?.(account) ?? null;
      const verdict = evaluateEligibility({
        nowMs,
        actor,
        step: 'send',
        channel: account.channel,
        account,
        conversation: {
          kind: conversation?.kind ?? (account.channel === 'email' ? 'email_thread' : 'direct'),
          isPaused: conversation?.isPaused ?? false,
          pausedUntilMs: conversation?.pausedUntilMs ?? null,
          isOptedOut: conversation?.isOptedOut ?? false,
        },
        killSwitches: deps.killSwitches(),
        ...(account.channel === 'telegram' ? { telegramBotAi: { allowed: false } } : {}),
        // an automatic reply must not go out over a person who answered after the draft was created
        lastHumanReplyAtMs: lastHuman,
        humanRepliedSinceMs: actor === 'auto_care_reply' ? intent.createdAtMs : null,
        cooldownUntilMs: cooldown,
      });
      if (verdict.eligible) return { allow: true };
      const reason = `eligibility:${verdict.reason}`;
      if (ELIGIBILITY_CANCEL.has(verdict.reason)) return { allow: false, action: 'cancel', reason };
      if (ELIGIBILITY_REVIEW.has(verdict.reason)) return { allow: false, action: 'review', reason };
      return { allow: false, action: 'defer', reason, ...(verdict.reason === 'cooldown_active' && cooldown ? { retryAtMs: cooldown } : {}) };
    },
  };
}
