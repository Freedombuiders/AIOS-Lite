import {
  Bot, Brain, Briefcase, Calendar, Cable, ClipboardList, Handshake, LayoutDashboard, Library, Megaphone, MessageSquare, Puzzle,
  ScrollText, Settings, Sparkles, Workflow, Wand2, Landmark, Gauge, Wallet, Store, Package, Lightbulb, CircleDollarSign,
} from 'lucide-preact';
import type { LucideIcon } from 'lucide-preact';

export interface CoreNavItem {
  label: string;
  path: string;
  icon: LucideIcon;
  match?: string[];
}

export const CORE_NAV: CoreNavItem[] = [
  { label: 'Tổng quan', path: '/', icon: LayoutDashboard },
  { label: 'Agents', path: '/agents', icon: Bot },
  { label: 'Công việc', path: '/tasks', icon: ClipboardList },
  { label: 'Lịch định kỳ', path: '/schedules', icon: Calendar },
  { label: 'Trò chuyện', path: '/chat', icon: MessageSquare },
  { label: 'Second Brain', path: '/brain', icon: Brain },
  { label: 'Bộ nhớ', path: '/memory', icon: Library },
  { label: 'Skills', path: '/skills', icon: Sparkles },
  { label: 'Chợ Agent', path: '/agent-market', icon: Store },
  { label: 'Gói Team', path: '/teams', icon: Package },
  { label: 'Đề xuất cải tiến', path: '/recos', icon: Lightbulb },
  { label: 'Chi phí AI', path: '/usage', icon: Gauge },
  { label: 'Ngân sách AI', path: '/budgets', icon: Wallet },
];

/** Overview sits alone at the top of the sidebar, without a caption. */
export const HOME_NAV: CoreNavItem = CORE_NAV[0]!;
export const WORK_NAV: CoreNavItem[] = CORE_NAV.slice(1);

export const BOTTOM_NAV: CoreNavItem[] = [
  { label: 'Module', path: '/modules', icon: Puzzle },
  { label: 'Kết nối', path: '/connections', icon: Cable },
  { label: 'Nhật ký', path: '/audit', icon: ScrollText },
  { label: 'Cài đặt', path: '/settings', icon: Settings },
];

export const GROUP_LABEL: Record<string, string> = {
  studio: 'AI Studio',
  sales: 'Sales',
  marketing: 'Marketing',
  finance: 'Finance',
  ops: 'Vận hành',
  other: 'Khác',
};
export const GROUP_ORDER = ['studio', 'sales', 'marketing', 'finance', 'ops', 'other'] as const;

export function isActive(current: string, item: { path: string; match?: string[] }): boolean {
  const hit = (p: string) => (p === '/' ? current === '/' : current === p || current.startsWith(`${p}/`));
  return hit(item.path) || (item.match ?? []).some(hit);
}

// ---------------------------------------------------------------- collapsible sidebar groups

export interface NavGroupDef {
  id: string;
  label: string;
  icon: LucideIcon;
  items: CoreNavItem[];
  /** open the first time the sidebar is shown (before the viewer toggles it) */
  defaultOpen?: boolean;
}

const byPath = (path: string): CoreNavItem => CORE_NAV.find((i) => i.path === path)!;

/** Core groups under the WORKSPACE / AGENTS captions; module groups (sales, marketing…) are added between them. */
export const WORK_GROUP: NavGroupDef = {
  id: 'work', label: 'Làm việc', icon: Briefcase, defaultOpen: true,
  items: [byPath('/tasks'), byPath('/schedules'), byPath('/chat')],
};
export const AGENT_GROUPS: NavGroupDef[] = [
  { id: 'agents', label: 'Đội agent', icon: Bot, defaultOpen: true, items: [byPath('/agents'), byPath('/skills'), byPath('/agent-market'), byPath('/teams'), byPath('/recos')] },
  { id: 'costs', label: 'Chi phí AI', icon: CircleDollarSign, items: [byPath('/usage'), byPath('/budgets')] },
  { id: 'knowledge', label: 'Tri thức', icon: Brain, items: [byPath('/brain'), byPath('/memory')] },
];
export const SYSTEM_GROUP: NavGroupDef = { id: 'system', label: 'Hệ thống', icon: Settings, items: BOTTOM_NAV };

export const GROUP_ICON: Record<string, LucideIcon> = { studio: Wand2, sales: Handshake, marketing: Megaphone, finance: Landmark, ops: Workflow, other: Puzzle };
