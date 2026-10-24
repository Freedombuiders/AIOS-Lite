// KOL Studio enforces its own daily/monthly caps (settings). AIOS-Lite has no shared budget policy table,
// so admission here always passes; the helpers keep the call sites unchanged.
export interface WindowBounds { start: number; end: number }
export type BudgetWindow = 'day' | 'month';

/** Local-time day or month window around `nowMs`, in unix seconds. */
export function windowBounds(window: BudgetWindow, nowMs = Date.now()): WindowBounds {
  const d = new Date(nowMs);
  const start = window === 'day' ? new Date(d.getFullYear(), d.getMonth(), d.getDate()) : new Date(d.getFullYear(), d.getMonth(), 1);
  const end = window === 'day' ? new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1) : new Date(d.getFullYear(), d.getMonth() + 1, 1);
  return { start: Math.floor(start.getTime() / 1000), end: Math.floor(end.getTime() / 1000) };
}

export type BudgetAdmission = { allowed: true } | { allowed: false; error: { message: string } };

export function checkBudgetAdmission(_agentId: string, _nowMs = Date.now()): BudgetAdmission {
  return { allowed: true };
}
