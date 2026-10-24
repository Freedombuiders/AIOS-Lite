import { useEffect, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { apiFetch } from '@/lib/api';
import { ct } from '@modules/care/web/lib/care/i18n';

/** Stored copy of image `index` of a message. 404 when it is not an image or no copy can be made. */
export function mediaPath(messageId: string, index: number): string {
  return `/api/m/care/messages/${encodeURIComponent(messageId)}/media?i=${index}`;
}

/**
 * A chat image from the copy the care module keeps (never the provider's expiring link). It is fetched with the API
 * token in a header, so the token never ends up in an <img> URL; without a copy the caller's metadata chip is shown.
 */
export function MediaImage({ messageId, index, name, fallback }: { messageId: string; index: number; name: string; fallback: ComponentChildren }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    let url: string | null = null;
    setSrc(null);
    setFailed(false);
    apiFetch(mediaPath(messageId, index))
      .then(async (res) => {
        if (!res.ok) throw new Error(`media ${res.status}`);
        const blob = await res.blob();
        if (!live) return;
        url = URL.createObjectURL(blob);
        setSrc(url);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [messageId, index]);

  if (failed) return <>{fallback}</>;
  const label = name || ct('msg.attachment.image');
  if (!src) return <div class="care-media-loading" data-testid="care-media-loading" role="img" aria-label={label} aria-busy="true" />;
  return (
    <figure class="care-media" data-testid="care-media">
      <a href={src} target="_blank" rel="noopener noreferrer" aria-label={ct('inbox2.media.open', { name: label })}>
        <img src={src} alt={label} decoding="async" onError={() => setFailed(true)} />
      </a>
    </figure>
  );
}
