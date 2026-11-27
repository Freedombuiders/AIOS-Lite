import {
  Bot, Boxes, Brain, Cable, CircleDollarSign, ClipboardList, Calendar, House, Library, Lightbulb, MessageSquare, Mic, Network, Package,
  Puzzle, ScrollText, Settings, Sparkles, Wallet, Gauge, Wrench, Handshake, Megaphone, Landmark, Workflow, Wand2,
} from 'lucide-preact';
import type { LucideIcon } from 'lucide-preact';
import type { NavGroup } from '@/module-host/contracts';

export interface CoreNavItem {
  label: string;
  path: string;
  icon: LucideIcon;
  match?: string[];
}

/** Pages the app has no screen for yet: they open a placeholder that says so (pages/ComingSoon.tsx). */
export const PLACEHOLDER_PATHS = ['/voice', '/brain/graph'] as const;

const HOME: CoreNavItem = { label: 'Hôm nay', path: '/', icon: House };
const VOICE: CoreNavItem = { label: 'Gọi trợ lý', path: '/voice', icon: Mic };
const CHAT: CoreNavItem = { label: 'Trò chuyện', path: '/chat', icon: MessageSquare };
const GRAPH: CoreNavItem = { label: 'Đồ thị', path: '/brain/graph', icon: Network };
const BRAIN: CoreNavItem = { label: 'Second Brain', path: '/brain', icon: Brain, match: ['/brain/search', '/brain/all'] };
const PACKS: CoreNavItem = { label: 'Kho dữ liệu', path: '/packs', icon: Boxes };
/** Every agent is a GenBot bot: this screen is the way in. A bot's runs and access (/agents/:id) open from its card. */
const BOTS: CoreNavItem = { label: 'Đội AI · Bot', path: '/bots', icon: Bot, match: ['/agents'] };
const TASKS: CoreNavItem = { label: 'Công việc', path: '/tasks', icon: ClipboardList };
const SCHEDULES: CoreNavItem = { label: 'Lịch định kỳ', path: '/schedules', icon: Calendar };
const TEAMS: CoreNavItem = { label: 'Gói Team', path: '/teams', icon: Package };
const SKILLS: CoreNavItem = { label: 'Skills', path: '/skills', icon: Sparkles };
const MEMORY: CoreNavItem = { label: 'Bộ nhớ', path: '/memory', icon: Library };
const RECOS: CoreNavItem = { label: 'Đề xuất cải tiến', path: '/recos', icon: Lightbulb };
const USAGE: CoreNavItem = { label: 'Chi phí AI', path: '/usage', icon: Gauge };
const BUDGETS: CoreNavItem = { label: 'Ngân sách AI', path: '/budgets', icon: Wallet };
const MODULES: CoreNavItem = { label: 'Module', path: '/modules', icon: Puzzle };
const CONNECTIONS: CoreNavItem = { label: 'Kết nối', path: '/connections', icon: Cable };
const AUDIT: CoreNavItem = { label: 'Nhật ký', path: '/audit', icon: ScrollText };
const SETTINGS: CoreNavItem = { label: 'Cài đặt', path: '/settings', icon: Settings };

/** The rarely used core pages. Folded into "Nâng cao" (closed until opened); no route is removed. */
export const ADVANCED_NAV: CoreNavItem[] = [TEAMS, SKILLS, MEMORY, RECOS, USAGE, BUDGETS, AUDIT, MODULES];

/** Every core page that has a route, for the breadcrumb and the quick-search palette. */
export const CORE_NAV: CoreNavItem[] = [
  HOME, VOICE, CHAT, GRAPH, BRAIN, PACKS, BOTS, TASKS, SCHEDULES, CONNECTIONS, SETTINGS, ...ADVANCED_NAV.filter((i) => i !== AUDIT && i !== MODULES),
];

/** Kept for the palette, which lists these under "Hệ thống". */
export const BOTTOM_NAV: CoreNavItem[] = [MODULES, AUDIT];

export const HOME_NAV = HOME;

// ---------------------------------------------------------------- sidebar layout

