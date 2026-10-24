import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { apiGet, errorText } from './api';
import { onSseReconnect } from './sse';

export interface FetchState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

const cache = new Map<string, unknown>();

export function invalidateFetchCache(prefix?: string): void {
  if (!prefix) return cache.clear();
  for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k);
}

/** GET `path` (null = idle). Shows cached data first, refreshes in the background, optional polling. */
export function useFetch<T = unknown>(path: string | null, pollMs = 0): FetchState<T> {
  const [data, setData] = useState<T | null>(path && cache.has(path) ? (cache.get(path) as T) : null);
  const [loading, setLoading] = useState(path !== null && !cache.has(path));
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (path === null) {
      setData(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    if (!cache.has(path)) setLoading(true);
    else setData(cache.get(path) as T);
    apiGet<T>(path)
      .then((d) => {
        if (cancelled) return;
        cache.set(path, d);
        setData(d);
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(errorText(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, tick]);

  useEffect(() => {
    if (!pollMs || path === null) return;
    const t = setInterval(() => setTick((n) => n + 1), pollMs);
    return () => clearInterval(t);
  }, [pollMs, path]);

  useEffect(() => onSseReconnect(() => setTick((n) => n + 1)), []);

  const refresh = useCallback(() => {
    if (path) cache.delete(path);
    setTick((n) => n + 1);
  }, [path]);

  return { data, loading, error, refresh };
}
