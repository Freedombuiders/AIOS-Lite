import { signal, computed } from '@preact/signals';
import en from '../locales/en.json';
import vi from '../locales/vi.json';

export type Locale = 'en' | 'vi';

const DICTIONARIES: Record<Locale, Record<string, any>> = { en, vi };
const STORAGE_KEY = 'aios.locale';

function resolveInitialLocale(): Locale {
  if (typeof window === 'undefined') return 'vi';
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'en' || stored === 'vi') return stored;
    // AIOS-Lite is Vietnamese-first: English only when chosen explicitly.
  } catch {
    // Ignore storage access errors
  }
  return 'vi';
}

const initialLocale = resolveInitialLocale();
if (typeof document !== 'undefined') {
  document.documentElement.lang = initialLocale;
}

export const currentLocale = signal<Locale>(initialLocale);

export function setLocale(next: Locale): void {
  if (next !== 'en' && next !== 'vi') return;
  currentLocale.value = next;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
      document.documentElement.lang = next;
    } catch {
      // Ignore storage errors
    }
  }
}

export function toggleLocale(): Locale {
  const next: Locale = currentLocale.value === 'en' ? 'vi' : 'en';
  setLocale(next);
  return next;
}

export function t(key: string, params?: Record<string, string | number>): string {
  // Re-read currentLocale.value to establish signal dependency for reactivity
  const loc = currentLocale.value;
  const dict = DICTIONARIES[loc] || DICTIONARIES.en;

  const getFromDict = (source: Record<string, any>, path: string) => {
    return path.split('.').reduce((acc: any, part) => (acc && acc[part] !== undefined ? acc[part] : undefined), source);
  };

  let val = getFromDict(dict, key);
  if (val === undefined && loc !== 'en') {
    val = getFromDict(DICTIONARIES.en, key);
  }
  if (val === undefined) {
    val = key;
  }

  if (typeof val !== 'string') return String(val ?? key);

  if (params) {
    for (const [k, v] of Object.entries(params)) {
      val = val.replaceAll(`{${k}}`, String(v));
    }
  }

  return val;
}
