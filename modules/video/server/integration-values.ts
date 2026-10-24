// Reads the credentials the owner saved in Kết nối › Integrations through the module SDK.
import { moduleCtx } from './host.js';

export type IntegrationValues = Record<string, string>;

type Loader = (id: string) => IntegrationValues | null;
let override: Loader | undefined;

/** Tests replace the loader; pass undefined to restore. */
export function setIntegrationLoader(fn: Loader | undefined): void { override = fn; }

export function loadIntegrationValues(id: string): IntegrationValues | null {
  if (override) return override(id);
  return moduleCtx()?.integrations.values(id) ?? null;
}
