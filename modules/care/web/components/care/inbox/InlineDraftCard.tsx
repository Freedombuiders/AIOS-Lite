import { Loader2, Send, Sparkles } from 'lucide-preact';
import { Link } from 'wouter-preact';
import { PlaceholderText } from './PlaceholderText';
import { clockTime } from '@modules/care/web/lib/care/timeFormat';
import { ct } from '@modules/care/web/lib/care/i18n';
import type { CareInlineDraftDto } from '@modules/care/web/lib/care/dto';
import { countPlaceholders } from '@modules/care/web/lib/care/placeholders';
import { agentName, type AgentLite } from '@modules/care/web/lib/care/useInboxExtras';

export type DraftNoteKind = 'discarded' | 'superseded' | 'edited' | 'sent';

/** AI draft waiting for the owner, right above the composer: Gửi luôn / Sửa rồi gửi / Bỏ nháp. */
export function InlineDraftCard({ draft, more, agents, busy, onSend, onEdit, onDiscard }: {
  draft: CareInlineDraftDto;
  /** Other drafts waiting in this conversation. */
  more: number;
  agents: AgentLite[];
  busy: 'send' | 'discard' | null;
  onSend: () => void;
  onEdit: () => void;
  onDiscard: () => void;
}) {
  const blanks = countPlaceholders(draft.text);
  const core = draft.source === 'core';
  return (
    <section class="care-draftcard" aria-label={ct('inbox2.draft.region')} data-testid="care-inline-draft" data-draft-id={draft.id}>
      <div class="care-draftcard-head">
        <span class="care-draftcard-title"><Sparkles size={13} aria-hidden="true" /> {draft.agentId ? ct('inbox2.draft.ofAgent', { name: agentName(agents, draft.agentId) }) : ct('inbox2.draft.title')}</span>
        {draft.reviewReason && <span class="care-chip is-warn" data-testid="care-draft-reason">{ct('inbox2.draft.needsReview', { reason: draft.reviewReason })}</span>}
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
      <p class="care-draftcard-text" data-testid="care-draft-text"><PlaceholderText text={draft.text} /></p>
      {blanks > 0 && <p class="care-draftcard-warn" role="status" data-testid="care-draft-blanks">{ct('inbox2.draft.blanks', { n: blanks })}</p>}
      <div class="care-draftcard-actions">
        {core ? (
          <Link href="/m/care/drafts" class="cc-button is-primary" data-testid="care-draft-open-review">{ct('inbox2.draft.openReview')}</Link>
        ) : (
          <button type="button" class="cc-button is-primary" disabled={busy !== null || blanks > 0} onClick={onSend} data-testid="care-draft-send" title={blanks > 0 ? ct('inbox2.draft.blanksBlock') : undefined}>
            {busy === 'send' ? <Loader2 size={13} class="animate-spin" aria-hidden="true" /> : <Send size={13} aria-hidden="true" />} {ct('inbox2.draft.send')}
          </button>
        )}
        {!core && <button type="button" class="cc-button" disabled={busy !== null} onClick={onEdit} data-testid="care-draft-edit">{ct('inbox2.draft.edit')}</button>}
        <button type="button" class="cc-button is-ghost" disabled={busy !== null} onClick={onDiscard} data-testid="care-draft-discard">
          {busy === 'discard' && <Loader2 size={12} class="animate-spin" aria-hidden="true" />} {ct('inbox2.draft.discard')}
        </button>
      </div>
    </section>
  );
}

/** After a draft is gone: why, and a way to ask the AI again. */
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
