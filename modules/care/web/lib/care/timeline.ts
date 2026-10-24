// The conversation timeline = messages (from the paged window) + internal notes, merged at render time.
// Notes never enter the MessageWindow: the window is cursor-paged server data, notes are a separate list.

import type { CareMessageDto, CareNoteDto } from './dto';

export type TimelineRow =
  | { kind: 'message'; id: string; atMs: number; message: CareMessageDto }
  | { kind: 'note'; id: string; atMs: number; note: CareNoteDto };

/**
 * Oldest first. Messages keep their order; a note sits after every message sent at or before it.
 * While the window does not reach the oldest/newest end, notes outside the loaded span are held back so
 * they do not float above "load older" or below "load newer" with no context.
 */
export function mergeTimeline(
  messagesNewestFirst: CareMessageDto[],
  notes: CareNoteDto[],
  edges: { hasOlder: boolean; hasNewer: boolean },
): TimelineRow[] {
  const messages = [...messagesNewestFirst].sort((a, b) => a.sentAtMs - b.sentAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const oldest = messages[0]?.sentAtMs ?? null;
  const newest = messages[messages.length - 1]?.sentAtMs ?? null;
  const visibleNotes = notes
    .filter((n) => (oldest === null ? true : !(edges.hasOlder && n.createdAtMs < oldest) && !(edges.hasNewer && newest !== null && n.createdAtMs > newest)))
    .sort((a, b) => a.createdAtMs - b.createdAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const rows: TimelineRow[] = [];
  let n = 0;
  for (const m of messages) {
    while (n < visibleNotes.length && visibleNotes[n].createdAtMs < m.sentAtMs) {
      rows.push({ kind: 'note', id: visibleNotes[n].id, atMs: visibleNotes[n].createdAtMs, note: visibleNotes[n] });
      n += 1;
    }
    rows.push({ kind: 'message', id: m.id, atMs: m.sentAtMs, message: m });
  }
  for (; n < visibleNotes.length; n += 1) rows.push({ kind: 'note', id: visibleNotes[n].id, atMs: visibleNotes[n].createdAtMs, note: visibleNotes[n] });
  return rows;
}
