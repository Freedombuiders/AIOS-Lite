import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { tokenizedSseUrl } from '@/lib/api';
import { ct } from '@modules/care/web/lib/care/i18n';

/** URL of a stored inbound image (Zalo). 404 when the file was never cached or is not an image. */
export function mediaUrl(messageId: string, index: number): string {
  return tokenizedSseUrl(`/api/m/care/messages/${encodeURIComponent(messageId)}/media?i=${index}`);
}

/** The image saved in FreedomOS; when it cannot be loaded the caller's metadata chip is shown instead. */
export function MediaImage({ messageId, index, name, fallback }: { messageId: string; index: number; name: string; fallback: ComponentChildren }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <>{fallback}</>;
  const src = mediaUrl(messageId, index);
  return (
    <figure class="care-media" data-testid="care-media">
      <a href={src} target="_blank" rel="noopener noreferrer" aria-label={ct('inbox2.media.open', { name: name || ct('msg.attachment.unnamed') })}>
        <img src={src} alt={name || ct('msg.attachment.image')} loading="lazy" onError={() => setFailed(true)} />
      </a>
      <figcaption class="care-faint">{name || ct('msg.attachment.image')} · {ct('inbox2.media.saved')}</figcaption>
    </figure>
  );
}
