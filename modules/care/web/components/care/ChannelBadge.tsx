import { Mail, MessageCircle } from 'lucide-preact';
import { ZaloIcon } from '@/components/BrandIcons';
import { ct } from '@modules/care/web/lib/care/i18n';
import type { CareApiChannel } from '@modules/care/web/lib/care/dto';

function ChannelIcon({ channel, size = 11 }: { channel: CareApiChannel; size?: number }) {
  if (channel === 'zalo') return <ZaloIcon size={size} />;
  if (channel !== 'email') return <MessageCircle size={size} aria-hidden="true" />;
  return <Mail size={size} aria-hidden="true" />;
}

/** Channel + (optional) account label. */
export function ChannelBadge({ channel, account }: { channel: CareApiChannel; account?: string }) {
  return (
    <span class={`care-channel care-channel-${channel}`} title={account ? `${ct(`channel.${channel}`)} · ${account}` : ct(`channel.${channel}`)}>
      <ChannelIcon channel={channel} />
      <span>{ct(`channel.${channel}`)}</span>
      {account && <span class="care-channel-account">{account}</span>}
    </span>
  );
}
