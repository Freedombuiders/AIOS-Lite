/**
 * Provider registry: the four adapters, their models, configured state and the
 * default model per kind. Tests swap adapters with _setProviderAdapterForTests.
 */

import { loadSettings } from '../core.js';
import type { ModelInfo, ModelKind, ProviderId, ProviderStatusDto } from '../types.js';
import { chatgptAdapter } from './chatgpt.js';
import { falAdapter } from './fal.js';
import { geminiAdapter } from './gemini.js';
import { higgsfieldAdapter } from './higgsfield.js';
import type { ProviderAdapter } from './types.js';

const BUILTIN: Record<ProviderId, ProviderAdapter> = {
  gemini: geminiAdapter,
  chatgpt: chatgptAdapter,
  fal: falAdapter,
  higgsfield: higgsfieldAdapter,
};
const ORDER: ProviderId[] = ['gemini', 'chatgpt', 'fal', 'higgsfield'];

const overrides: Partial<Record<ProviderId, ProviderAdapter>> = {};

/** @internal tests only: replace (or with null, restore) one provider's adapter. */
export function _setProviderAdapterForTests(id: ProviderId, adapter: ProviderAdapter | null): void {
  if (adapter) overrides[id] = adapter;
  else delete overrides[id];
}

export function getAdapter(id: ProviderId): ProviderAdapter {
  return overrides[id] ?? BUILTIN[id];
}

function safeConfigured(a: ProviderAdapter): boolean {
  try { return a.configured(); } catch { return false; }
}

export function isProviderConfigured(id: ProviderId): boolean {
  return safeConfigured(getAdapter(id));
}

export function allModels(): ModelInfo[] {
  return ORDER.flatMap((id) => getAdapter(id).models());
}

export function findModel(id: string): ModelInfo | null {
  if (!id) return null;
  return allModels().find((m) => m.id === id) ?? null;
}

/**
 * Default model for a kind: the studio setting when it names a known model of that
 * kind, else the recommended model of the first configured provider (Gemini, fal,
 * Higgsfield), else any recommended model (the request then answers 412).
 */
export function defaultModel(kind: ModelKind): ModelInfo | null {
  let settings: { defaultImageModel: string; defaultVideoModel: string } | null = null;
  try { settings = loadSettings(); } catch { /* no database yet */ }
  const preferred = kind === 'image' ? settings?.defaultImageModel : kind === 'video' ? settings?.defaultVideoModel : '';
  if (preferred) {
    const m = findModel(preferred);
    if (m && m.kind === kind) return m;
  }
  const ofKind = (id: ProviderId) => getAdapter(id).models().filter((m) => m.kind === kind);
  for (const id of ORDER) {
    if (!isProviderConfigured(id)) continue;
    const list = ofKind(id);
    const pick = list.find((m) => m.recommended) ?? list[0];
    if (pick) return pick;
  }
  for (const id of ORDER) {
    const list = ofKind(id);
    const pick = list.find((m) => m.recommended) ?? list[0];
    if (pick) return pick;
  }
  return null;
}

export function providerStatuses(): ProviderStatusDto[] {
  return ORDER.map((id) => {
    const a = getAdapter(id);
    const kindRank: Record<ModelKind, number> = { image: 0, video: 1, lipsync: 2 };
    const models = [...a.models()].sort((x, y) => kindRank[x.kind] - kindRank[y.kind] || Number(Boolean(y.recommended)) - Number(Boolean(x.recommended)));
    return { id, label: a.label, configured: safeConfigured(a), hint: a.hint, models };
  });
}
