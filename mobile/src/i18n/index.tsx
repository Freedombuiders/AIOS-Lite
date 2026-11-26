import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { loadLanguage, saveLanguage } from './storage';
import { en } from './en';
import { vi, type MessageKey, type Messages } from './vi';

export type Lang = 'vi' | 'en';
export const LANGS: readonly Lang[] = ['vi', 'en'];
export const DEFAULT_LANG: Lang = 'vi';
export type { MessageKey };

const catalogs: Record<Lang, Messages> = { vi, en };

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

export function translate(lang: Lang, key: MessageKey, vars?: Record<string, string | number>): string {
  const text = catalogs[lang][key] ?? vi[key];
  return vars ? text.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m)) : text;
}

interface I18n {
  lang: Lang;
  t: Translate;
  setLang: (lang: Lang) => void;
}

const I18nContext = createContext<I18n | null>(null);

/** Vietnamese until the saved choice (if any) is read. `initialLang` skips the read, for tests. */
export function I18nProvider({ children, initialLang }: { children: ReactNode; initialLang?: Lang }) {
  const [lang, setLangState] = useState<Lang>(initialLang ?? DEFAULT_LANG);
  useEffect(() => {
    if (initialLang) return;
    let live = true;
    void loadLanguage().then((saved) => { if (live && saved) setLangState(saved); });
    return () => { live = false; };
  }, [initialLang]);
  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    void saveLanguage(next);
  }, []);
  const value = useMemo<I18n>(() => ({ lang, setLang, t: (key, vars) => translate(lang, key, vars) }), [lang, setLang]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n needs an I18nProvider');
  return ctx;
}

export const useT = () => useI18n().t;