export type SectionId = 'top' | 'brain' | 'care' | 'marketing' | 'system';

/** Where a module's `group` is shown. The six original groups stay valid; `care` and `brain` are the new ones. */
export const GROUP_SECTION: Record<NavGroup, SectionId | 'more'> = {
  brain: 'brain',
  care: 'care',
  sales: 'care',
  marketing: 'marketing',
  studio: 'marketing',
  finance: 'more',
  ops: 'more',
  other: 'more',
};

export interface NavSectionDef {
  id: SectionId;
  /** caption; the top section has none */
  label?: string;
  /** core pages, always shown */
  items: CoreNavItem[];
  /** start of the section's colour (sidebar-section-* in main.css) */
  tone: string;
}

export const NAV_SECTIONS: NavSectionDef[] = [
  { id: 'top', items: [HOME, VOICE, CHAT], tone: 'workspace' },
  { id: 'brain', label: 'BRAIN', items: [GRAPH, BRAIN, PACKS], tone: 'intelligence' },
  { id: 'care', label: 'CHĂM KHÁCH', items: [], tone: 'care' },
  { id: 'marketing', label: 'MARKETING', items: [], tone: 'marketing' },
  { id: 'system', label: 'ĐỘI AI VÀ HỆ THỐNG', items: [BOTS, TASKS, SCHEDULES, CONNECTIONS, SETTINGS], tone: 'collaborate' },
];

export interface NavGroupDef {
  id: string;
  label: string;
  icon: LucideIcon;
  items: CoreNavItem[];
  /** open the first time the sidebar is shown (before the viewer toggles it) */
  defaultOpen?: boolean;
}

/** Closed by default: opens by itself while the current page is inside. */
export const ADVANCED_GROUP: NavGroupDef = { id: 'advanced', label: 'Nâng cao', icon: Wrench, items: ADVANCED_NAV };

/** Module pages of the finance / ops / other groups. */
export const MORE_GROUP_ID = 'more';
export const MORE_GROUP_LABEL = 'Khác';

/** Captions, for the quick-search palette. Keep every key of NavGroup. */
export const GROUP_LABEL: Record<string, string> = {
  brain: 'Brain',
  care: 'Chăm khách',
  sales: 'Chăm khách',
  marketing: 'Marketing',
  studio: 'Marketing',
  finance: MORE_GROUP_LABEL,
  ops: MORE_GROUP_LABEL,
  other: MORE_GROUP_LABEL,
};

export const GROUP_ICON: Record<string, LucideIcon> = {
  brain: Brain, care: Handshake, sales: Handshake, marketing: Megaphone, studio: Wand2, finance: Landmark, ops: Workflow, other: Puzzle,
  [MORE_GROUP_ID]: CircleDollarSign,
};

export function isActive(current: string, item: { path: string; match?: string[] }): boolean {
  const hit = (p: string) => (p === '/' ? current === '/' : current === p || current.startsWith(`${p}/`));
  return hit(item.path) || (item.match ?? []).some(hit);
}

/** The one item that owns `current`: the longest matching path, so /brain/graph does not also light up /brain. */
export function bestMatch<T extends { path: string; match?: string[] }>(current: string, items: readonly T[]): T | undefined {
  const score = (i: T) => Math.max(...[i.path, ...(i.match ?? [])].filter((p) => isActive(current, { path: p })).map((p) => p.length), -1);
  let best: T | undefined;
  let bestScore = -1;
  for (const i of items) {
    const sc = score(i);
    if (sc > bestScore) { best = i; bestScore = sc; }
  }
  return best;
}

/** The module nav items shown in one section (or the "Khác" group), in their own order. */
export function moduleItemsFor<T extends { group: NavGroup }>(section: SectionId | 'more', items: readonly T[]): T[] {
  return items.filter((i) => GROUP_SECTION[i.group] === section);
}

/** Every path the sidebar can reach on its own, for tests: top-level items plus everything in "Nâng cao". */
export function reachableCorePaths(): string[] {
  return [...NAV_SECTIONS.flatMap((s) => s.items), ...ADVANCED_GROUP.items].map((i) => i.path);
}
