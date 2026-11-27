import { useEffect, useState } from 'preact/hooks';
import { CareTabs } from '@modules/care/web/components/care/CareTabs';
import { RulesSection } from '@modules/care/web/components/care-channels/RulesSection';
import { PageHeader } from '@/components/PageHeader';
import { careApi } from '@modules/care/web/lib/care/client';
import type { CareAccountDto } from '@modules/care/web/lib/care/dto';
import type { CareAssignmentDto } from '@modules/care/server/api/dto-ops';
import { useFetch } from '@/lib/useFetch';
import '@modules/care/web/styles/care.css';
import '@modules/care/web/styles/care-channels.css';
import { pickerBots, type BotLike } from '@/lib/bots';

type BotRow = BotLike & { name?: string };

/** /m/care/rules: "Ai trả lời ở đâu", the same table the channels screen shows, as a screen of its own. */
export function CareRules() {
  const agents = useFetch<{ items?: BotRow[]; agents?: BotRow[] }>('/api/agents', 60_000);
  const [accounts, setAccounts] = useState<CareAccountDto[]>([]);
  const [rules, setRules] = useState<CareAssignmentDto[]>([]);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    Promise.allSettled([careApi.accounts(), careApi.assignments()]).then(([a, r]) => {
      if (!live) return;
      if (a.status === 'fulfilled') setAccounts(a.value.items);
      if (r.status === 'fulfilled') setRules(r.value.items);
    });
    return () => { live = false; };
  }, [reload]);

  // only GenBot bots that have a key (Open AgenticOS runs every agent on GenBot)
  const agentOptions = pickerBots(agents.data).map((a) => ({ id: a.id, name: a.name ?? a.id }));
  return (
    <div class="care-page module-fill" data-testid="care-rules">
      <PageHeader compact breadcrumb="Chăm sóc khách" title="Quy tắc" tabs={<CareTabs current="rules" />} />
      <div class="care-scroll-page">
        <div class="cch-page">
          <RulesSection careAccounts={accounts} coreRules={rules} agents={agentOptions} onChanged={() => setReload((n) => n + 1)} />
        </div>
      </div>
    </div>
  );
}
