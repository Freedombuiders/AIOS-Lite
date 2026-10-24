import { Loader2, Send, X } from 'lucide-preact';
import { ComposerNotice, SendUnavailable } from './ComposerNotice';
import { CannedMenu, ComposerTabs, HighlightTextarea, type ComposerTab } from './inbox/ComposerParts';
import { ct } from '@modules/care/web/lib/care/i18n';
import { computeEmailPreview, draftHasContent, ownAddressesOf, type EmailDraft } from '@modules/care/web/lib/care/composer';
import type { CareAccountDto, CareCannedReplyDto, CareConversationDto, CareMessageDto } from '@modules/care/web/lib/care/dto';
import { countPlaceholders } from '@modules/care/web/lib/care/placeholders';
import { useCannedPicker } from '@modules/care/web/lib/care/useCannedPicker';
import { useReply } from '@modules/care/web/lib/care/useReply';

/**
 * Email reply box. Separate from the chat composer: explicit Reply / Reply-all preview, recipients,
 * subject and signature. Deliberately no BCC, new-mail or upload controls: the API only enables
 * them per account capability, and none is advertised yet.
 */
export function EmailComposer({ conversation, messages, account, replyEnabled, canned, tab, onTab, onAccepted }: {
  conversation: CareConversationDto;
  messages: CareMessageDto[];
  account: CareAccountDto | undefined;
  replyEnabled: boolean | null;
  canned: CareCannedReplyDto[];
  tab: ComposerTab;
  onTab: (t: ComposerTab) => void;
  onAccepted: () => void;
}) {
  const own = ownAddressesOf(account);
  const r = useReply({ conversation, messages, ownAddresses: own, kind: 'email', replyEnabled, replyVia: account?.delivery?.replyVia, onAccepted });
  const draft = r.draft.kind === 'email' ? r.draft : null;
  const body = draft?.body ?? '';
  const setBody = (v: string) => r.update((d) => (d.kind === 'email' ? { ...d, body: v } : d));
  const picker = useCannedPicker({ items: canned, channel: 'email', text: body, setText: setBody });
  if (!draft) return null;
  const preview = computeEmailPreview(draft, messages, own);
  const sendEnabled = !account || account.sendEnabled;
  const blocked = r.unavailable || !sendEnabled;
  const blanks = countPlaceholders(draft.body) + countPlaceholders(draft.subject ?? '');
  const canSend = !blocked && !r.submitting && draftHasContent(draft) && preview.to.length > 0 && blanks === 0;
  const set = (patch: Partial<EmailDraft>) => r.update((d) => (d.kind === 'email' ? { ...d, ...patch } : d));
  const idBase = `care-mail-${conversation.id}`;
  const restorable = draft.removedCc.length;
  const listId = `care-canned-${conversation.id}`;

  return (
    <form class="care-composer is-email" data-testid="care-email-composer" onSubmit={(e) => { e.preventDefault(); void r.submit(); }}>
      <ComposerTabs channel="email" tab={tab} onTab={onTab} right={ct('inbox2.composer.emailThread')} />
      <div class="care-cbody">
      {r.unavailable && <SendUnavailable conversationId={conversation.id} none={(account?.delivery?.replyVia) === 'none'} />}
      {!r.unavailable && !sendEnabled && <div class="care-banner is-warn" role="status"><span>{ct('composer.sendDisabledAccount')}</span></div>}
      <ComposerNotice notice={r.notice} />

      <fieldset class="care-mode">
        <legend>{ct('emailComposer.mode')}</legend>
        <label class={draft.mode === 'reply' ? 'is-on' : ''}>
          <input type="radio" name={`${idBase}-mode`} checked={draft.mode === 'reply'} onChange={() => set({ mode: 'reply', removedCc: [], recipients: null })} data-testid="care-mode-reply" />
          {ct('emailComposer.reply')}
        </label>
        <label class={draft.mode === 'reply_all' ? 'is-on' : ''}>
          <input type="radio" name={`${idBase}-mode`} checked={draft.mode === 'reply_all'} onChange={() => set({ mode: 'reply_all', removedCc: [], recipients: null })} data-testid="care-mode-reply-all" />
          {ct('emailComposer.replyAll')}
        </label>
        <span class="care-faint">{draft.mode === 'reply' ? ct('emailComposer.replyHint') : ct('emailComposer.replyAllHint')}</span>
      </fieldset>

      <dl class="care-recipients" aria-label={ct('emailComposer.preview')} data-testid="care-recipients">
        {own[0] && <div><dt>{ct('emailComposer.from')}</dt><dd>{own[0]}</dd></div>}
        <div>
          <dt>{ct('emailComposer.to')}</dt>
          <dd data-testid="care-to">{preview.to.length ? preview.to.map((a) => <span key={a} class="care-addr">{a}</span>) : <span class="care-faint">{ct('composer.noRecipient')}</span>}</dd>
        </div>
        <div>
          <dt>{ct('emailComposer.cc')}</dt>
          <dd data-testid="care-cc">
            {preview.cc.length === 0 && <span class="care-faint">{ct('emailComposer.noCc')}</span>}
            {preview.cc.map((a) => (
              <span key={a} class="care-addr">
                {a}
                <button type="button" class="care-addr-remove" aria-label={ct('emailComposer.removeCc', { address: a })} onClick={() => set({ removedCc: [...draft.removedCc, a.toLowerCase()] })}>
                  <X size={10} aria-hidden="true" />
                </button>
              </span>
            ))}
            {restorable > 0 && <button type="button" class="care-link-button" onClick={() => set({ removedCc: [] })}>{ct('emailComposer.restoreCc', { n: restorable })}</button>}
          </dd>
        </div>
      </dl>
      {preview.warnings.includes('automated_recipient') && <div class="care-banner is-warn" role="status"><span>{ct('emailComposer.automatedWarning')}</span></div>}

      <div class="care-field">
        <label for={`${idBase}-subject`}>{ct('emailComposer.subject')}</label>
        <input id={`${idBase}-subject`} type="text" value={preview.subject} maxLength={998} onInput={(e) => set({ subject: (e.target as HTMLInputElement).value })} data-testid="care-subject" />
      </div>
      <div class="care-field">
        <HighlightTextarea
          id={`${idBase}-body`}
          taRef={picker.ta}
          value={draft.body}
          rows={6}
          label={ct('emailComposer.bodyLabel')}
          placeholder={ct('inbox2.composer.emailPlaceholder')}
          controls={listId}
          expanded={picker.open}
          onText={setBody}
          onCaret={picker.syncCaret}
          onKeyDown={(e) => {
            if (picker.onKeyDown(e)) return;
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void r.submit(); }
          }}
        />
      </div>
      {conversation.signature && (
        <div class="care-signature" data-testid="care-signature">
          <span class="care-faint">{ct('emailComposer.signatureServer')}</span>
          <pre>{conversation.signature}</pre>
        </div>
      )}

      {/* Send sits on the left: the floating Jarvis orb lives in the bottom-right corner. */}
      <div class="care-composer-actions">
        <button type="submit" class="cc-button is-primary" disabled={!canSend} data-testid="care-send">
          {r.submitting ? <Loader2 size={13} class="animate-spin" aria-hidden="true" /> : <Send size={13} aria-hidden="true" />}
          {r.submitting ? ct('composer.sending') : blanks > 0 ? ct('inbox2.blanks.sendLabel', { n: blanks }) : ct('emailComposer.send')}
        </button>
        <button type="button" class={`care-tool${picker.buttonOpen ? ' is-on' : ''}`} aria-expanded={picker.open} aria-haspopup="listbox" aria-controls={listId} aria-label={ct('inbox2.canned.button')} title={ct('inbox2.canned.button')} onClick={picker.toggleButton} data-testid="care-canned-button">/</button>
        <span class="care-faint">{ct('emailComposer.noBcc')}</span>
      </div>
      </div>
      <CannedMenu picker={picker} id={listId} hasItems={canned.length > 0} />
    </form>
  );
}
