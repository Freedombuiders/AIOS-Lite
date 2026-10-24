// Delivery status presentation. A chip only ever says what the server reported: `sent` means the
// provider accepted it (receipt level adds delivered/read when the channel proves it), nothing is
// inferred locally.

import type { CareDeliveryStatusDto, CareOutboxIntentDto } from './dto';

export type ChipTone = 'neutral' | 'running' | 'done' | 'failed' | 'queued' | 'cancelled';

export interface StatusChip {
  /** i18n key suffix under care.outbox.status.* */
  labelKey: string;
  tone: ChipTone;
}

const CHIPS: Record<CareDeliveryStatusDto, StatusChip> = {
  draft: { labelKey: 'draft', tone: 'neutral' },
  pending: { labelKey: 'pending', tone: 'queued' },
  sending: { labelKey: 'sending', tone: 'running' },
  sent: { labelKey: 'sent', tone: 'done' },
  retry_wait: { labelKey: 'retryWait', tone: 'queued' },
  uncertain: { labelKey: 'uncertain', tone: 'failed' },
  needs_review: { labelKey: 'needsReview', tone: 'failed' },
  failed: { labelKey: 'failed', tone: 'failed' },
  cancelled: { labelKey: 'cancelled', tone: 'cancelled' },
  discarded: { labelKey: 'discarded', tone: 'cancelled' },
};

export function statusChip(i: Pick<CareOutboxIntentDto, 'status' | 'receiptLevel'>): StatusChip {
  const base = CHIPS[i.status] ?? { labelKey: 'unknown', tone: 'neutral' as ChipTone };
  if (i.status === 'sent' && i.receiptLevel === 'delivered') return { labelKey: 'delivered', tone: 'done' };
  if (i.status === 'sent' && i.receiptLevel === 'read') return { labelKey: 'read', tone: 'done' };
  return base;
}

/** No further change without a person acting: terminal states, plus needs_review (waiting for an operator). */
export const TERMINAL: ReadonlySet<CareDeliveryStatusDto> = new Set(['sent', 'failed', 'cancelled', 'discarded', 'needs_review']);

/** Intents worth polling: everything that can still change without user action. */
export function isSettled(i: Pick<CareOutboxIntentDto, 'status'>): boolean {
  return TERMINAL.has(i.status);
}

export function canCancel(i: Pick<CareOutboxIntentDto, 'status'>): boolean {
  return i.status === 'draft' || i.status === 'pending' || i.status === 'retry_wait';
}

export function canReconcile(i: Pick<CareOutboxIntentDto, 'status'>): boolean {
  return i.status === 'uncertain';
}

/** Keeps the newest copy of each intent (by updatedAtMs) so a slow poll cannot roll a status back. */
export function upsertIntent(list: CareOutboxIntentDto[], next: CareOutboxIntentDto): CareOutboxIntentDto[] {
  const cur = list.find((i) => i.id === next.id);
  if (cur && cur.updatedAtMs > next.updatedAtMs) return list;
  const rest = list.filter((i) => i.id !== next.id);
  return [...rest, next].sort((a, b) => a.createdAtMs - b.createdAtMs);
}
