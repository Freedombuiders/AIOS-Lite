// Strings of the "Kênh & agent", Khách hàng and Công việc screens live under `care.channels2.*` (and `nav.careHub.*`)
// in locales/{vi,en}.json.

import { t } from '@/lib/i18n';

/** Full-path lookup (`care.channels2.title`, `nav.careHub.inbox`). */
export function fragmentT(path: string, params?: Record<string, string | number>): string {
  return t(path, params);
}

/** Short form for the channels screens: `cc('title')` reads `care.channels2.title`. */
export function cc(key: string, params?: Record<string, string | number>): string {
  const full = `care.channels2.${key}`;
  const out = fragmentT(full, params);
  return out === full ? key : out;
}
