// Inbox filter state and the query strings it maps to (/api/m/care/conversations, /api/m/care/search).

import type { CareApiChannel, CareInboxView, CareWorkflowStatus } from './dto';
import { DEFAULT_STATUS, DEFAULT_VIEW } from './inboxView';

export const MIN_QUERY = 2;
export const PAGE_SIZE = 40;

export interface InboxFilters {
  channel: '' | CareApiChannel;
  accountId: string;
  unread: boolean;
  /** Status tab: Mở / Chờ khách / Hoãn / Xong (`wf=`). */
  wf: CareWorkflowStatus;
  /** Who handles it: Cần tôi / AI đang lo / Chưa giao / Tất cả (`view=`). */
  view: CareInboxView;
  q: string;
}

export const EMPTY_FILTERS: InboxFilters = { channel: '', accountId: '', unread: false, wf: DEFAULT_STATUS, view: DEFAULT_VIEW, q: '' };

/** Text filters under MIN_QUERY characters are ignored: the search endpoint rejects them anyway. */
export function effectiveQuery(q: string): string {
  const t = q.trim();
  return t.length >= MIN_QUERY ? t : '';
}

/**
 * While a text query is active the status and view tabs are NOT sent: a search looks through every status (a customer
 * who is "Xong" must still be found), and the tab counters are not exact then anyway (`inboxCounts: null`).
 */
export function conversationQuery(f: InboxFilters, cursor?: string | null, limit = PAGE_SIZE): string {
  const p = new URLSearchParams();
  const q = effectiveQuery(f.q);
  if (!q) {
    p.set('wf', f.wf);
    p.set('view', f.view);
  }
  if (f.channel) p.set('channel', f.channel);
  if (f.accountId) p.set('account', f.accountId);
  if (f.unread) p.set('unread', '1');
  if (q) p.set('q', q);
  if (cursor) p.set('cursor', cursor);
  p.set('limit', String(limit));
  return p.toString();
}

export function searchQuery(f: InboxFilters, cursor?: string | null, limit = 20): string {
  const p = new URLSearchParams();
  p.set('q', effectiveQuery(f.q));
  if (f.accountId) p.set('account', f.accountId);
  if (cursor) p.set('cursor', cursor);
  p.set('limit', String(limit));
  return p.toString();
}

/** Identity of a filter set: a change resets paging and drops cursors minted for the old set. */
export function filterKey(f: InboxFilters): string {
  const q = effectiveQuery(f.q);
  // Tabs do not matter while searching, so flipping one then does not refetch.
  return JSON.stringify([f.channel, f.accountId, f.unread, q ? '' : f.wf, q ? '' : f.view, q]);
}

/** Anything beyond the defaults (status Mở, view Tất cả, no channel/account/unread/search). */
export function hasActiveFilters(f: InboxFilters): boolean {
  return filterKey(f) !== filterKey(EMPTY_FILTERS);
}

/** Channel/account/unread/search only: what "Xóa bộ lọc" resets (the tabs are navigation, not filters). */
export function hasExtraFilters(f: InboxFilters): boolean {
  return Boolean(f.channel || f.accountId || f.unread || effectiveQuery(f.q));
}

/** Channel -> account choices: an account of another channel cannot stay selected. */
export function reconcileAccount(f: InboxFilters, accounts: Array<{ id: string; channel: CareApiChannel }>): InboxFilters {
  if (!f.accountId) return f;
  const acc = accounts.find((a) => a.id === f.accountId);
  if (!acc || (f.channel && acc.channel !== f.channel)) return { ...f, accountId: '' };
  return f;
}
