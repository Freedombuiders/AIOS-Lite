/**
 * Telegram AI eligibility: hard-blocked in V1 ("disabled by design").
 *
 * Telegram's terms do not allow us to assume the data-use basis that Zalo/Email have, and the
 * plan forbids a fake consent checkbox. The answer therefore does NOT depend on any input: not on
 * `care_accounts.ai_enabled`, not on an assignment, not on a per-conversation flag, not on an
 * environment variable. Opening it later needs a new decision record and a code change here, not
 * a data change.
 *
 * Import `assertAiAllowedForChannel` (or `telegramAiAllowed`) at every AI entry point: before the
 * model call, before context expansion, for summaries / chat dock / notifications, and before an
 * auto send. Core modules (policy, agent turn) wire it; this file only owns the rule.
 */

import { CareError } from '../../../_lib/care-kit/errors.js';
import type { CareChannel } from '../../../_lib/care-kit/types.js';

export const TELEGRAM_AI_DISABLED_REASON = 'disabled_by_design_v1' as const;

export interface TelegramAiVerdict {
  readonly allowed: false;
  readonly reason: typeof TELEGRAM_AI_DISABLED_REASON;
}

/**
 * Always `{ allowed: false }`. The optional argument exists so callers can pass the account /
 * conversation they hold without special-casing; it is deliberately ignored.
 */
export function telegramAiAllowed(_context?: unknown): TelegramAiVerdict {
  return Object.freeze({ allowed: false as const, reason: TELEGRAM_AI_DISABLED_REASON });
}

export interface AiChannelVerdict {
  readonly allowed: boolean;
  readonly reason?: typeof TELEGRAM_AI_DISABLED_REASON;
}

/** Channel-level gate other modules can import. Non-Telegram channels are decided elsewhere. */
export function aiChannelGate(channel: CareChannel): AiChannelVerdict {
  if (channel === 'telegram') return telegramAiAllowed();
  return Object.freeze({ allowed: true });
}

/** Throws a coded 403 for Telegram; a no-op for other channels. */
export function assertAiAllowedForChannel(channel: CareChannel): void {
  const verdict = aiChannelGate(channel);
  if (!verdict.allowed) {
    throw new CareError('UNSUPPORTED_CAPABILITY', `AI is not available for ${channel}: ${verdict.reason}`, 403, {
      reason: verdict.reason,
    });
  }
}
