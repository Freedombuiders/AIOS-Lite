// Pure merge logic for cursor-paged lists. The server owns ordering and cursors; the client only
// dedupes (a row can move between pages while the user scrolls) and keeps the server order.

import type { CareConversationDto, CareMessageDto, CareMessagePageDto } from './dto';

// ── conversations ─────────────────────────────────────────────────────────────────────────────
/** Server order: last activity desc, then id desc. */
export function compareConversations(a: CareConversationDto, b: CareConversationDto): number {
  if (a.lastActivityMs !== b.lastActivityMs) return b.lastActivityMs - a.lastActivityMs;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export interface ConversationListState {
  items: CareConversationDto[];
  nextCursor: string | null;
}

export function emptyList(): ConversationListState {
  return { items: [], nextCursor: null };
}

/** First page replaces the head. Rows already loaded beyond it stay, so a refresh keeps scroll depth. */
export function mergeHead(state: ConversationListState, page: { items: CareConversationDto[]; nextCursor: string | null }): ConversationListState {
  const headIds = new Set(page.items.map((c) => c.id));
  const oldest = page.items.length ? page.items[page.items.length - 1] : null;
  // Only keep rows that sort AFTER the refreshed head; anything newer that is missing from it left the filter.
  const tail = oldest ? state.items.filter((c) => !headIds.has(c.id) && compareConversations(oldest, c) < 0) : [];
  const items = [...page.items, ...tail];
  return { items, nextCursor: tail.length ? state.nextCursor : page.nextCursor };
}

export function appendPage(state: ConversationListState, page: { items: CareConversationDto[]; nextCursor: string | null }): ConversationListState {
  const seen = new Set(state.items.map((c) => c.id));
  const fresh = page.items.filter((c) => !seen.has(c.id));
  return { items: [...state.items, ...fresh], nextCursor: page.nextCursor };
}

export function replaceConversation(state: ConversationListState, next: CareConversationDto): ConversationListState {
  if (!state.items.some((c) => c.id === next.id)) return state;
  return { ...state, items: state.items.map((c) => (c.id === next.id ? next : c)) };
}

/**
 * True when the SSE snapshot knows a conversation the loaded list is behind on (newer revision, or
 * active after the oldest loaded row but missing). Used once per snapshot to close the gap between
 * the first list fetch and the stream attaching.
 */
export function snapshotIsAhead(
  loaded: CareConversationDto[],
  snapshot: Array<{ id: string; revision: number; lastActivityMs: number }>,
  hasMore: boolean,
): boolean {
  if (snapshot.length === 0) return false;
  const byId = new Map(loaded.map((c) => [c.id, c]));
  const floor = loaded.length && hasMore ? loaded[loaded.length - 1].lastActivityMs : -Infinity;
  for (const row of snapshot) {
    const have = byId.get(row.id);
    if (have) {
      if (row.revision > have.revision) return true;
    } else if (row.lastActivityMs >= floor) {
      // Missing but would sort inside the loaded range -> new (or newly matching, which a filter may hide: one refetch).
      return true;
    }
  }
  return false;
}

// ── messages ──────────────────────────────────────────────────────────────────────────────────
/** Server order: sent time desc, then id desc (newest first). */
export function compareMessages(a: CareMessageDto, b: CareMessageDto): number {
  if (a.sentAtMs !== b.sentAtMs) return b.sentAtMs - a.sentAtMs;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export interface MessageWindow {
  /** Newest first. */
  items: CareMessageDto[];
  olderCursor: string | null;
  /** Null when the window reaches the newest message. */
  newerCursor: string | null;
  aroundId: string | null;
}

export function emptyWindow(): MessageWindow {
  return { items: [], olderCursor: null, newerCursor: null, aroundId: null };
}

function union(a: CareMessageDto[], b: CareMessageDto[]): CareMessageDto[] {
  const byId = new Map<string, CareMessageDto>();
  for (const m of a) byId.set(m.id, m);
  for (const m of b) byId.set(m.id, m); // later copy wins: edits replace the stale body
  return [...byId.values()].sort(compareMessages);
}

export function windowFromPage(page: CareMessagePageDto): MessageWindow {
  return { items: [...page.items].sort(compareMessages), olderCursor: page.olderCursor, newerCursor: page.newerCursor, aroundId: page.aroundId };
}

export function mergeOlder(w: MessageWindow, page: CareMessagePageDto): MessageWindow {
  return { ...w, items: union(w.items, page.items), olderCursor: page.olderCursor };
}

export function mergeNewer(w: MessageWindow, page: CareMessagePageDto): MessageWindow {
  return { ...w, items: union(w.items, page.items), newerCursor: page.newerCursor };
}

export type LatestMerge = { window: MessageWindow; behind: boolean };

/**
 * Applies a fresh "newest page" fetch. When the window already reaches the newest end the page is
 * merged in. A window opened around an older hit is NOT moved: `behind` tells the UI to offer a
 * jump instead of yanking the reader. A page that does not overlap the window would leave a hole,
 * so it replaces the window (the older history stays reachable through olderCursor).
 */
export function mergeLatest(w: MessageWindow, page: CareMessagePageDto): LatestMerge {
  if (w.items.length === 0) return { window: windowFromPage(page), behind: false };
  if (w.newerCursor !== null) {
    const knows = page.items.every((m) => w.items.some((x) => x.id === m.id));
    return { window: w, behind: !knows };
  }
  const overlaps = page.items.some((m) => w.items.some((x) => x.id === m.id));
  if (!overlaps && page.items.length > 0) return { window: windowFromPage(page), behind: false };
  return { window: { ...w, items: union(w.items, page.items), newerCursor: null, aroundId: null }, behind: false };
}
