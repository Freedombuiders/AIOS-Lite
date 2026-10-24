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

/** /m/care/rules: "Ai trả lời ở đâu", the same table the channels screen shows, as a screen of its own. */
export function CareRules() {
  const agents = useFetch<{ agents: Array<{ id: string; name?: string }> }>('/api/agents', 60_000);
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

  const agentOptions = (agents.data?.agents ?? []).map((a) => ({ id: a.id, name: a.name ?? a.id }));
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
