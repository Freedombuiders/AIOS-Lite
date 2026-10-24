import { render } from 'preact';
import { act } from 'preact/test-utils';
import { Router } from 'wouter-preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// jsdom has no matchMedia; chat-dock reads it while loading.
vi.hoisted(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
});
import { startSse } from '@/lib/sse';
import AgentsPage from './agents/AgentsPage';
import AgentDetail from './agents/AgentDetail';
import AuditPage from './Audit';
import BrainSearch from './Brain';
import ChatPage from './Chat';
import ConnectionsPage from './Connections';
import HomeDashboard from './HomeDashboard';
import MemoryPage from './MemoryPage';
import MissionTaskDetail from './MissionTaskDetail';
import ModulesPage from './Modules';
import SchedulesPage from './Schedules';
import SecondBrain from './SecondBrain';
import SettingsPage from './Settings';
import SkillsPage from './Skills';
import TasksPage from './tasks/TasksPage';
import { Sidebar } from '@/components/Sidebar';

// Every page renders against the mock API without throwing and shows its Vietnamese heading or content.
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('pages with the mock api', () => {
  beforeEach(() => {
    sessionStorage.setItem('aios.mock', '1');
    startSse();
  });
  afterEach(() => vi.restoreAllMocks());

  const cases: [string, string, () => preact.VNode, RegExp][] = [
    ['/', 'dashboard', () => <HomeDashboard />, /Cần bạn/],
    ['/agents', 'agents', () => <AgentsPage />, /Trợ lý chính/],
    ['/agents/main', 'agent detail', () => <AgentDetail id="main" />, /Persona/],
    ['/tasks', 'tasks', () => <TasksPage />, /Chờ duyệt/],
    ['/tasks/3', 'task detail', () => <MissionTaskDetail />, /Caption|caption/],
    ['/schedules', 'schedules', () => <SchedulesPage />, /Báo cáo sáng/],
    ['/chat', 'chat', () => <ChatPage />, /Kế hoạch tuần/],
    ['/brain', 'second brain', () => <SecondBrain />, /Second Brain|Tri thức/],
    ['/brain/search', 'brain search', () => <BrainSearch />, /Lập lại chỉ mục/],
    ['/memory', 'memory', () => <MemoryPage />, /Bộ nhớ/],
    ['/skills', 'skills', () => <SkillsPage />, /Trả lời khách/],
    ['/connections', 'connections', () => <ConnectionsPage />, /composio|Composio/],
    ['/audit', 'audit', () => <AuditPage />, /task\.create/],
    ['/modules', 'modules', () => <ModulesPage />, /Chăm sóc khách hàng/],
    ['/settings', 'settings', () => <SettingsPage />, /Runtime/],
    ['/', 'sidebar', () => <Sidebar />, /Tổng quan/],
  ];

  it.each(cases)('%s (%s)', async (path, _name, make, expected) => {
    history.replaceState(null, '', path);
    const el = document.createElement('div');
    document.body.appendChild(el);
    await act(() => render(<Router>{make()}</Router>, el));
    for (let i = 0; i < 30 && !expected.test(el.textContent ?? ''); i++) await act(() => wait(100));
    expect(el.textContent).toMatch(expected);
    render(null, el);
    el.remove();
  });
});
