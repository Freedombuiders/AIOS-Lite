import { useState } from 'preact/hooks';
import { QrCode, ShieldCheck, SlidersHorizontal } from 'lucide-preact';
import { PageState } from '@/components/PageState';
import { Pill } from '@/components/Pill';
import { useFetch } from '@/lib/useFetch';
import { STATUS_LABEL, STATUS_TONE, type ZaloAccount } from '../lib/zalo';
import { NickLimitsModal, ProtectionSettingsModal, QrLoginModal, UsageBar, effectiveStatus } from './ZaloNickModals';
import { BTN } from './shared';

/**
 * Props the care module passes to every 'care.channelPanel' provider (agreed contract). Declared locally on purpose:
 * zalo never imports care code. `accountId` is the zalo account id.
 */
export interface ChannelPanelProps {
  channel: string;
  accountId?: string;
  onChanged?: () => void;
}

/** Zalo-specific part of a care account card: connection, QR login, anti-ban numbers. Renders nothing for other channels. */
export function ZaloChannelPanel({ channel, accountId, onChanged }: ChannelPanelProps) {
  const nicks = useFetch<{ accounts: ZaloAccount[] }>(channel === 'zalo' && accountId ? '/api/m/zalo/accounts' : null, 5_000);
  const [qr, setQr] = useState(false);
  const [limits, setLimits] = useState(false);
  const [protection, setProtection] = useState(false);
  if (channel !== 'zalo' || !accountId) return null;

  const nick = nicks.data?.accounts.find((a) => a.id === accountId);
  if (nicks.error && !nick) return <PageState error={nicks.error} />;
  if (!nick) return nicks.loading ? <PageState loading /> : null;
  const st = effectiveStatus(nick);
  const refresh = () => { nicks.refresh(); onChanged?.(); };

  return (
    <div class="flex flex-col gap-2">
      <div class="flex flex-wrap items-center gap-2">
        <Pill tone={STATUS_TONE[st]}>{STATUS_LABEL[st]}</Pill>
        {nick.sendLockReason && <Pill tone="failed">Đã khoá gửi tự động</Pill>}
        {nick.warmup.week > 0 && <Pill tone="accent">Nuôi nick tuần {nick.warmup.week}</Pill>}
      </div>
      <UsageBar account={nick} />
      <div class="flex flex-wrap gap-2">
        <button type="button" class={BTN} onClick={() => setQr(true)}><QrCode size={13} /> {st === 'connected' ? 'Đăng nhập lại bằng QR' : 'Đăng nhập bằng QR'}</button>
        <button type="button" class={BTN} onClick={() => setLimits(true)}><SlidersHorizontal size={13} /> Giới hạn của nick</button>
        <button type="button" class={BTN} onClick={() => setProtection(true)}><ShieldCheck size={13} /> Cài đặt chống khoá</button>
      </div>
      {qr && <QrLoginModal accountId={nick.id} onClose={() => { setQr(false); refresh(); }} />}
      {limits && <NickLimitsModal account={nick} onClose={() => setLimits(false)} onSaved={refresh} />}
      {protection && <ProtectionSettingsModal onClose={() => setProtection(false)} onSaved={refresh} />}
    </div>
  );
}
