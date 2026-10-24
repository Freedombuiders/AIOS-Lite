import { cc } from '@modules/care/web/lib/care-channels/i18n';
import type { RuleChannel } from '@modules/care/web/lib/care-channels/rules';

/** Small channel tag of the rules table (the mockup calls the email channel "Gmail"). */
export function ChannelTag({ channel }: { channel: RuleChannel | 'email' }) {
  if (!channel) return null;
  return <span class={`cch-tag is-${channel}`}>{cc(`channel.${channel}`)}</span>;
}
