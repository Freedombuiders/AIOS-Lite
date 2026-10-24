// View helpers for the org chart page and the sidebar agent list.
import type { OrgNodeDto } from './org-layout';

export interface RunningTaskRef { id: string; title: string }

/** Agent link target. */
export function agentHref(id: string): string {
  return `/agents/${encodeURIComponent(id)}`;
}

/** First running mission task per agent, from `GET /api/mission/tasks?status=running`. */
export function runningTaskByAgent(tasks: ReadonlyArray<{ id: string; title: string; assigned_agent: string | null; status: string }> | null | undefined): Map<string, RunningTaskRef> {
  const out = new Map<string, RunningTaskRef>();
  for (const t of tasks ?? []) {
    if (t.status === 'running' && t.assigned_agent && !out.has(t.assigned_agent)) out.set(t.assigned_agent, { id: t.id, title: t.title });
  }
  return out;
}

/** Agents that may become `agentId`'s manager: not itself and nobody who reports to it (that would loop). */
export function managerChoices(nodes: readonly OrgNodeDto[], agentId: string): OrgNodeDto[] {
  const below = new Set<string>();
  const stack = [agentId];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const n of nodes) if (n.reportsTo === cur && !below.has(n.id) && n.id !== agentId) { below.add(n.id); stack.push(n.id); }
  }
  return nodes.filter((n) => n.id !== agentId && !below.has(n.id));
}

export const SIDEBAR_AGENT_LIMIT = 8;

/** Running agents first (each group keeps its incoming order), capped for the sidebar. */
export function sidebarAgents<T extends { running: boolean }>(agents: readonly T[], limit = SIDEBAR_AGENT_LIMIT): { shown: T[]; hidden: number } {
  const ordered = [...agents.filter((a) => a.running), ...agents.filter((a) => !a.running)];
  return { shown: ordered.slice(0, limit), hidden: Math.max(0, ordered.length - limit) };
}

export function teamSummary(nodes: readonly OrgNodeDto[]): string {
  const running = nodes.filter((n) => n.running).length;
  return `${nodes.length} agent · ${running} đang chạy`;
}
