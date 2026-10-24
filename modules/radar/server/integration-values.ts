/** Stored values of a module integration (Apify, RSSHub), read through the module SDK (ctx.integrations). */
import { moduleCompat } from '../../../src/modules/compat/index.js';

export type IntegrationValues = Record<string, string>;

type Loader = (id: string) => IntegrationValues | null;
let override: Loader | undefined;

/** Tests replace the loader; pass undefined to restore. */
export function setIntegrationLoader(fn: Loader | undefined): void { override = fn; }

export function loadIntegrationValues(id: string): IntegrationValues | null {
  if (override) return override(id);
  return moduleCompat('radar')?.integrations.values(id) ?? null;
}
