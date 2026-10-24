// "Nâng cao": what the Care runtime offers that the owner rarely needs: the global switches (kill switches) and the
// held outbox items.
import { Loader2 } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { Modal } from '@/components/Modal';
import { Toggle } from '@/components/Toggle';
import { careApi } from '@modules/care/web/lib/care/client';
import type { CareHoldDto, CareSwitchDto } from '@modules/care/server/api/dto-ops';
import { toCareFailure } from '@modules/care/web/lib/care/failure';
import { ct } from '@modules/care/web/lib/care/i18n';
import { reasonText } from '@modules/care/web/lib/care/reasons';
import { pushToast } from '@/lib/toasts';

export function AdvancedPanel({ switches, holds, onChanged }: {
  switches: CareSwitchDto[]; holds: CareHoldDto[]; onChanged: () => void;
}) {
  const [toggle, setToggle] = useState<{ sw: CareSwitchDto; next: boolean } | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  async function applySwitch(): Promise<void> {
    if (!toggle || !reason.trim()) return;
    setBusy(true); setDialogError(null);
    try {
      const r = await careApi.setSwitch(toggle.sw.key, toggle.next, reason.trim());
      pushToast({ tone: 'success', title: ct(toggle.next ? 'channels.switchedOn' : 'channels.switchedOff', { key: switchLabel(toggle.sw.key) }), description: r.held ? ct('channels.heldBacklog', { n: r.held }) : undefined });
      setToggle(null); setReason(''); onChanged();
    } catch (e) {
      const f = toCareFailure(e);
      setDialogError(reasonText(f.reason) ?? f.message);
    } finally {
      setBusy(false);
    }
  }

  async function resolveHold(h: CareHoldDto, action: 'release' | 'discard'): Promise<void> {
    try {
      if (action === 'release') await careApi.releaseHold(h.itemKind, h.itemId);
      else await careApi.discardHold(h.itemKind, h.itemId);
      pushToast({ tone: 'success', title: ct(action === 'release' ? 'channels.released' : 'channels.discarded') });
      onChanged();
    } catch (e) {
      const f = toCareFailure(e);
      pushToast({ tone: 'error', title: ct('channels.holdFailed'), description: reasonText(f.reason) ?? f.message });
      onChanged();
    }
  }

  return (
    <>
      <section class="cc-section" aria-labelledby="care-switches-h">
        <h2 id="care-switches-h" class="care-section-title">{ct('channels.switches')}</h2>
        <p class="care-faint">{ct('channels.switchesHint')}</p>
        <ul class="care-switches">
          {switches.map((s) => (
            <li key={s.key} data-testid={`care-switch-${s.key}`}>
              <span class="care-switch-name">{switchLabel(s.key)}<code>{s.key}</code></span>
              <span class="care-faint">{s.explicit && s.changedAtMs ? ct('channels.changedBy', { who: s.changedBy ?? '?', time: new Date(s.changedAtMs).toLocaleString('vi-VN') }) : ct('channels.default')}</span>
              {s.reason && <span class="care-faint">“{s.reason}”</span>}
              <Toggle on={s.enabled} ariaLabel={`${switchLabel(s.key)}: ${s.enabled ? ct('channels.on') : ct('channels.off')}`} onChange={() => { setToggle({ sw: s, next: !s.enabled }); setReason(''); setDialogError(null); }} />
            </li>
          ))}
        </ul>
      </section>

      <section class="cc-section" aria-labelledby="care-holds-h">
        <h2 id="care-holds-h" class="care-section-title">{ct('channels.holds')} <span class="care-chip">{holds.length}</span></h2>
        <p class="care-faint">{ct('channels.holdsHint')}</p>
        {holds.length === 0 && <p class="care-note">{ct('channels.noHolds')}</p>}
        <ul class="care-holds">
          {holds.map((h) => (
            <li key={`${h.itemKind}:${h.itemId}`} data-testid="care-hold">
              <span><code>{h.itemKind}</code> <span class="care-faint">{h.itemId.slice(-8)}</span></span>
              <span class="care-faint">{h.reason} · {new Date(h.heldAtMs).toLocaleString('vi-VN')}</span>
              <span class="care-hold-actions">
                <button type="button" class="cc-button" onClick={() => void resolveHold(h, 'release')}>{ct('channels.release')}</button>
                <button type="button" class="cc-button" onClick={() => void resolveHold(h, 'discard')}>{ct('channels.discard')}</button>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <Modal
        open={!!toggle}
        onClose={() => { if (!busy) setToggle(null); }}
        title={toggle ? ct(toggle.next ? 'channels.turnOnTitle' : 'channels.turnOffTitle', { key: switchLabel(toggle.sw.key) }) : ''}
        width={480}
        footer={(
          <>
            <button type="button" class="cc-button" disabled={busy} onClick={() => setToggle(null)}>{ct('identity.cancel')}</button>
            <button type="button" class="cc-button is-primary" disabled={busy || !reason.trim()} onClick={() => void applySwitch()} data-testid="care-switch-confirm">
              {busy && <Loader2 size={12} class="animate-spin" aria-hidden="true" />} {ct('channels.confirm')}
            </button>
          </>
        )}
      >
        {toggle && (
          <div class="care-field">
            <p>{toggle.next ? ct('channels.turnOnBody') : ct('channels.turnOffBody')}</p>
            <label for="care-switch-reason">{ct('channels.reason')}</label>
            <textarea id="care-switch-reason" rows={3} value={reason} maxLength={500} onInput={(e) => setReason((e.target as HTMLTextAreaElement).value)} data-testid="care-switch-reason" />
            {dialogError && <span class="care-field-error" role="alert">{dialogError}</span>}
          </div>
        )}
      </Modal>
    </>
  );
}

function switchLabel(key: string): string {
  const label = ct(`channels.switch.${key.replace(':', '_')}`);
  return label.startsWith('channels.switch.') ? key : label;
}
