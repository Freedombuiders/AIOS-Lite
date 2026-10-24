import { useEffect, useState } from 'preact/hooks';
import { CareTabs } from '@modules/care/web/components/care/CareTabs';
import { PageHeader } from '@/components/PageHeader';
import { AdvancedPanel } from '@modules/care/web/components/care-channels/AdvancedPanel';
import { AccountCard } from '@modules/care/web/components/care-channels/ChannelCards';
import { CannedSection } from '@modules/care/web/components/care-channels/CannedSection';
import { RulesSection } from '@modules/care/web/components/care-channels/RulesSection';
import { careApi } from '@modules/care/web/lib/care/client';
import type { CareAccountDto } from '@modules/care/web/lib/care/dto';
import type { CareAssignmentDto, CareHoldDto, CareSwitchDto } from '@modules/care/server/api/dto-ops';
import { cc } from '@modules/care/web/lib/care-channels/i18n';
import { useFetch } from '@/lib/useFetch';
import '@modules/care/web/styles/care.css';
import '@modules/care/web/styles/care-channels.css';

/** Scrolls to `#rules`, `#advanced`, ... once the page has content (and again when the hash changes). */
function useHashScroll(ready: boolean): void {
  useEffect(() => {
    const go = () => {
      const id = window.location.hash.replace(/^#/, '');
      if (id) document.getElementById(id)?.scrollIntoView({ block: 'start' });
    };
    if (ready) go();
    window.addEventListener('hashchange', go);
    return () => window.removeEventListener('hashchange', go);
  }, [ready]);
}

export function CareChannels() {
  const agents = useFetch<{ agents: Array<{ id: string; name?: string }> }>('/api/agents', 60_000);

  const [careAccounts, setCareAccounts] = useState<CareAccountDto[]>([]);
  const [coreRules, setCoreRules] = useState<CareAssignmentDto[]>([]);
  const [switches, setSwitches] = useState<CareSwitchDto[]>([]);
  const [holds, setHolds] = useState<CareHoldDto[]>([]);
  const [careLoaded, setCareLoaded] = useState(false);
  const [reload, setReload] = useState(0);
  const [advancedOpen, setAdvancedOpen] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
    Promise.allSettled([careApi.accounts(), careApi.assignments(), careApi.switches(), careApi.holds()]).then(([a, r, s, h]) => {
      if (!live) return;
      if (a.status === 'fulfilled') setCareAccounts(a.value.items);
      if (r.status === 'fulfilled') setCoreRules(r.value.items);
      if (s.status === 'fulfilled') setSwitches(s.value.items);
      if (h.status === 'fulfilled') setHolds(h.value.items);
      setCareLoaded(true);
    });
    return () => { live = false; };
  }, [reload]);

  const agentOptions = (agents.data?.agents ?? []).map((a) => ({ id: a.id, name: a.name ?? a.id }));
  useHashScroll(careLoaded);

  const changed = () => setReload((n) => n + 1);
  const assign = () => { document.getElementById('rules')?.scrollIntoView({ block: 'start' }); };
  const advanced = advancedOpen ?? (holds.length > 0 || window.location.hash === '#advanced');
  const noChannels = careLoaded && careAccounts.length === 0;

  return (
    <div class="care-page module-fill" data-testid="care-channels">
      <PageHeader compact breadcrumb={cc('breadcrumb')} title={cc('title')} tabs={<CareTabs current="channels" />} />
      <div class="care-scroll-page">
        <div class="cch-page">
          <p class="cch-intro">{cc('intro')}</p>

          <section class="cch-section" aria-labelledby="cch-accounts-h" data-testid="cch-accounts">
            <div class="cch-section-head"><h2 id="cch-accounts-h" class="cch-h2">{cc('accounts.title')}</h2></div>
            {noChannels && <div class="cch-empty" data-testid="cch-no-channels">{cc('accounts.empty')}<p>{cc('accounts.emptyHint')}</p></div>}
            <div class="cch-cards">
              {careAccounts.map((a) => <AccountCard key={a.id} account={a} rules={coreRules} onChanged={changed} onAssign={assign} />)}
            </div>
          </section>

          <RulesSection careAccounts={careAccounts} coreRules={coreRules} agents={agentOptions} onChanged={changed} />

          <div class="cch-split">
            <CannedSection />
          </div>

          <details class="cch-section" open={advanced} onToggle={(e) => setAdvancedOpen((e.target as HTMLDetailsElement).open)} id="advanced" data-testid="care-advanced">
            <summary class="cch-h2" style={{ cursor: 'pointer' }}>{cc('advanced.title')}</summary>
            <p class="cch-note">{cc('advanced.hint')}</p>
            <AdvancedPanel switches={switches} holds={holds} onChanged={changed} />
          </details>
        </div>
      </div>
    </div>
  );
}
