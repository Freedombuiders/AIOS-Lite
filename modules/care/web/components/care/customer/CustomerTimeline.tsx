import { CornerUpLeft, Loader2 } from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import { ChannelBadge } from '../ChannelBadge';
import { PageState } from '@/components/PageState';
import { careApi } from '@modules/care/web/lib/care/client';
import type { CareTimelineItemDto } from '@modules/care/server/api/dto-ops';
import { toCareFailure } from '@modules/care/web/lib/care/failure';
import { ct } from '@modules/care/web/lib/care/i18n';

/** Every conversation of the customer in one stream. Replying opens the ORIGINAL conversation, never another channel. */
export function CustomerTimeline({ customerId, onOpen }: { customerId: string; onOpen: (conversationId: string, messageId: string) => void }) {
  const [items, setItems] = useState<CareTimelineItemDto[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true); setError(null); setItems([]); setNext(null);
    careApi.timeline(customerId)
      .then((p) => { if (live) { setItems(p.items); setNext(p.nextCursor); } })
      .catch((e) => { if (live) setError(toCareFailure(e).message); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [customerId]);

  async function loadMore(): Promise<void> {
    if (!next || more) return;
    setMore(true);
    try {
      const p = await careApi.timeline(customerId, next);
      setItems((cur) => [...cur, ...p.items.filter((i) => !cur.some((c) => c.messageId === i.messageId))]);
      setNext(p.nextCursor);
    } catch (e) {
      setError(toCareFailure(e).message);
    } finally {
      setMore(false);
    }
  }

  if (loading) return <PageState loading />;
  if (error && items.length === 0) return <PageState error={error} />;
  if (items.length === 0) return <p class="care-note">{ct('customer.timelineEmpty')}</p>;
  return (
    <div class="care-cust-timeline" data-testid="care-customer-timeline">
      <ul>
        {items.map((i) => (
          <li key={i.messageId} class={`care-tl-item is-${i.direction}`} data-testid="care-timeline-item" data-conversation-id={i.replyTarget.conversationId}>
            <div class="care-tl-head">
              <ChannelBadge channel={i.channel} />
              <span class="care-sender">{ct(`msg.role.${i.senderRole}`)}</span>
              <time class="care-faint" dateTime={new Date(i.sentAtMs).toISOString()}>{new Date(i.sentAtMs).toLocaleString('vi-VN')}</time>
            </div>
            <p class="care-tl-text">{i.text || ct('msg.unsupported', { label: '' })}</p>
            <button type="button" class="care-link-button" onClick={() => onOpen(i.replyTarget.conversationId, i.messageId)}>
              <CornerUpLeft size={11} aria-hidden="true" /> {ct('customer.openOriginal')}
            </button>
          </li>
        ))}
      </ul>
      {next && (
        <div class="care-center">
          <button type="button" class="cc-button" disabled={more} onClick={() => void loadMore()}>{more && <Loader2 size={12} class="animate-spin" aria-hidden="true" />} {ct('list.loadMore')}</button>
        </div>
      )}
    </div>
  );
}
