// Stable gate / policy reason codes -> operator wording. Unknown codes fall back to the code itself.

import { ct } from './i18n';

export function reasonText(reason: string | undefined | null): string | null {
  if (!reason || !/^[A-Z][A-Z0-9_]{1,63}$/.test(reason)) return null;
  const key = `reason.${reason}`;
  const v = ct(key);
  return v === key ? null : v;
}
