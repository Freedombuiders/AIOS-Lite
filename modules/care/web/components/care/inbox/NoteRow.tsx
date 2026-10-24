import { NotebookPen, Trash2 } from 'lucide-preact';
import { clockTime, fullTime } from '@modules/care/web/lib/care/timeFormat';
import { ct } from '@modules/care/web/lib/care/i18n';
import type { CareNoteDto } from '@modules/care/web/lib/care/dto';

/** An internal note in the timeline: amber and dashed, "customer cannot see it". Not part of the message window. */
export function NoteRow({ note, busy, onDelete }: { note: CareNoteDto; busy: boolean; onDelete: (id: string) => void }) {
  return (
    <article class="care-msg is-outgoing is-note" data-note-id={note.id} data-testid="care-note" aria-label={`${ct('inbox2.note.rowLabel')}, ${fullTime(note.createdAtMs)}`}>
      <div class="care-bubble care-note-bubble">
        <header class="care-bubble-head">
          <span class="care-sender"><NotebookPen size={12} aria-hidden="true" /> {ct('inbox2.note.rowHead')}</span>
          <time class="care-faint" dateTime={new Date(note.createdAtMs).toISOString()} title={fullTime(note.createdAtMs)}>{clockTime(note.createdAtMs)}</time>
        </header>
        <div class="care-text">{note.body}</div>
        <footer class="care-bubble-foot">
          <button type="button" class="care-link-button" disabled={busy} onClick={() => onDelete(note.id)} data-testid="care-note-delete">
            <Trash2 size={11} aria-hidden="true" /> {ct('inbox2.note.delete')}
          </button>
        </footer>
      </div>
    </article>
  );
}
