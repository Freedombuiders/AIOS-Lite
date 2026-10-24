import { BellOff } from 'lucide-preact';
import { useMemo } from 'preact/hooks';
import { Avatar } from './inbox/Avatar';
import { snoozeUntilText, waitText } from './inbox/format';
import { relTime } from '@modules/care/web/lib/care/timeFormat';
import { conversationTitle } from '@modules/care/web/lib/care/title';
import { ct } from '@modules/care/web/lib/care/i18n';
import { aiChip, ownerChip, unreadCount, waitMinutes, waitTone } from '@modules/care/web/lib/care/inboxView';
import { agentName, type AgentLite } from '@modules/care/web/lib/care/useInboxExtras';
import type { CareAccountDto, CareConversationDto } from '@modules/care/web/lib/care/dto';

export function ConversationRow({ conversation: c, account, agents, waitThresholdMin, nowMs, active, showAccount, onSelect }: {
  conversation: CareConversationDto;
  account: CareAccountDto | undefined;
  agents: AgentLite[];
  /** Owner's wait threshold (minutes): amber after it, red from 3x. */
  waitThresholdMin: number;
  nowMs: number;
  active: boolean;
  showAccount: boolean;
  onSelect: () => void;
}) {
  const unread = c.localUnread || c.remoteUnreadCount > 0;
  const unreadN = unreadCount(c);
  const title = conversationTitle(c.title) || ct('list.untitled');
  const paused = c.isPaused && (c.pausedUntilMs === null || c.pausedUntilMs > nowMs);
  const w = c.workflow;
  const chips = useMemo(() => {
    if (!w) return null;
    const owner = ownerChip(w);
    return { owner, ai: aiChip(w), tone: w.status === 'open' ? waitTone(c.waitingSinceMs, nowMs, waitThresholdMin) : null };
  }, [w, c.waitingSinceMs, nowMs, waitThresholdMin]);

  return (
    <button
      type="button"
      class={`care-row care-conv${active ? ' is-active' : ''}${unread ? ' is-unread' : ''}`}
      aria-current={active ? 'true' : undefined}
      data-conversation-id={c.id}
      data-status={w?.status}
      onClick={onSelect}
    >
      <Avatar id={c.id} title={title} channel={c.channel} />
      <span class="care-conv-main">
        <span class="care-row-top">
          <span class="care-row-title">{title}</span>
          <span class="care-row-time">{relTime(c.lastActivityMs)}</span>
        </span>
        <span class="care-row-top">
          {c.lastMessagePreview ? (
            <span class="care-row-preview" data-testid="care-row-preview">
              {c.lastMessagePreview.direction === 'out' ? ct('list.you') : ''}{c.lastMessagePreview.text}
            </span>
          ) : <span class="care-row-preview" />}
          {unreadN > 0 && <span class="care-unread-n" role="img" aria-label={c.remoteUnreadCount > 0 ? ct('list.remoteUnread', { n: unreadN }) : ct('list.unreadBadge')}>{unreadN}</span>}
        </span>
        <span class="care-row-meta">
          {showAccount && account && <span class="care-row-account" title={account.label}>{account.label}</span>}
          {c.kind !== 'direct' && c.kind !== 'email_thread' && <span class="care-chip">{ct(`kind.${c.kind}`)}</span>}
          {chips ? (
            <>
              {chips.tone && c.waitingSinceMs !== null && (
                <span class={`care-chip is-wait-${chips.tone}`} data-testid="care-wait-chip" data-tone={chips.tone} title={ct('list.waitingSince', { time: new Date(c.waitingSinceMs).toLocaleString('vi-VN') })}>
                  {chips.tone === 'late' ? ct('inbox2.wait.late', { wait: waitText(waitMinutes(c.waitingSinceMs, nowMs)) }) : ct('inbox2.wait.chip', { wait: waitText(waitMinutes(c.waitingSinceMs, nowMs)) })}
                </span>
              )}
              {w?.status === 'snoozed' && w.snoozedUntilMs !== null && <span class="care-chip is-snooze" data-testid="care-snooze-chip">{ct('inbox2.snooze.until', { when: snoozeUntilText(w.snoozedUntilMs, nowMs) })}</span>}
              <span class={`care-chip is-owner-${chips.owner.kind}`} data-testid="care-owner-chip">
                {chips.owner.kind === 'me' ? ct('inbox2.assignee.me') : chips.owner.kind === 'none' ? ct('inbox2.assignee.none') : ct('inbox2.owner.ai', { name: agentName(agents, chips.owner.agentId) })}
              </span>
              {chips.ai && <span class={`care-chip is-ai is-ai-${chips.ai}`} data-testid="care-ai-chip" data-ai={chips.ai}>{ct(`inbox2.aichip.${chips.ai}`)}</span>}
            </>
          ) : (
            c.waitingSinceMs !== null && <span class="care-chip is-waiting" title={ct('list.waitingSince', { time: new Date(c.waitingSinceMs).toLocaleString('vi-VN') })}>{ct('filters.waiting')}</span>
          )}
          {paused && !w && <span class="care-chip">{ct('list.paused')}</span>}
          {c.isOptedOut && <span class="care-chip is-error"><BellOff size={9} aria-hidden="true" /> {ct('list.optedOut')}</span>}
          {c.status && c.status !== 'active' && <span class="care-chip">{c.status}</span>}
        </span>
      </span>
    </button>
  );
}
