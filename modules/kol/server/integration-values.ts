// Reads the credentials the owner saved in Kết nối › Integrations (fal, Higgsfield, ElevenLabs) through the module SDK.
import { moduleCompat } from './compat.js';

export type IntegrationValues = Record<string, string>;

let override: ((id: string) => IntegrationValues | null) | null = null;

/** @internal tests only. */
export function _setIntegrationValuesForTests(fn: ((id: string) => IntegrationValues | null) | null): void {
  override = fn;
}

export function loadIntegrationValues(id: string): IntegrationValues | null {
  if (override) return override(id);
  return moduleCompat('kol')?.integrations.values(id) ?? null;
}
