import { Loader2 } from 'lucide-preact';
import { clockTime } from '@modules/care/web/lib/care/timeFormat';
import { ct } from '@modules/care/web/lib/care/i18n';
import type { CareOutboxIntentDto } from '@modules/care/web/lib/care/dto';
import { canCancel, canReconcile, statusChip } from '@modules/care/web/lib/care/outbox';

/** Delivery status exactly as the server reported it, with the actions that status allows. */
export function OutboxChip({ intent, busy, onCancel, onReconcile }: {
  intent: CareOutboxIntentDto;
  busy?: boolean;
  onCancel?: () => void;
  onReconcile?: () => void;
}) {
  const chip = statusChip(intent);
  return (
    <span class="care-outbox" data-testid="care-outbox-chip" data-status={intent.status}>
      <span class={`care-status-chip tone-${chip.tone}`}>
        {(intent.status === 'sending' || busy) && <Loader2 size={10} class="animate-spin" aria-hidden="true" />}
        {ct(`outbox.status.${chip.labelKey}`)}
      </span>
      {intent.retryAtMs !== null && (intent.status === 'retry_wait' || intent.status === 'pending') && (
        <span class="care-faint">{ct('outbox.retryAt', { time: clockTime(intent.retryAtMs) })}</span>
      )}
      {intent.errorCode && <span class="care-faint">{ct('outbox.error', { code: intent.errorCode })}</span>}
      {onCancel && canCancel(intent) && <button type="button" class="care-link-button" disabled={busy} onClick={onCancel}>{ct('outbox.cancel')}</button>}
      {onReconcile && canReconcile(intent) && <button type="button" class="care-link-button" disabled={busy} onClick={onReconcile}>{ct('outbox.reconcile')}</button>}
    </span>
  );
}
