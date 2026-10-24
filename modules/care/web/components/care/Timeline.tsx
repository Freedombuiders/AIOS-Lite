import { Loader2 } from 'lucide-preact';
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { MessageBubble } from './MessageBubble';
import { NoteRow } from './inbox/NoteRow';
import { OutboxChip } from './OutboxChip';
import { ct } from '@modules/care/web/lib/care/i18n';
import type { CareApiChannel, CareNoteDto, CareOutboxIntentDto } from '@modules/care/web/lib/care/dto';
import { mergeTimeline } from '@modules/care/web/lib/care/timeline';
import type { MessageWindow } from '@modules/care/web/lib/care/cursor';
import type { TrackedIntent } from '@modules/care/web/lib/care/intents';
import { dayKey } from '@modules/care/web/lib/care/messageView';
import type { ZaloProfiles } from '@modules/care/web/lib/care/zaloProfiles';

function dayLabel(ms: number): string {
  return new Date(ms).toLocaleDateString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
}

/**
 * Oldest-first timeline over a newest-first window. Keeps the reader's place: opening a search hit
 * scrolls to the hit, new tail messages follow only when the reader is already at the bottom, and
 * loading older history does not shift the view.
 */
export function Timeline({ window: w, channel, profiles, notes, busyNote, hitId, tracked, busyIntent, loadingOlder, loadingNewer, onLoadOlder, onLoadNewer, onCancel, onReconcile, onDeleteNote }: {
  window: MessageWindow;
  channel: CareApiChannel;
  /** Zalo names + avatars (null while loading or when unavailable). */
  profiles?: ZaloProfiles | null;
  /** Internal notes: merged in here at render time, never stored in the message window. */
  notes: CareNoteDto[];
  busyNote: string | null;
  onDeleteNote: (id: string) => void;
  hitId: string | null;
  tracked: TrackedIntent[];
  busyIntent: string | null;
  loadingOlder: boolean;
  loadingNewer: boolean;
  onLoadOlder: () => void;
  onLoadNewer: () => void;
  onCancel: (id: string) => void;
  onReconcile: (id: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(!hitId);
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const scrolledToHit = useRef<string | null>(null);

  const rows = mergeTimeline(w.items, notes, { hasOlder: w.olderCursor !== null, hasNewer: w.newerCursor !== null });
  const byMessage = new Map<string, CareOutboxIntentDto>();
  for (const t of tracked) if (t.intent.messageId) byMessage.set(t.intent.messageId, t.intent);
  const shownIds = new Set(w.items.map((m) => m.id));
  // Intents whose message is not in the window yet are shown as pending rows at the tail.
  const pending = tracked.filter((t) => !t.intent.messageId || !shownIds.has(t.intent.messageId));

  const newest = w.items[0]?.id ?? null;
  const lastNoteId = notes.length ? notes[notes.length - 1].id : null;
  const atLatestEnd = w.newerCursor === null;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (anchor.current) {
      // Older rows were prepended: keep the same message under the reader's eye.
      el.scrollTop = el.scrollHeight - anchor.current.height + anchor.current.top;
      anchor.current = null;
      return;
    }
    if (hitId && scrolledToHit.current !== hitId) {
      const target = el.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(hitId)}"]`);
      if (target) {
        scrolledToHit.current = hitId;
        stick.current = false;
        target.scrollIntoView({ block: 'center' });
        return;
      }
    }
    if (stick.current && atLatestEnd) el.scrollTop = el.scrollHeight;
  }, [newest, w.items.length, pending.length, hitId, atLatestEnd, notes.length, lastNoteId]);

  // A failed older-page load leaves no rows to anchor to; drop the stale anchor.
  useEffect(() => {
    if (!loadingOlder) anchor.current = null;
  }, [loadingOlder]);

  function onScroll(): void {
    const el = scroller.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  function loadOlder(): void {
    const el = scroller.current;
    if (el) anchor.current = { height: el.scrollHeight, top: el.scrollTop };
    onLoadOlder();
  }

  let lastDay = '';
  return (
    <div class="cc-timeline" ref={scroller} onScroll={onScroll} tabIndex={0} role="log" aria-label={ct('detail.timeline')} aria-relevant="additions" data-testid="care-timeline">
      {w.olderCursor && (
        <div class="care-timeline-edge">
          <button type="button" class="cc-button" disabled={loadingOlder} onClick={loadOlder} data-testid="care-load-older">
            {loadingOlder && <Loader2 size={12} class="animate-spin" aria-hidden="true" />} {loadingOlder ? ct('detail.olderLoading') : ct('detail.older')}
          </button>
        </div>
      )}
      {rows.length === 0 && pending.length === 0 && <div class="care-note">{ct('detail.empty')}</div>}
      {rows.map((row) => {
        const day = dayKey(row.atMs);
        const sep = day !== lastDay;
        lastDay = day;
        return (
          <div key={`${row.kind}:${row.id}`}>
            {sep && <div class="care-day" role="separator"><span>{dayLabel(row.atMs)}</span></div>}
            {row.kind === 'note' ? (
              <NoteRow note={row.note} busy={busyNote === row.id} onDelete={onDeleteNote} />
            ) : (
              <MessageBubble
                message={row.message}
                channel={channel}
                profiles={profiles}
                highlighted={row.id === hitId}
                intent={byMessage.get(row.id)}
                busy={busyIntent === byMessage.get(row.id)?.id}
                onCancel={onCancel}
                onReconcile={onReconcile}
              />
            )}
          </div>
        );
      })}
      {w.newerCursor && (
        <div class="care-timeline-edge">
          <button type="button" class="cc-button" disabled={loadingNewer} onClick={onLoadNewer}>
            {loadingNewer && <Loader2 size={12} class="animate-spin" aria-hidden="true" />} {ct('detail.newer')}
          </button>
        </div>
      )}
      {pending.map((t) => (
        <article key={t.intent.id} class="care-msg is-outgoing is-pending" data-testid="care-pending-message" data-intent-id={t.intent.id}>
          <div class="care-bubble">
            <header class="care-bubble-head"><span class="care-sender">{ct('outbox.pendingTitle')}</span></header>
            {t.text && <div class="care-text">{t.text}</div>}
            <footer class="care-bubble-foot">
              <OutboxChip intent={t.intent} busy={busyIntent === t.intent.id} onCancel={() => onCancel(t.intent.id)} onReconcile={() => onReconcile(t.intent.id)} />
            </footer>
          </div>
        </article>
      ))}
    </div>
  );
}
