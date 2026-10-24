import { clockTime, fullTime } from '@modules/care/web/lib/care/timeFormat';
import { AttachmentList } from './AttachmentList';
import { EmailMessageBody } from './EmailMessageBody';
import { OutboxChip } from './OutboxChip';
import { ct } from '@modules/care/web/lib/care/i18n';
import type { CareApiChannel, CareMessageDto, CareOutboxIntentDto } from '@modules/care/web/lib/care/dto';
import { bubbleSide, describeMessage } from '@modules/care/web/lib/care/messageView';
import type { ZaloProfiles } from '@modules/care/web/lib/care/zaloProfiles';
import { Avatar } from './inbox/Avatar';

interface EmailMeta {
  subject?: string;
  from?: string;
  fromName?: string;
  to?: string[];
  cc?: string[];
  bodyHtml?: string;
  snippet?: string;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function Placeholder({ kind, label }: { kind: 'deleted' | 'unsupported' | 'empty'; label: string | null }) {
  const text = kind === 'deleted'
    ? ct('msg.deleted')
    : kind === 'empty'
      ? ct('msg.empty')
      : ct('msg.unsupported', { label: label === 'sticker' ? ct('msg.unsupportedSticker') : '' });
  return <div class="care-placeholder" data-testid={`care-placeholder-${kind}`}>{text}</div>;
}

export function MessageBubble({ message: m, channel, profiles, highlighted, intent, busy, onCancel, onReconcile }: {
  message: CareMessageDto;
  /** Conversation channel: only Zalo has stored media to show. */
  channel?: CareApiChannel;
  /** Zalo names + avatars of the conversation (optional: the stored sender name is the fallback). */
  profiles?: ZaloProfiles | null;
  highlighted: boolean;
  intent?: CareOutboxIntentDto;
  busy?: boolean;
  onCancel?: (id: string) => void;
  onReconcile?: (id: string) => void;
}) {
  const view = describeMessage(m);
  const side = bubbleSide(m);
  const meta = m.metadata as EmailMeta;
  // Zalo customer: their own name and avatar instead of the generic role label. The API strips the raw sender uid, so a
  // 1-1 chat takes the conversation's person and a group matches the sender by the display name the API already resolved.
  const isCustomerChat = channel === 'zalo' && m.senderRole === 'customer';
  const direct = (m.metadata as { conversationKind?: unknown }).conversationKind === 'direct';
  const personName = isCustomerChat ? (m.senderName || (direct ? profiles?.thread.name : '') || '') : '';
  const person = isCustomerChat
    ? (direct ? profiles?.thread : personName ? Object.values(profiles?.senders ?? {}).find((p) => p.name === personName) : undefined)
    : undefined;
  const showAvatar = channel === 'zalo' && side === 'incoming';
  const quote = !view.isEmail ? (m.metadata as { quote?: { text?: unknown } | null }).quote : null;

  return (
    <article
      id={`care-msg-${m.id}`}
      class={`care-msg is-${side} role-${m.senderRole}${highlighted ? ' is-hit' : ''}${view.isEmail ? ' is-email' : ''}${showAvatar ? ' has-avatar' : ''}`}
      aria-label={`${ct(`msg.role.${m.senderRole}`)}, ${fullTime(m.sentAtMs)}`}
      aria-current={highlighted ? 'true' : undefined}
      data-message-id={m.id}
      data-sender-role={m.senderRole}
    >
      {showAvatar && <Avatar id={m.senderIdentityId || m.conversationId} title={personName || ct(`msg.role.${m.senderRole}`)} channel="zalo" size={28} url={person?.avatarUrl || undefined} badge={false} />}
      <div class="care-bubble">
        <header class="care-bubble-head">
          <span class="care-sender">
            {view.isEmail && meta.fromName ? meta.fromName : personName || ct(`msg.role.${m.senderRole}`)}
          </span>
          {m.origin !== 'live' && <span class="care-faint">{m.origin}</span>}
          <time class="care-faint" dateTime={new Date(m.sentAtMs).toISOString()} title={fullTime(m.sentAtMs)}>{clockTime(m.sentAtMs)}</time>
          {highlighted && <span class="care-chip is-hit">{ct('msg.hit')}</span>}
        </header>

        {view.isEmail && (
          <dl class="care-email-head">
            <div><dt>{ct('msg.subject')}</dt><dd>{meta.subject || ct('msg.noSubject')}</dd></div>
            {meta.from && <div><dt>{ct('msg.from')}</dt><dd>{meta.from}</dd></div>}
            {strings(meta.to).length > 0 && <div><dt>{ct('msg.to')}</dt><dd>{strings(meta.to).join(', ')}</dd></div>}
            {strings(meta.cc).length > 0 && <div><dt>{ct('msg.cc')}</dt><dd>{strings(meta.cc).join(', ')}</dd></div>}
          </dl>
        )}

        {quote && typeof quote.text === 'string' && quote.text && <blockquote class="care-quote">{quote.text}</blockquote>}

        {view.placeholder && view.placeholder !== 'empty' ? (
          <Placeholder kind={view.placeholder} label={view.unsupportedLabel} />
        ) : view.isEmail ? (
          <EmailMessageBody html={typeof meta.bodyHtml === 'string' ? meta.bodyHtml : ''} text={view.text} snippet={typeof meta.snippet === 'string' ? meta.snippet : ''} />
        ) : view.text.trim() ? (
          <div class="care-text">{view.text}</div>
        ) : view.attachments.length === 0 && !view.unexportedMedia ? (
          <Placeholder kind="empty" label={null} />
        ) : null}

        <AttachmentList attachments={view.attachments} messageId={m.id} showImages={channel === 'zalo'} />
        {view.unexportedMedia && (
          <div class="care-media-note" role="note" data-testid="care-media-placeholder" data-reason={view.unexportedMedia.reason}>
            {ct('msg.telegramMedia', { kind: ct(`msg.telegramMediaKind.${view.unexportedMedia.kind}`), why: ct(`msg.telegramMediaWhy.${view.unexportedMedia.reason}`) })}
          </div>
        )}

        {intent && (
          <footer class="care-bubble-foot">
            <OutboxChip intent={intent} busy={busy} onCancel={onCancel ? () => onCancel(intent.id) : undefined} onReconcile={onReconcile ? () => onReconcile(intent.id) : undefined} />
          </footer>
        )}
      </div>
    </article>
  );
}
