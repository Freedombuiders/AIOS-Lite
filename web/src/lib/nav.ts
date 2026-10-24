import {
  Bot, Brain, Calendar, Cable, ClipboardList, LayoutDashboard, MessageSquare, Puzzle, ScrollText, Settings, Sparkles, Library,
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
  sales: 'Sales',
  marketing: 'Marketing',
  ops: 'Vận hành',
  other: 'Khác',
};
export const GROUP_ORDER = ['sales', 'marketing', 'ops', 'other'] as const;

export function isActive(current: string, item: { path: string; match?: string[] }): boolean {
  const hit = (p: string) => (p === '/' ? current === '/' : current === p || current.startsWith(`${p}/`));
  return hit(item.path) || (item.match ?? []).some(hit);
}
