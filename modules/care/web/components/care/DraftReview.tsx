import { Check, Loader2, Trash2 } from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { ChannelBadge } from './ChannelBadge';
import { PlaceholderText } from './inbox/PlaceholderText';
import { ConfirmModal } from '@/components/ConfirmModal';
import { clockTime } from '@modules/care/web/lib/care/timeFormat';
import { careApi } from '@modules/care/web/lib/care/client';
import { lastCustomerMessages, type ContextMessage } from '@modules/care/web/lib/care/draftContext';
import type { CareInlineDraftDto } from '@modules/care/web/lib/care/dto';
import { toCareFailure } from '@modules/care/web/lib/care/failure';
import { ct } from '@modules/care/web/lib/care/i18n';
import { countPlaceholders } from '@modules/care/web/lib/care/placeholders';
import { reasonText } from '@modules/care/web/lib/care/reasons';
import { pushToast } from '@/lib/toasts';

/** Context for a draft review: the customer's last three messages in the draft's conversation. */
export function DraftContext({ conversationId }: { conversationId: string }) {
  const [rows, setRows] = useState<ContextMessage[] | null>(null);
  useEffect(() => {
    let live = true;
    setRows(null);
    careApi.messages(conversationId, { limit: 12 })
      .then((p) => { if (live) setRows(lastCustomerMessages(p.items)); })
      .catch(() => { if (live) setRows([]); });
    return () => { live = false; };
  }, [conversationId]);
  return (
    <section class="care-draft-context" aria-label={ct('inbox2.drafts.context')} data-testid="care-draft-context">
      <h3 class="care-subtitle">{ct('inbox2.drafts.context')}</h3>
      {rows === null && <p class="care-faint"><Loader2 size={12} class="animate-spin" aria-hidden="true" /> {ct('list.loadingMore')}</p>}
      {rows && rows.length === 0 && <p class="care-faint">{ct('inbox2.drafts.contextEmpty')}</p>}
      {rows && rows.length > 0 && (
        <ul class="care-ctx-list">
          {rows.map((m) => (
            <li key={m.id} class="care-ctx-msg" data-testid="care-draft-context-msg">
              <span class="care-faint">{clockTime(m.sentAtMs)}</span>
              {m.text && <span class="care-text">{m.text}</span>}
              {m.attachments.length > 0 && <span class="care-faint">{ct('inbox2.drafts.attached', { names: m.attachments.join(', ') })}</span>}
              {m.sticker && !m.text && <span class="care-faint">{ct('msg.unsupported', { label: ct('msg.unsupportedSticker') })}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Reviewer for a draft written by the old Zalo / Email agents: edit the text, approve (send) or discard. */
export function LegacyDraftEditor({ draft, onBack, onChanged }: { draft: CareInlineDraftDto; onBack: () => void; onChanged: () => void }) {
  const [text, setText] = useState(draft.text);
  const [busy, setBusy] = useState<'approve' | 'discard' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const edited = text !== draft.text;
  const blanks = countPlaceholders(text);
  const empty = text.trim().length === 0;

  function fail(e: unknown): void {
    const f = toCareFailure(e);
    setError(f.code === 'STALE_REVISION' ? ct('inbox2.drafts.gone') : reasonText(f.reason) ?? f.message);
  }

  async function approve(): Promise<void> {
    if (empty || blanks > 0) return;
    setBusy('approve');
    setError(null);
    try {
      await careApi.approveInline(draft.id, edited ? text : undefined);
      pushToast({ tone: 'success', title: ct('drafts.approved') });
      onChanged();
      onBack();
    } catch (e) { fail(e); } finally { setBusy(null); }
  }

  async function discard(): Promise<void> {
    setBusy('discard');
    setError(null);
    try {
      await careApi.discardInline(draft.id);
      pushToast({ tone: 'success', title: ct('drafts.discarded') });
      onChanged();
      onBack();
    } catch (e) { fail(e); } finally { setBusy(null); }
  }

  return (
    <section class="care-detail care-draft-editor" aria-label={ct('drafts.editor')} data-testid="care-legacy-draft-editor">
      <header class="care-detail-head">
        <button type="button" class="care-back" onClick={onBack} aria-label={ct('detail.back')}>←</button>
        <div class="care-detail-title">
          <h2>{draft.email ? ct('drafts.emailDraft') : ct('drafts.chatDraft')}</h2>
          <div class="care-detail-sub">
            <ChannelBadge channel={draft.channel} />
            {draft.agentId && <span class="care-chip">{ct('inbox2.draft.ofAgent', { name: draft.agentId })}</span>}
            <Link href={`/m/care/inbox/${encodeURIComponent(draft.conversationId)}`} class="care-inline-link" data-testid="care-draft-open">{ct('drafts.openConversation')}</Link>
          </div>
        </div>
      </header>
      <div class="care-draft-body">
        {draft.reviewReason && <div class="care-banner is-warn" role="status"><span>{ct('inbox2.draft.needsReview', { reason: draft.reviewReason })}</span></div>}
        <DraftContext conversationId={draft.conversationId} />
        {error && <div class="care-banner is-error" role="alert" data-testid="care-draft-message"><span>{error}</span></div>}
        <fieldset class="care-fieldset" disabled={busy !== null}>
          {draft.email && (
            <dl class="care-kv" data-testid="care-draft-meta">
              <div><dt>{ct('emailComposer.to')}</dt><dd>{draft.email.to.join(', ')}</dd></div>
              {draft.email.cc.length > 0 && <div><dt>{ct('emailComposer.cc')}</dt><dd>{draft.email.cc.join(', ')}</dd></div>}
              <div><dt>{ct('emailComposer.subject')}</dt><dd>{draft.email.subject}</dd></div>
            </dl>
          )}
          <div class="care-field">
            <label for="care-ld-text">{ct('drafts.text')}</label>
            <textarea id="care-ld-text" rows={10} value={text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} data-testid="care-draft-text" />
            {blanks > 0 && <span class="care-draftcard-warn" role="status">{ct('inbox2.draft.blanks', { n: blanks })} <PlaceholderText text={text.match(/\[[^[\]\r\n]{1,80}\]/g)?.join(' ') ?? ''} /></span>}
          </div>
        </fieldset>
        <div class="care-composer-actions">
          <button type="button" class="cc-button is-primary" disabled={busy !== null || empty || blanks > 0} onClick={() => void approve()} data-testid="care-draft-approve">
            {busy === 'approve' ? <Loader2 size={12} class="animate-spin" aria-hidden="true" /> : <Check size={12} aria-hidden="true" />} {edited ? ct('inbox2.drafts.editAndSend') : ct('drafts.approve')}
          </button>
          <button type="button" class="cc-button" disabled={busy !== null} onClick={() => setConfirmDiscard(true)} data-testid="care-draft-discard"><Trash2 size={12} aria-hidden="true" /> {ct('drafts.discard')}</button>
        </div>
        <p class="care-faint">{ct('inbox2.drafts.legacyHint')}</p>
      </div>
      <ConfirmModal open={confirmDiscard} onClose={() => setConfirmDiscard(false)} onConfirm={() => { setConfirmDiscard(false); void discard(); }} title={ct('drafts.discardTitle')} body={ct('drafts.discardBody')} confirmLabel={ct('drafts.discard')} cancelLabel={ct('identity.cancel')} destructive />
    </section>
  );
}
