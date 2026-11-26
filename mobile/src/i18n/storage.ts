import { storageGet, storageSet } from '@/lib/safe-storage';
import type { Lang } from './index';

const KEY = 'agenticos.lang';

export async function loadLanguage(): Promise<Lang | null> {
  const v = await storageGet(KEY);
  return v === 'vi' || v === 'en' ? v : null;
}

export const saveLanguage = (lang: Lang) => storageSet(KEY, lang);
