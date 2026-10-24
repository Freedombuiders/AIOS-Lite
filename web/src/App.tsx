import { useEffect } from 'preact/hooks';
import { Link, Route, Router, Switch } from 'wouter-preact';
import { Menu, Moon, Sun } from 'lucide-preact';
import type { ComponentType } from 'preact';
import { useState } from 'preact/hooks';
import { useLocation } from 'wouter-preact';
import { CommandPalette } from '@/components/CommandPalette';
import { Sidebar } from '@/components/Sidebar';
import { BOTTOM_NAV, CORE_NAV, isActive } from '@/lib/nav';
import { navOpen } from '@/lib/palette';
import { setAppearance } from '@/lib/personalization';
import { navItems } from '@/module-host/host';
import { ToastHost } from '@/components/ToastHost';
import { mockEnabled } from '@/lib/mock';
import { startSse } from '@/lib/sse';
import { routes, startModuleHost } from '@/module-host/host';
import Dashboard from '@/pages/HomeDashboard';
import AgentsPage from '@/pages/agents/AgentsPage';
import AgentDetail from '@/pages/agents/AgentDetail';
import TasksPage from '@/pages/tasks/TasksPage';
import TaskDetail from '@/pages/MissionTaskDetail';
import SchedulesPage from '@/pages/Schedules';
import ChatPage from '@/pages/Chat';
import BrainSearchPage from '@/pages/Brain';
import SecondBrain from '@/pages/SecondBrain';
import SecondBrains from '@/pages/SecondBrains';
import MemoryPage from '@/pages/MemoryPage';
import SkillsPage from '@/pages/Skills';
import ConnectionsPage from '@/pages/Connections';
import AuditPage from '@/pages/Audit';
import ModulesPage from '@/pages/Modules';
import SettingsPage from '@/pages/Settings';
import UsagePage from '@/pages/Usage';
import BudgetsPage from '@/pages/Budgets';
import TeamsPage from '@/pages/Teams';
import AgentMarketPage from '@/pages/AgentMarket';
import RecosPage from '@/pages/Recos';

function NotFound() {
  return (
    <div class="page">
      <h1 class="m-0 text-[18px] font-semibold">Không tìm thấy trang</h1>
      <p class="hint">Trang này không tồn tại, hoặc module chứa nó chưa được bật.</p>
      <Link href="/" class="control-button no-underline">
        Về Tổng quan
      </Link>
    </div>
  );
}

function ModuleRoute({ component: C, params }: { component: ComponentType<any>; params: Record<string, string> }) {
  return (
    <div class="page module-page">
      <C {...params} />
    </div>
  );
}

function TopBar() {
  const [loc] = useLocation();
  const [dark, setDark] = useState(() => document.documentElement.getAttribute('data-appearance') !== 'light');
  const all = [...CORE_NAV, ...navItems.value, ...BOTTOM_NAV];
  const cur = all.filter((i) => isActive(loc, i)).sort((a, b) => b.path.length - a.path.length)[0];
  return (
    <header class="app-topbar">
      <button type="button" class="sidebar-icon-button app-topbar-menu" aria-label="Mở menu" onClick={() => { navOpen.value = true; }}>
        <Menu size={16} />
      </button>
      <nav class="app-breadcrumb" aria-label="Vị trí">
        <span>AIOS-Lite</span>
        {cur && <><span class="app-breadcrumb-sep">/</span><span class="app-breadcrumb-current">{cur.label}</span></>}
      </nav>
      <button
        type="button"
        class="sidebar-icon-button ml-auto"
        aria-label={dark ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối'}
        title={dark ? 'Giao diện sáng' : 'Giao diện tối'}
        onClick={() => { setAppearance(dark ? 'light' : 'dark'); setDark(!dark); }}
      >
        {dark ? <Sun size={15} /> : <Moon size={15} />}
      </button>
    </header>
  );
}

export function App() {
  useEffect(() => {
    startSse();
    startModuleHost();
  }, []);

  return (
    <Router>
      <div class="app-shell">
        <Sidebar />
        {navOpen.value && <div class="app-scrim" onClick={() => { navOpen.value = false; }} />}
        <div class="app-column">
        <TopBar />
        <main class="app-main">
          <Switch>
            <Route path="/" component={Dashboard} />
            <Route path="/agents" component={AgentsPage} />
            <Route path="/agents/:id">{(p) => <AgentDetail id={p.id} />}</Route>
            <Route path="/tasks" component={TasksPage} />
            <Route path="/tasks/:id" component={TaskDetail} />
            <Route path="/schedules" component={SchedulesPage} />
            <Route path="/chat">{() => <ChatPage />}</Route>
            <Route path="/chat/:id">{(p) => <ChatPage conversationId={Number(p.id)} />}</Route>
            <Route path="/brain" component={SecondBrain} />
            <Route path="/brain/search" component={BrainSearchPage} />
            <Route path="/brain/all" component={SecondBrains} />
            <Route path="/memory" component={MemoryPage} />
            <Route path="/skills" component={SkillsPage} />
            <Route path="/modules" component={ModulesPage} />
            <Route path="/connections" component={ConnectionsPage} />
            <Route path="/audit" component={AuditPage} />
            <Route path="/settings" component={SettingsPage} />
            <Route path="/usage" component={UsagePage} />
            <Route path="/budgets" component={BudgetsPage} />
            <Route path="/teams" component={TeamsPage} />
            <Route path="/agent-market" component={AgentMarketPage} />
            <Route path="/recos" component={RecosPage} />
            {routes.value.map((r) => (
              <Route key={r.path} path={r.path}>{(params) => <ModuleRoute component={r.component} params={params as Record<string, string>} />}</Route>
            ))}
            <Route component={NotFound} />
          </Switch>
        </main>
        </div>
      </div>
      <CommandPalette />
      {mockEnabled() && <div class="pointer-events-none fixed top-2 left-1/2 z-40 -translate-x-1/2 rounded-full border border-[var(--color-accent)] bg-[var(--color-card)] px-3 py-0.5 text-[11px] text-[var(--color-accent)]">Xem thử với dữ liệu giả, chưa nối máy chủ thật</div>}
      <ToastHost />
    </Router>
  );
}
