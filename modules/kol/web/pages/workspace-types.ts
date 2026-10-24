import type { KolStatusDto, PersonaDto } from '@modules/kol/web/lib/kol';

export type WorkspaceTab = 'overview' | 'profile' | 'studio' | 'gallery' | 'video' | 'content' | 'channels' | 'growth';

/** Props every /kol/:id tab receives. */
export interface WorkspaceTabProps {
  persona: PersonaDto;
  status: KolStatusDto | null;
  /** Re-fetch the persona (after PATCH, ref changes…). */
  refreshPersona: () => void;
  /** Switch tab; `extra` query params pre-fill the target tab. */
  go: (tab: WorkspaceTab, extra?: Record<string, string>, replace?: boolean) => void;
  /** Current query string (tab-specific params like asset=, post=, new=). */
  query: URLSearchParams;
}
