import { Loader2, Send, Sparkles } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { PlaceholderText } from './PlaceholderText';
import { clockTime } from '@modules/care/web/lib/care/timeFormat';
import { ct } from '@modules/care/web/lib/care/i18n';
import { draftStopText } from '@modules/care/web/lib/care/botView';
import type { CareInlineDraftDto } from '@modules/care/web/lib/care/dto';
import { countPlaceholders } from '@modules/care/web/lib/care/placeholders';
import { agentName, type AgentLite } from '@modules/care/web/lib/care/useInboxExtras';

export type DraftNoteKind = 'discarded' | 'superseded' | 'edited' | 'sent';

/**
 * The bot's draft right above the composer (T07): who wrote it, why the bot stopped, which brain notes it used, and
 * Gửi / Sửa rồi gửi / Bỏ. "Sửa rồi gửi" opens the text in place; sending the edit saves the new revision and approves it.
 */
export function InlineDraftCard({ draft, more, agents, busy, onSend, onSendEdited, onDiscard }: {
  draft: CareInlineDraftDto;
  /** Other drafts waiting in this conversation. */
  more: number;
  agents: AgentLite[];
  busy: 'send' | 'discard' | null;
  onSend: () => void;
  onSendEdited: (text: string) => void;
  onDiscard: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const shown = editing ?? draft.text;
  const blanks = countPlaceholders(shown);
  const why = draftStopText(draft.stop) ?? (draft.reviewReason ? ct('inbox2.draft.needsReview', { reason: draft.reviewReason }) : null);
  const sources = draft.sources ?? [];
  const name = draft.agentId ? agentName(agents, draft.agentId) : '';
  const changed = editing !== null && editing.trim() !== '' && editing !== draft.text;
  return (
    <section class="care-draftcard is-bot" aria-label={ct('inbox2.draft.region')} data-testid="care-inline-draft" data-draft-id={draft.id} data-status={draft.status}>
      <div class="care-draftcard-head">
        <span class="care-draftcard-title"><Sparkles size={13} aria-hidden="true" /> {name ? ct('bot.draft.title', { name }) : ct('bot.draft.titleNoName')}</span>
        {more > 0 && <span class="care-faint">{ct('inbox2.draft.more', { n: more })}</span>}
        <span class="care-draftcard-time">{clockTime(draft.createdAtMs)}</span>
      </div>
      {draft.email && (
        <dl class="care-draftcard-mail">
          <div><dt>{ct('emailComposer.to')}</dt><dd>{draft.email.to.join(', ')}</dd></div>
          {draft.email.cc.length > 0 && <div><dt>{ct('emailComposer.cc')}</dt><dd>{draft.email.cc.join(', ')}</dd></div>}
          <div><dt>{ct('emailComposer.subject')}</dt><dd>{draft.email.subject}</dd></div>
        </dl>
      )}
      {editing === null
        ? <p class="care-draftcard-text" data-testid="care-draft-text"><PlaceholderText text={draft.text} /></p>
        : <textarea class="care-draftcard-edit" rows={4} value={editing} aria-label={ct('bot.draft.editLabel')} data-testid="care-draft-edit-text" onInput={(e) => setEditing((e.target as HTMLTextAreaElement).value)} />}
      {blanks > 0 && <p class="care-draftcard-warn" role="status" data-testid="care-draft-blanks">{ct('inbox2.draft.blanks', { n: blanks })}</p>}
      {why && <p class="care-draftcard-why" data-testid="care-draft-why">{ct('bot.draft.stop', { why })}</p>}
      {sources.length > 0
        ? <p class="care-draftcard-why" data-testid="care-draft-sources">{ct('bot.draft.sources')}: {sources.join(' · ')}</p>
        : <p class="care-faint care-draftcard-nosrc" data-testid="care-draft-nosources">{ct('bot.draft.noSources')}</p>}
      <div class="care-draftcard-actions">
        {editing === null ? (
          <>
            <button type="button" class="cc-button is-primary" disabled={busy !== null || blanks > 0} onClick={onSend} data-testid="care-draft-send" title={blanks > 0 ? ct('inbox2.draft.blanksBlock') : undefined}>
              {busy === 'send' ? <Loader2 size={13} class="animate-spin" aria-hidden="true" /> : <Send size={13} aria-hidden="true" />} {ct('bot.draft.send')}
            </button>
            <button type="button" class="cc-button" disabled={busy !== null} onClick={() => setEditing(draft.text)} data-testid="care-draft-edit">{ct('bot.draft.edit')}</button>
          </>
        ) : (
          <>
            <button type="button" class="cc-button is-primary" disabled={busy !== null || !changed || blanks > 0} onClick={() => onSendEdited(editing)} data-testid="care-draft-send-edited">
              {busy === 'send' ? <Loader2 size={13} class="animate-spin" aria-hidden="true" /> : <Send size={13} aria-hidden="true" />} {ct('bot.draft.sendEdited')}
            </button>
            <button type="button" class="cc-button" disabled={busy !== null} onClick={() => setEditing(null)} data-testid="care-draft-cancel-edit">{ct('bot.draft.cancelEdit')}</button>
          </>
        )}
        <button type="button" class="cc-button is-ghost" disabled={busy !== null} onClick={onDiscard} data-testid="care-draft-discard">
          {busy === 'discard' && <Loader2 size={12} class="animate-spin" aria-hidden="true" />} {ct('bot.draft.discard')}
        </button>
      </div>
    </section>
  );
}

/** After a draft is gone: why, and a way to ask the bot again. */
export function DraftNote({ kind, busy, canRetry, onRedo }: { kind: DraftNoteKind; busy: boolean; canRetry: boolean; onRedo: () => void }) {
  return (
    <div class="care-draftnote" role="status" data-testid="care-draft-note" data-kind={kind}>
      <span>{ct(`inbox2.draft.note.${kind}`)}</span>
      {canRetry && (
        <button type="button" class="care-link-button" disabled={busy} onClick={onRedo} data-testid="care-draft-redo">
          {busy && <Loader2 size={11} class="animate-spin" aria-hidden="true" />} {ct('inbox2.draft.redo')}
        </button>
      )}
    </div>
  );
}
