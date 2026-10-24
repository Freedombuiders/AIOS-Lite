import { Bell, BellOff, Volume2, VolumeX } from 'lucide-preact';
import { ct } from '@modules/care/web/lib/care/i18n';
import type { AlertSettings } from '@modules/care/web/lib/care/browserAlerts';

/** Per-browser switches: a beep and a desktop notification for new customer messages. */
export function AlertToggles({ settings, permission, onSound, onNotify }: {
  settings: AlertSettings;
  permission: NotificationPermission | 'unsupported';
  onSound: () => void;
  onNotify: () => void;
}) {
  const notifyOn = settings.notify && permission === 'granted';
  return (
    <span class="care-alert-toggles" role="group" aria-label={ct('inbox2.alerts.group')}>
      <button type="button" class={`care-icon-toggle${settings.sound ? ' is-on' : ''}`} aria-pressed={settings.sound} aria-label={ct('inbox2.alerts.sound')} title={ct('inbox2.alerts.sound')} onClick={onSound} data-testid="care-alert-sound">
        {settings.sound ? <Volume2 size={14} aria-hidden="true" /> : <VolumeX size={14} aria-hidden="true" />}
      </button>
      <button type="button" class={`care-icon-toggle${notifyOn ? ' is-on' : ''}`} aria-pressed={notifyOn} aria-label={ct('inbox2.alerts.notify')} title={permission === 'denied' ? ct('inbox2.alerts.denied') : ct('inbox2.alerts.notify')} disabled={permission === 'unsupported'} onClick={onNotify} data-testid="care-alert-notify">
        {notifyOn ? <Bell size={14} aria-hidden="true" /> : <BellOff size={14} aria-hidden="true" />}
      </button>
    </span>
  );
}
