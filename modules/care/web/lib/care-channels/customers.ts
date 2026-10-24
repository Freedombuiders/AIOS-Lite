// Query + labels of the Khách hàng list. Pure.

import type { CareApiStage } from '@modules/care/server/api/dto';

export const STAGES: readonly CareApiStage[] = ['new', 'consulting', 'quoted', 'deposit', 'won', 'lost'];
export const CUSTOMERS_PAGE = 50;

/** The query string of GET /api/m/care/customers (empty filters are left out). */
export function customersQuery(p: { q?: string; stage?: '' | CareApiStage; cursor?: string | null; limit?: number }): string {
  const out = new URLSearchParams({ limit: String(p.limit ?? CUSTOMERS_PAGE) });
  const q = (p.q ?? '').trim();
  if (q) out.set('q', q);
  if (p.stage) out.set('stage', p.stage);
  if (p.cursor) out.set('cursor', p.cursor);
  return out.toString();
}

export type StageTone = 'won' | 'lost' | 'active' | 'plain';
export function stageTone(stage: CareApiStage): StageTone {
  return stage === 'won' ? 'won' : stage === 'lost' ? 'lost' : stage === 'new' ? 'plain' : 'active';
}

/** "hôm nay" / "hôm qua" / "3 ngày trước" / dd/MM, in Vietnamese. */
export function relativeDay(ms: number, nowMs: number): string {
  if (!ms) return '—';
  const days = Math.floor((nowMs - ms) / 86_400_000);
  if (days <= 0) return 'hôm nay';
  if (days === 1) return 'hôm qua';
  if (days < 7) return `${days} ngày trước`;
  return new Date(ms).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: '2-digit' });
}
