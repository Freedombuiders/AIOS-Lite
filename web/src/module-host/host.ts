// Loads every modules/<id>/web/index.tsx at build time, then exposes only the enabled ones.
import { computed, signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import { apiGet } from '@/lib/api';
import type { ModuleInfo } from '@/lib/api-types';
import { onSseReconnect, subscribeEvents } from '@/lib/sse';
import type { WebAgentAccessScope, WebModuleDefinition, WebNavItem, WebRoute, WebWidget } from './contracts';

const loaded = import.meta.glob<{ default: WebModuleDefinition }>('@modules/*/web/index.tsx', { eager: true });

/** All bundled web modules by id (enabled or not). */
export const bundledModules: Record<string, WebModuleDefinition> = {};
for (const [file, mod] of Object.entries(loaded)) {
  const def = mod?.default;
  if (def?.id) bundledModules[def.id] = def;
  else console.warn(`[module-host] ${file} has no default defineWebModule export`);
}

export const moduleInfos = signal<ModuleInfo[]>([]);
export const modulesLoaded = signal(false);
export const modulesError = signal<string | null>(null);

export async function refreshModules(): Promise<void> {
  try {
    const res = await apiGet<{ items: ModuleInfo[] }>('/modules');
    moduleInfos.value = res.items;
    modulesError.value = null;
  } catch (e) {
    modulesError.value = e instanceof Error ? e.message : String(e);
  } finally {
    modulesLoaded.value = true;
  }
}

let started = false;
export function startModuleHost(): void {
  if (started) return;
  started = true;
  void refreshModules();
  subscribeEvents((e) => {
    if (e.type === 'module') void refreshModules();
  });
  onSseReconnect(() => void refreshModules());
}

export const enabledIds = computed(() => new Set(moduleInfos.value.filter((m) => m.state.enabled).map((m) => m.manifest.id)));

export const enabledWebModules = computed<WebModuleDefinition[]>(() =>
  Object.values(bundledModules).filter((m) => enabledIds.value.has(m.id)),
);

export interface HostNavItem extends WebNavItem {
  moduleId: string;
}

export const navItems = computed<HostNavItem[]>(() =>
  enabledWebModules.value
    .flatMap((m) => (m.nav ?? []).map((n) => ({ ...n, moduleId: m.id })))
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100)),
);

export const routes = computed<WebRoute[]>(() => enabledWebModules.value.flatMap((m) => m.routes ?? []));

export const widgets = computed<WebWidget[]>(() =>
  enabledWebModules.value.flatMap((m) => m.widgets ?? []).sort((a, b) => (a.order ?? 100) - (b.order ?? 100)),
);

/** Labels for an enabled module's scopes: web definition first, then module.json. */
export function scopeLabels(info: ModuleInfo): WebAgentAccessScope[] {
  const web = bundledModules[info.manifest.id]?.agentAccess;
  if (web?.length) return web;
  return Object.entries(info.manifest.scopes ?? {}).map(([scope, label]) => ({ scope, label }));
}

/** Values other enabled modules provide under `key` (e.g. 'care.channelPanel'). */
export function useProvides<T = unknown>(key: string): T[] {
  // Subscribing to the signal re-renders callers when modules are added or removed.
  const mods = enabledWebModules.value;
  const out: T[] = [];
  for (const m of mods) {
    const v = m.provides?.[key];
    if (v !== undefined) out.push(v as T);
  }
  return out;
}

/** Poll a module nav badge while it is shown. */
export function useBadge(item: HostNavItem): number | undefined {
  const [n, setN] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (!item.badge) return;
    let alive = true;
    const run = () =>
      item
        .badge!()
        .then((v) => alive && setN(v))
        .catch(() => undefined);
    void run();
    const t = setInterval(run, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.path]);
  return n;
}
