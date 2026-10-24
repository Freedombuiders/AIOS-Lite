/** Shared helpers for the core tests (never imported by production code). */

import { getFbPage, insertFbContent, updateFbPageFields, upsertFbPageFromSync, type FbContentRow } from '../store.js';
import { localDayKey, parseLocalDateTime } from './time.js';

export const VN = 'Asia/Ho_Chi_Minh';

/** Creates an enabled, ACTIVE Page with the default rules (3/day, 180 min gap, 07:00–22:00 Vietnam time). */
export function makePage(id = 'p1', patch: Record<string, unknown> = {}): void {
  upsertFbPageFromSync({ id, name: `Page ${id}`, connection_id: `ca_${id}`, entity_id: 'ent1', picture_url: '', followers: null });
  updateFbPageFields(id, { enabled: 1, ...patch });
  if (!getFbPage(id)) throw new Error('page not created');
}

/** Unix seconds for `HH:MM` Vietnam time on the day `daysAhead` days from now. */
export function futureAt(daysAhead: number, hm: string, now: number = Math.floor(Date.now() / 1000)): number {
  const day = localDayKey(now + daysAhead * 86400, VN);
  return parseLocalDateTime(`${day} ${hm}`, VN) as number;
}

/** Inserts a text post directly (bypasses the service) in the given state. */
export function seedContent(patch: Partial<Omit<FbContentRow, 'id' | 'created_at' | 'updated_at'>> = {}): number {
  return insertFbContent({ page_id: 'p1', title: 'T', caption: 'Nội dung', format: 'text', status: 'draft', ...patch });
}
