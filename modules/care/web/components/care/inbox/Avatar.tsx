import { useEffect, useState } from 'preact/hooks';
import { avatarHue, initialsOf } from '@modules/care/web/lib/care/inboxView';
import { ct } from '@modules/care/web/lib/care/i18n';
import type { CareApiChannel } from '@modules/care/web/lib/care/dto';

const LETTER: Record<CareApiChannel, string> = { zalo: 'Z', email: '@', telegram: 'T' };

/** Initials on a tint that is stable per conversation, with the channel as a small badge on the corner. */
export function Avatar({ id, title, channel, size = 36, url, badge = true }: { id: string; title: string; channel: CareApiChannel; size?: number; url?: string; badge?: boolean }) {
  const hue = avatarHue(id);
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [url]);
  const photo = Boolean(url) && !broken;
  return (
    <span class="care-av" style={`width:${size}px;height:${size}px;--av-hue:${hue}`} aria-hidden="true">
      {photo
        ? <img class="care-av-img" src={url} alt="" loading="lazy" referrerpolicy="no-referrer" onError={() => setBroken(true)} />
        : <span class="care-av-initials" style={`font-size:${Math.round(size * 0.32)}px`}>{initialsOf(title)}</span>}
      {badge && <span class={`care-av-badge care-badge-${channel}`} title={ct(`channel.${channel}`)}>{LETTER[channel]}</span>}
    </span>
  );
}
