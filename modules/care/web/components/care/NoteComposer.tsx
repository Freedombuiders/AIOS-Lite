import { Loader2, NotebookPen } from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import { ComposerTabs, type ComposerTab } from './inbox/ComposerParts';
import { toCareFailure } from '@modules/care/web/lib/care/failure';
import { ct } from '@modules/care/web/lib/care/i18n';
import { noteDraftStore } from '@modules/care/web/lib/care/useInboxExtras';
import type { CareApiChannel, CareNoteDto } from '@modules/care/web/lib/care/dto';

const MAX_NOTE = 4000;

/** Internal note: amber, never sent to the customer. The request id is minted once per text and reused on a retry. */
export function NoteComposer({ conversationId, channel, tab, onTab, onAdd }: {
  conversationId: string;
  channel: CareApiChannel;
  tab: ComposerTab;
  onTab: (t: ComposerTab) => void;
  onAdd: (body: string, clientRequestId: string) => Promise<CareNoteDto>;
}) {
  const [text, setText] = useState(() => noteDraftStore.get(conversationId).text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setText(noteDraftStore.get(conversationId).text); setError(null); }, [conversationId]);

  const body = text.trim();
  const canSave = !busy && body.length > 0 && body.length <= MAX_NOTE;

  async function save(): Promise<void> {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      await onAdd(body, noteDraftStore.requestId(conversationId));
      noteDraftStore.clear(conversationId);
      setText('');
    } catch (e) {
      setError(toCareFailure(e).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form class="care-composer is-note" data-testid="care-note-composer" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <ComposerTabs channel={channel} tab={tab} onTab={onTab} right={ct('inbox2.note.visibility')} />
      <div class="care-cbody">
        {error && <div class="care-banner is-error" role="alert" data-testid="care-note-error"><span>{ct('inbox2.note.error', { why: error })}</span></div>}
        <label class="care-sr-only" for={`care-note-${conversationId}`}>{ct('inbox2.note.label')}</label>
        <textarea
          id={`care-note-${conversationId}`}
          rows={3}
          value={text}
          maxLength={MAX_NOTE}
          placeholder={ct('inbox2.note.placeholder')}
          data-testid="care-note-input"
          onInput={(e) => { const v = (e.target as HTMLTextAreaElement).value; setText(v); noteDraftStore.setText(conversationId, v); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); } }}
        />
        <div class="care-composer-actions">
          <button type="submit" class="cc-button is-primary is-note" disabled={!canSave} data-testid="care-note-save">
            {busy ? <Loader2 size={13} class="animate-spin" aria-hidden="true" /> : <NotebookPen size={13} aria-hidden="true" />} {ct('inbox2.note.save')}
          </button>
          <span class="care-faint care-composer-hint">{ct('inbox2.composer.sendHint')}</span>
        </div>
      </div>
    </form>
  );
}
