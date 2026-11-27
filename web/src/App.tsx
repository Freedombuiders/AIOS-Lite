import { useEffect } from 'preact/hooks';
import { Link, Redirect, Router } from 'wouter-preact';
import { Menu, Moon, Sun } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { useLocation } from 'wouter-preact';
import { CommandPalette } from '@/components/CommandPalette';
import { Sidebar } from '@/components/Sidebar';
import { BOTTOM_NAV, CORE_NAV, isActive } from '@/lib/nav';
import { navOpen } from '@/lib/palette';
import { setAppearance } from '@/lib/personalization';
import { navItems } from '@/module-host/host';
import { ToastHost } from '@/components/ToastHost';
import { OwnerSignIn } from '@/components/OwnerSignIn';
import { mockEnabled } from '@/lib/mock';
import { startSse } from '@/lib/sse';
import { routes, startModuleHost } from '@/module-host/host';
import { AppMain } from '@/components/AppMain';
import type { AppRoute } from '@/components/AppMain';
import { GraphPlaceholder, VoicePlaceholder } from '@/pages/ComingSoon';
import Dashboard from '@/pages/HomeDashboard';
import BotsPage from '@/pages/bots/BotsPage';
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
import RecosPage from '@/pages/Recos';
import PacksPage from '@/pages/packs/PacksPage';

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

function ChatById({ id }: { id: string }) {
  return <ChatPage conversationId={Number(id)} />;
}

function ToBots() {
  return <Redirect to="/bots" replace />;
}

function AgentById({ id }: { id: string }) {
  return <AgentDetail id={id} />;
}

/** Core pages. Chat has its own composer, so it hides the command bar. */
const CORE_ROUTES: AppRoute[] = [
  { path: '/', component: Dashboard },
  { path: '/voice', component: VoicePlaceholder },
  { path: '/bots', component: BotsPage },
  // the generic Agents list and the old agent market are gone: both lead to Đội AI · Bot
  { path: '/agents', component: ToBots },
  { path: '/agents/:id', component: AgentById },
  { path: '/tasks', component: TasksPage },
  { path: '/tasks/:id', component: TaskDetail },
  { path: '/schedules', component: SchedulesPage },
  { path: '/chat', component: ChatPage, hideCommandBar: true },
  { path: '/chat/:id', component: ChatById, hideCommandBar: true },
  { path: '/brain', component: SecondBrain },
  { path: '/brain/graph', component: GraphPlaceholder },
  { path: '/brain/search', component: BrainSearchPage },
  { path: '/brain/all', component: SecondBrains },
  { path: '/memory', component: MemoryPage },
  { path: '/packs', component: PacksPage },
  { path: '/packs/:id', component: PacksPage },
  { path: '/skills', component: SkillsPage },
  { path: '/modules', component: ModulesPage },
  { path: '/connections', component: ConnectionsPage },
  { path: '/audit', component: AuditPage },
  { path: '/settings', component: SettingsPage },
  { path: '/usage', component: UsagePage },
  { path: '/budgets', component: BudgetsPage },
  { path: '/teams', component: TeamsPage },
  { path: '/agent-market', component: ToBots },
  { path: '/recos', component: RecosPage },
];

export function App() {
  const appRoutes: AppRoute[] = [...CORE_ROUTES, ...routes.value.map((r) => ({ ...r, modulePage: true }))];
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
        <AppMain routes={appRoutes} notFound={NotFound} />
        </div>
      </div>
      <CommandPalette />
      {mockEnabled() && <div class="pointer-events-none fixed top-2 left-1/2 z-40 -translate-x-1/2 rounded-full border border-[var(--color-accent)] bg-[var(--color-card)] px-3 py-0.5 text-[11px] text-[var(--color-accent)]">Xem thử với dữ liệu giả, chưa nối máy chủ thật</div>}
      <ToastHost />
      <OwnerSignIn />
    </Router>
  );
}
