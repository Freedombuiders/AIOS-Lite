import { CloudOff, Loader2, RefreshCw, ShieldOff, WifiOff, X } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { ct } from '@modules/care/web/lib/care/i18n';
import type { StreamState } from '@modules/care/web/lib/care/stream';

/** "Reloaded after losing sync" note: stays until dismissed, whatever the connection does next. */
function ResyncNote({ stream }: { stream: StreamState }) {
  const [dismissed, setDismissed] = useState(0);
  if (!stream.resyncReason || stream.resyncTick <= dismissed) return null;
  return (
    <div class="care-banner is-info" role="status" data-testid="care-resync-note">
      <RefreshCw size={13} aria-hidden="true" />
      <span>{ct('stream.resynced', { reason: ct(`stream.reason.${stream.resyncReason}`) })}</span>
      <button type="button" class="care-link-button" aria-label={ct('stream.dismiss')} onClick={() => setDismissed(stream.resyncTick)}><X size={11} aria-hidden="true" /></button>
    </div>
  );
}

/** Slow / disconnected / disabled stream state. Renders nothing while the stream is healthy. */
export function ConnectionBanner({ stream, onRetry }: { stream: StreamState; onRetry: () => void }) {
  return (
    <>
      <ResyncNote stream={stream} />
      <ConnectionState stream={stream} onRetry={onRetry} />
    </>
  );
}

function ConnectionState({ stream, onRetry }: { stream: StreamState; onRetry: () => void }) {
  const { conn } = stream;
  if (conn === 'live') return null;
  if (conn === 'connecting') {
    return (
      <div class="care-banner is-info" role="status" data-testid="care-stream-connecting">
        <Loader2 size={13} class="animate-spin" aria-hidden="true" />
        <span>{ct('stream.connecting')}</span>
      </div>
    );
  }
  if (conn === 'reconnecting') {
    return (
      <div class="care-banner is-warn" role="status" data-testid="care-stream-slow">
        <CloudOff size={13} aria-hidden="true" />
        <span>{ct('stream.reconnecting')}</span>
      </div>
    );
  }
  if (conn === 'disabled') {
    return (
      <div class="care-banner is-error" role="alert" data-testid="care-stream-disabled">
        <ShieldOff size={13} aria-hidden="true" />
        <span>{ct('stream.disabled')}</span>
      </div>
    );
  }
  return (
    <div class="care-banner is-error" role="alert" data-testid="care-stream-offline">
      <WifiOff size={13} aria-hidden="true" />
      <span>{ct('stream.offline')}</span>
      <button type="button" class="care-link-button" onClick={onRetry}>{ct('stream.retry')}</button>
    </div>
  );
}
