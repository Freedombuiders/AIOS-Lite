/**
 * Vietnamese number formatting for recommendation reasons ("195k", "4,3 tr",
 * "1,63×"). Pure; the UI formats its own numbers, this is only for sentences
 * the backend writes.
 */

const trim = (n: number, digits: number): string => String(Number(n.toFixed(digits))).replace('.', ',');

/** Money in the ad account currency. VND: 195k, 4,3 tr, 1,2 tỷ. Others: 12,34 USD. */
export function fmtMoney(n: number, currency: string, digits = 1): string {
  if (currency.toUpperCase() !== 'VND') {
    return `${trim(n, Math.abs(n) >= 100 ? 0 : 2)} ${currency}`;
  }
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${trim(n / 1e9, digits)} tỷ`;
  if (abs >= 1e6) return `${trim(n / 1e6, digits)} tr`;
  if (abs >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

/** Ratio to the target: 1,63× (two decimals under 10, none above). */
export function fmtRatio(r: number): string {
  return `${trim(r, r >= 10 ? 0 : 2)}×`;
}

/** A 0–100 percentage: 0,8%. */
export function fmtPct(p: number, digits = 1): string {
  return `${trim(p, digits)}%`;
}

export function fmtNum(n: number, digits = 1): string {
  return trim(n, digits);
}
