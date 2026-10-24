// Core screens known to page-context (titles for the chat dock's context chip).
export type RouteSection = 'workspace';

export interface RouteDef {
  path: string;
  label: string;
  section: RouteSection;
}

export const SECTION_LABEL: Record<RouteSection, string> = { workspace: 'Không gian làm việc' };

export const ROUTES: RouteDef[] = [
  { path: '/', label: 'Tổng quan', section: 'workspace' },
  { path: '/agents', label: 'Agents', section: 'workspace' },
  { path: '/tasks', label: 'Công việc', section: 'workspace' },
  { path: '/schedules', label: 'Lịch định kỳ', section: 'workspace' },
  { path: '/chat', label: 'Trò chuyện', section: 'workspace' },
  { path: '/brain', label: 'Second Brain', section: 'workspace' },
  { path: '/memory', label: 'Bộ nhớ', section: 'workspace' },
  { path: '/skills', label: 'Skills', section: 'workspace' },
  { path: '/modules', label: 'Module', section: 'workspace' },
  { path: '/connections', label: 'Kết nối', section: 'workspace' },
  { path: '/audit', label: 'Nhật ký', section: 'workspace' },
  { path: '/settings', label: 'Cài đặt', section: 'workspace' },
];
