import { useCallback, useEffect, useState } from 'preact/hooks';
import { errorText } from '@/lib/api';
import type { CrmApi, CrmStatus, CustomerRowDto } from './types';

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  reload: () => void;
  set: (updater: (cur: T) => T) => void;
}

function useLoad<T>(load: () => Promise<T>, deps: unknown[]): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    load()
      .then((d) => { if (live) { setData(d); setError(null); } })
      .catch((e) => { if (live) setError(errorText(e)); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  const reload = useCallback(() => setN((x) => x + 1), []);
  const set = useCallback((updater: (cur: T) => T) => setData((cur) => (cur === null ? cur : updater(cur))), []);
  return { data, error, reload, set };
}

export const useCustomerList = (api: CrmApi): Loaded<CustomerRowDto[]> => useLoad(() => api.customers(), [api]);

/** Status never blocks a screen: a failure just means "no banner". */
export function useCrmStatus(api: CrmApi): CrmStatus | null {
  const [s, setS] = useState<CrmStatus | null>(null);
  useEffect(() => {
    let live = true;
    api.status().then((v) => { if (live) setS(v); }).catch(() => undefined);
    return () => { live = false; };
  }, [api]);
  return s;
}
