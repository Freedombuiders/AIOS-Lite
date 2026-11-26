// Messages a Zalo nick sent today against its daily cap (GET /api/m/zalo/accounts/:id/usage, T05). Optional: a missing
// zalo module, a 404 or a bad answer just means "no number", the picker still works. Refetched on a stream tick, never on a timer.

import { useEffect, useState } from 'preact/hooks';
import { apiGet } from '@/lib/api';

export interface ZaloUsage { sentToday: number; cap: number | null }

export function parseUsage(raw: unknown): ZaloUsage | null {
  const r = raw as { sentToday?: unknown; cap?: unknown } | null;
  if (!r || typeof r.sentToday !== 'number' || !Number.isFinite(r.sentToday)) return null;
  return { sentToday: r.sentToday, cap: typeof r.cap === 'number' && Number.isFinite(r.cap) && r.cap > 0 ? r.cap : null };
}

export function useZaloUsage(accountId: string | null, tick: number): ZaloUsage | null {
  const [usage, setUsage] = useState<ZaloUsage | null>(null);
  useEffect(() => {
    if (!accountId) { setUsage(null); return undefined; }
    let live = true;
    apiGet<unknown>(`/api/m/zalo/accounts/${encodeURIComponent(accountId)}/usage`)
      .then((r) => { if (live) setUsage(parseUsage(r)); })
      .catch(() => { if (live) setUsage(null); });
    return () => { live = false; };
  }, [accountId, tick]);
  return usage;
}
