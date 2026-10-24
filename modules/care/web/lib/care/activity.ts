// Activity feed presentation: skip reasons and delivery states are shown with a plain label, never a
// raw reason code alone and never any text the read gate hides (the feed carries codes only).

import type { CareActivityItemDto } from '@modules/care/server/api/dto-ops';

/** Reason codes with their own i18n label (`activity.reason.<code>`); anything else shows the code. */
export const KNOWN_REASONS: ReadonlySet<string> = new Set([
  'telegram_ai_blocked', 'kill_switch_module', 'kill_switch_ai', 'kill_switch_auto_send', 'account_inactive', 'write_owner_not_core',
  'account_ai_disabled', 'account_sync_disabled', 'account_send_disabled', 'account_unhealthy', 'context_source_not_permitted',
  'no_assignment', 'assignment_disabled', 'observe_only', 'not_inbound', 'not_live_origin', 'not_customer_message', 'trigger_deleted',
  'unsupported_type', 'not_directed', 'opted_out', 'noise', 'empty_body', 'internal_sender', 'own_address', 'automated',
  'category_not_primary', 'before_care_since', 'stale_trigger', 'conversation_paused', 'human_active', 'stale_context', 'thread_quota',
  'agent_quota', 'account_quota', 'cooldown_active', 'quiet_hours', 'marketing_consent_missing',
]);

const SAFE_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

export function reasonCode(code: string | null | undefined): string | null {
  return code && SAFE_CODE.test(code) ? code : null;
}

export type ActivityTone = 'done' | 'queued' | 'failed' | 'neutral';

export function activityTone(item: CareActivityItemDto): ActivityTone {
  if (item.kind === 'run') return item.status === 'drafted' ? 'done' : item.status === 'failed' ? 'failed' : item.status === 'running' ? 'queued' : 'neutral';
  if (item.status === 'sent') return 'done';
  if (item.status === 'failed' || item.status === 'uncertain' || item.status === 'needs_review') return 'failed';
  if (item.status === 'pending' || item.status === 'sending' || item.status === 'retry_wait' || item.status === 'draft') return 'queued';
  return 'neutral';
}

/** Dedupes by kind+id and keeps the server order (newest first) when pages overlap. */
export function appendActivity(cur: CareActivityItemDto[], next: CareActivityItemDto[]): CareActivityItemDto[] {
  const seen = new Set(cur.map((i) => `${i.kind}:${i.id}`));
  return [...cur, ...next.filter((i) => !seen.has(`${i.kind}:${i.id}`))];
}
