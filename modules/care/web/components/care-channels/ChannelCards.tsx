// The account cards of "Kênh & agent": one generic card per care account (any channel). Channel-specific controls
// (login, anti-ban numbers, signature, ...) are drawn by the channel modules through the `care.channelPanel`
// extension point; with no provider the card shows only what care itself knows.
import { Bot } from 'lucide-preact';
import { ChannelBadge } from '@modules/care/web/components/care/ChannelBadge';
import { useProvides } from '@/module-host';
import { resolveAgentName } from '@/lib/format';
import { defaultAgentOf, usageView } from '@modules/care/web/lib/care-channels/accounts';
import { cc } from '@modules/care/web/lib/care-channels/i18n';
import { ct } from '@modules/care/web/lib/care/i18n';
import type { CareAccountDto } from '@modules/care/web/lib/care/dto';
import type { CareAssignmentDto } from '@modules/care/server/api/dto-ops';
import { CHANNEL_PANEL_KEY, type CareChannelPanelComponent } from '@modules/care/web/lib/extension-points';

const HEALTH_TONE: Record<CareAccountDto['healthStatus'], string> = { healthy: 'done', degraded: 'queued', error: 'failed' };

/** Renders every provided `care.channelPanel` for one account. Renders nothing when no module provides one. */
export function ChannelPanels({ account, onChanged }: { account: CareAccountDto; onChanged: () => void }) {
  const panels = useProvides<CareChannelPanelComponent>(CHANNEL_PANEL_KEY);
  if (panels.length === 0) return null;
  return (
    <div class="cch-panels" data-testid="cch-channel-panels">
      {panels.map((Panel, i) => <Panel key={i} channel={account.channel} accountId={account.id} account={account} onChanged={onChanged} />)}
    </div>
  );
}

export function AccountCard({ account: a, rules, onChanged, onAssign }: {
  account: CareAccountDto; rules: CareAssignmentDto[]; onChanged: () => void; onAssign: (accountId: string) => void;
}) {
  const def = defaultAgentOf(rules, a.id);
  const quota = a.delivery?.sendQuota ? usageView(a.delivery.sendQuota.used, a.delivery.sendQuota.limit) : null;
  return (
    <article class="cch-card" data-testid="cch-account-card" data-account-id={a.id} data-channel={a.channel} aria-label={a.label}>
      <div class="cch-card-head">
        <ChannelBadge channel={a.channel} />
        <div>
          <div class="cch-card-title">{a.label}</div>
          <div class="cch-sub">{ct(`channels.desired.${a.desiredState}`)}</div>
        </div>
        <span class={`cch-pill tone-${HEALTH_TONE[a.healthStatus]}`} data-testid="cch-account-health">{ct(`channels.health.${a.healthStatus}`)}</span>
      </div>

      <ul class="care-caps" aria-label={ct('channels.capabilities')}>
        <li class={a.syncEnabled ? 'is-on' : ''}>{ct('channels.cap.sync')}: {a.syncEnabled ? ct('channels.on') : ct('channels.off')}</li>
        <li class={a.sendEnabled ? 'is-on' : ''}>{ct('channels.cap.send')}: {a.sendEnabled ? ct('channels.on') : ct('channels.off')}</li>
        <li class={a.aiEnabled ? 'is-on' : ''}>{ct('channels.cap.ai')}: {a.aiEnabled ? ct('channels.on') : ct('channels.off')}</li>
      </ul>

      <div class="cch-agent-row" data-testid="cch-default-agent">
        <Bot size={14} aria-hidden="true" />
        {def ? (
          <>
            <span class="cch-agent-name">{resolveAgentName(def.agentId)} <span class="cch-sub">(AI)</span></span>
            <span class="cch-mode">{def.enabled ? cc(`mode.${def.mode}`) : cc('mode.disabled')}</span>
          </>
        ) : (
          <>
            <span class="cch-agent-name cch-muted">{cc('card.noDefaultAgent')}</span>
            <button type="button" class="care-link-button" onClick={() => onAssign(a.id)}>{cc('card.assign')}</button>
          </>
        )}
      </div>

      {quota && (
        <div class="cch-usage" data-testid="cch-usage">
          <div class="cch-usage-top"><span>{'Hạn mức gửi hôm nay'}</span><b>{quota.used}/{quota.limit}</b></div>
          <div class={`cch-bar${quota.hot ? ' is-hot' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={quota.limit} aria-valuenow={Math.min(quota.used, quota.limit)} aria-label={'Hạn mức gửi hôm nay'}>
            <span style={{ width: `${quota.percent}%` }} />
          </div>
        </div>
      )}

      <ChannelPanels account={a} onChanged={onChanged} />
    </article>
  );
}
