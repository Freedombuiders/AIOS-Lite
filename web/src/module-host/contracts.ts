// Web side of the module system. Each module ships modules/<id>/web/index.tsx:
//   export default defineWebModule({ id: 'care', nav: [...], routes: [...], widgets: [...], provides: {...} })
// The host loads every module's web entry with import.meta.glob and shows only the enabled ones (/api/modules).
import type { ComponentType } from 'preact';

export type NavGroup = 'studio' | 'sales' | 'marketing' | 'finance' | 'ops' | 'other';

export interface WebNavItem {
  group: NavGroup;
  label: string;
  /** absolute app path, should start with /m/<id> */
  path: string;
  /** lucide-preact icon component */
  icon?: ComponentType<any>;
  /** extra paths that mark this item active */
  match?: string[];
  order?: number;
  /** live counter shown as a badge (polled by the host) */
  badge?: () => Promise<number | undefined>;
}

export interface WebRoute {
  /** wouter pattern, e.g. '/m/care/inbox' or '/m/care/inbox/:id' */
  path: string;
  component: ComponentType<any>;
}

export interface WebWidget {
  /** where it renders */
  slot: 'dashboard';
  id: string;
  title?: string;
  component: ComponentType<any>;
  order?: number;
}

export interface WebAgentAccessScope {
  scope: string;
  label: string;
  description?: string;
}

export interface WebModuleDefinition {
  id: string;
  nav?: WebNavItem[];
  routes?: WebRoute[];
  widgets?: WebWidget[];
  /** labels for the agent "Quyền" tab (falls back to module.json scopes) */
  agentAccess?: WebAgentAccessScope[];
  /**
   * Named extension points other modules render, e.g.
   *   care renders useProvides('care.channelPanel') → zalo/gmail provide { 'care.channelPanel': ZaloPanel }
   */
  provides?: Record<string, unknown>;
}

export function defineWebModule(def: WebModuleDefinition): WebModuleDefinition {
  return def;
}
