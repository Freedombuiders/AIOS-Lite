import { CircleAlert, Info, TriangleAlert, Ban } from 'lucide-preact';
import { ct } from '@modules/care/web/lib/care/i18n';
import type { Notice } from '@modules/care/web/lib/care/useReply';

export function ComposerNotice({ notice }: { notice: Notice | null }) {
  if (!notice) return null;
  const Icon = notice.tone === 'error' ? CircleAlert : notice.tone === 'warn' ? TriangleAlert : Info;
  return (
    <div class={`care-banner is-${notice.tone === 'info' ? 'info' : notice.tone === 'warn' ? 'warn' : 'error'}`} role={notice.tone === 'error' ? 'alert' : 'status'} data-testid="care-composer-notice">
      <Icon size={13} aria-hidden="true" />
      <span>{notice.text}</span>
    </div>
  );
}

/** Sending is not wired on the server (reply routes answer 501): a clear state, not an error. */
export function SendUnavailable({ none }: { conversationId?: string; /** The account has no delivery path at all (`delivery.replyVia === 'none'`), as opposed to the server not being ready. */ none?: boolean }) {
  return (
    <div class="care-banner is-warn care-unavailable" role="status" data-testid="care-send-unavailable">
      <Ban size={14} aria-hidden="true" />
      <span><strong>{ct('composer.unavailableTitle')}.</strong> {none ? ct('inbox2.unavailable.none') : ct('composer.unavailableBody')}</span>
    </div>
  );
}
