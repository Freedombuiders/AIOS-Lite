// Care strings live in locales/{en,vi}.json under `care.*`. Both dictionaries carry the full set; the
// Vietnamese fallback below is only a safety net for a key that was just added to vi.json and not yet
// translated, so the UI never prints the raw key.

import { t } from '@/lib/i18n';
import vi from '@/locales/vi.json';

function lookup(dict: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, part) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined), dict);
}

export function ct(key: string, params?: Record<string, string | number>): string {
  const full = `care.${key}`;
  const translated = t(full, params);
  if (translated !== full) return translated;
  const fallback = lookup(vi as unknown as Record<string, unknown>, full);
  if (typeof fallback !== 'string') return key;
  let out = fallback;
  if (params) for (const [k, v] of Object.entries(params)) out = out.replaceAll(`{${k}}`, String(v));
  return out;
}
