import { ChevronDown } from 'lucide-preact';
import { ct } from '@modules/care/web/lib/care/i18n';
import type { CareAccountDto } from '@modules/care/web/lib/care/dto';
import type { ZaloUsage } from '@modules/care/web/lib/care/useZaloUsage';

/** Connection state of a nick in words + a tone for the dot. */
export function connectionOf(a: Pick<CareAccountDto, 'desiredState' | 'healthStatus'>): { text: string; tone: 'ok' | 'warn' | 'bad' | 'off' } {
  if (a.desiredState === 'paused') return { text: ct('bot.nick.paused'), tone: 'off' };
  if (a.desiredState === 'disconnected' || a.desiredState === 'draining') return { text: ct('bot.nick.disconnected'), tone: 'off' };
  if (a.healthStatus === 'error') return { text: ct('bot.nick.error'), tone: 'bad' };
  if (a.healthStatus === 'degraded') return { text: ct('bot.nick.degraded'), tone: 'warn' };
  return { text: ct('bot.nick.connected'), tone: 'ok' };
}

export function usageText(u: ZaloUsage | null): string | null {
  if (!u) return null;
  return u.cap !== null ? ct('bot.nick.sent', { used: u.sentToday, limit: u.cap }) : ct('bot.nick.sentNoCap', { used: u.sentToday });
}

/**
 * Nick picker: which account the list shows ("" = all), with that nick's connection state and today's sent / cap.
 * A native select on top of the card keeps it keyboard and screen-reader friendly.
 */
export function NickPicker({ accounts, value, usage, onChange }: {
  accounts: CareAccountDto[];
  value: string;
  usage: ZaloUsage | null;
  onChange: (accountId: string) => void;
}) {
  const current = accounts.find((a) => a.id === value) ?? null;
  const conn = current ? connectionOf(current) : null;
  const sent = current?.channel === 'zalo' ? usageText(usage) : null;
  return (
    <label class="care-nick" data-testid="care-nick-picker">
      <span class={`care-nick-dot is-${conn?.tone ?? 'off'}`} aria-hidden="true" />
      <span class="care-nick-text">
        <span class="care-nick-name">{current ? current.label : ct('bot.nick.all')}</span>
        <span class="care-nick-sub" data-testid="care-nick-sub">
          {conn ? [conn.text, sent].filter(Boolean).join(' · ') : ct('bot.nick.pick')}
        </span>
      </span>
      <ChevronDown size={14} aria-hidden="true" />
      <select class="care-nick-select" aria-label={ct('bot.nick.pick')} value={value} onChange={(e) => onChange((e.target as HTMLSelectElement).value)}>
        <option value="">{ct('bot.nick.all')}</option>
        {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
      </select>
    </label>
  );
}
