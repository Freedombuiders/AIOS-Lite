// The customer panel is a persistent right column from 1280px up (the owner can hide it; the choice is remembered in this
// browser) and an on-demand drawer below that (closed on every conversation change, never remembered).

import { useEffect, useState } from 'preact/hooks';

export const WIDE_QUERY = '(min-width: 1280px)';
export const PANEL_STORAGE_KEY = 'claudeclaw.care.customerPanel';

function storage(): Storage | null {
  try { return typeof window !== 'undefined' ? window.localStorage : null; } catch { return null; }
}

/** Stored choice, or open by default on a wide screen. */
export function initialWideOpen(stored: string | null): boolean {
  return stored !== 'closed';
}

export function useMediaQuery(query: string): boolean {
  const get = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false);
  const [on, setOn] = useState(get);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia(query);
    const h = () => setOn(mq.matches);
    h();
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, [query]);
  return on;
}

export function useCustomerPanel() {
  const wide = useMediaQuery(WIDE_QUERY);
  const [wideOpen, setWideOpen] = useState(() => initialWideOpen(storage()?.getItem(PANEL_STORAGE_KEY) ?? null));
  const [drawerOpen, setDrawerOpen] = useState(false);
  const open = wide ? wideOpen : drawerOpen;
  function toggle(): void {
    if (wide) {
      const next = !wideOpen;
      setWideOpen(next);
      try { storage()?.setItem(PANEL_STORAGE_KEY, next ? 'open' : 'closed'); } catch { /* blocked storage */ }
    } else {
      setDrawerOpen((o) => !o);
    }
  }
  function close(): void {
    if (wide) { setWideOpen(false); try { storage()?.setItem(PANEL_STORAGE_KEY, 'closed'); } catch { /* ignore */ } } else setDrawerOpen(false);
  }
  return { wide, open, toggle, close };
}
