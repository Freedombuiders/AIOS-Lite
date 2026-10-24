/**
 * The production service of the running app, reachable from the approval handler and the director's
 * per-turn MCP gateway (both run in the main process, outside the route closure).
 */

import path from 'node:path';

import type { ProductionService } from './service.js';

const services = new Map<string, ProductionService>();

export function bindProductionService(root: string, service: ProductionService): void {
  services.set(path.resolve(root), service);
}

/** The service for a Video Studio root; the default root when only one app runs. */
export function productionServiceFor(root?: string): ProductionService | null {
  if (root) return services.get(path.resolve(root)) ?? null;
  return services.size ? [...services.values()][services.size - 1] : null;
}

export function _clearProductionServicesForTests(): void {
  services.clear();
}
