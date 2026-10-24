import { useState } from 'preact/hooks';
import { PageHeader, Tab } from '@/components/PageHeader';
import { useEvents } from '@/lib/sse';
import { useFetch } from '@/lib/useFetch';
import { ApprovalsTab } from './connections/ApprovalsTab';
import { IntegrationsTab } from './connections/IntegrationsTab';
import { McpTab } from './connections/McpTab';

type TabId = 'integrations' | 'approvals' | 'mcp';
const TABS: TabId[] = ['integrations', 'approvals', 'mcp'];

function initialTab(): TabId {
  const t = new URLSearchParams(window.location.search).get('tab');
  return TABS.includes(t as TabId) ? (t as TabId) : 'integrations';
}

export default function ConnectionsPage() {
  const [tab, setTabState] = useState<TabId>(initialTab);
  const pending = useFetch<{ items: unknown[] }>('/integrations/approvals?status=pending', 30_000);
  useEvents(['attention'], () => pending.refresh());

  function setTab(t: TabId) {
    setTabState(t);
    const u = new URL(window.location.href);
    if (t === 'integrations') u.searchParams.delete('tab');
    else u.searchParams.set('tab', t);
    window.history.replaceState(null, '', u);
  }

  return (
    <div class="page">
      <PageHeader
        title="Kết nối"
        tabs={
          <>
            <Tab label="Integrations" active={tab === 'integrations'} onClick={() => setTab('integrations')} />
            <Tab label="Chờ duyệt" active={tab === 'approvals'} count={pending.data?.items.length} onClick={() => setTab('approvals')} />
            <Tab label="MCP & khoá" active={tab === 'mcp'} onClick={() => setTab('mcp')} />
          </>
        }
      />
      {tab === 'integrations' && <IntegrationsTab />}
      {tab === 'approvals' && <ApprovalsTab />}
      {tab === 'mcp' && <McpTab />}
    </div>
  );
}
