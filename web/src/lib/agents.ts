import { seedAgentNames } from './format';
import type { AgentLoadError, AgentSummary } from './api-types';
import { useFetch } from './useFetch';
import { useEvents } from './sse';

/** Agent list with names seeded for resolveAgentName; refetches when runs change. */
export function useAgents() {
  const f = useFetch<{ items: AgentSummary[]; errors: AgentLoadError[] }>('/agents');
  useEvents(['run'], () => f.refresh());
  if (f.data) seedAgentNames(f.data.items);
  return { ...f, agents: f.data?.items ?? [], loadErrors: f.data?.errors ?? [] };
}
