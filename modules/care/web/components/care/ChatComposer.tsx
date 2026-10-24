import { AtSign, Loader2, Send, Smile } from 'lucide-preact';
import { useCallback, useState } from 'preact/hooks';
import { RichTextPreview, RichToolbar, type RichToolbarLabels } from '@/components/RichTextEditor';
import { ComposerNotice, SendUnavailable } from './ComposerNotice';
import { AttachmentChips, CannedMenu, ComposerTabs, EmojiPanel, HighlightTextarea, MentionMenu, type ComposerTab } from './inbox/ComposerParts';
import { draftHasContent, type ChatDraft } from '@modules/care/web/lib/care/composer';
import type { CareAccountDto, CareCannedReplyDto, CareConversationDto, CareMessageDto } from '@modules/care/web/lib/care/dto';
import { ct } from '@modules/care/web/lib/care/i18n';
import { countPlaceholders } from '@modules/care/web/lib/care/placeholders';
import { useCannedPicker } from '@modules/care/web/lib/care/useCannedPicker';
import { useChatEditor } from '@modules/care/web/lib/care/useChatEditor';
import { useReply } from '@modules/care/web/lib/care/useReply';
import { useProvides } from '@/module-host';
import type { CareComposerExtrasComponent } from '@modules/care/web/lib/extension-points';
import { editText, patchChatFields } from '@modules/care/web/lib/care/zaloEdit';

/** Zalo's own message limit (the old sender would refuse anything longer). */
const ZALO_MAX_TEXT = 2000;

/** Toolbar captions from the Care dictionary (the shared toolbar defaults to Vietnamese). */
const TOOLBAR_LABELS: RichToolbarLabels = {
  get bold() { return ct('inbox2.format.bold'); },
  get italic() { return ct('inbox2.format.italic'); },
  get underline() { return ct('inbox2.format.underline'); },
  get strike() { return ct('inbox2.format.strike'); },
  color: (st) => ct('inbox2.format.color', { name: ct(`inbox2.format.colors.${st}`) }),
  get noColor() { return ct('inbox2.format.noColor'); },
  get small() { return ct('inbox2.format.small'); },
  get big() { return ct('inbox2.format.big'); },
  get bullets() { return ct('inbox2.format.bullets'); },
  get numbered() { return ct('inbox2.format.numbered'); },
};

/** Chat reply box (text, rich formatting where the channel supports it; attachments and other channel extras come from `care.composerExtras`). No email fields exist here; the email composer is a separate component. */
export function ChatComposer({ conversation, messages, replyEnabled, account, canned, tab, onTab, onAccepted }: {
  conversation: CareConversationDto;
  messages: CareMessageDto[];
  replyEnabled: boolean | null;
  account: CareAccountDto | undefined;
  canned: CareCannedReplyDto[];
  tab: ComposerTab;
  onTab: (t: ComposerTab) => void;
  onAccepted: () => void;
}) {
  const delivery = account?.delivery;
  const sendEnabled = !account || account.sendEnabled;
  const r = useReply({ conversation, messages, ownAddresses: [], kind: 'chat', replyEnabled, replyVia: delivery?.replyVia, onAccepted });
  const draft: ChatDraft | null = r.draft.kind === 'chat' ? r.draft : null;
  const text = draft?.text ?? '';
  // Zalo: formatting ranges and @mentions follow the text (see zaloEdit.ts); other channels keep the plain textarea.
  const zalo = conversation.channel === 'zalo';
  const isGroup = zalo && conversation.kind === 'group';
  const maxLength = zalo ? ZALO_MAX_TEXT : undefined;
  const setText = (v: string) => r.update((d) => patchChatFields(d, (f) => editText(f, v)));
  const picker = useCannedPicker({ items: canned, channel: conversation.channel, text, setText });
  const ed = useChatEditor({ ta: picker.ta, draft, update: r.update, maxLength, isGroup, messages, allLabel: ct('inbox2.mention.all') });
  const [toolbar, setToolbar] = useState(false);
  const [emoji, setEmoji] = useState(false);
  const closeEmoji = useCallback(() => setEmoji(false), []);
  const extras = useProvides<CareComposerExtrasComponent>('care.composerExtras');
  const uploading: string[] = [];
  if (!draft) return null;

  const blocked = r.unavailable || !sendEnabled;
  const attachments = draft.attachments ?? [];
  const blanks = countPlaceholders(draft.text);
  const canSend = !blocked && !r.submitting && uploading.length === 0 && draftHasContent(draft) && blanks === 0;
  const quota = delivery?.sendQuota;
  const listId = `care-canned-${conversation.id}`;
  const mentionId = `care-mention-${conversation.id}`;
  const emojiId = `care-emoji-${conversation.id}`;
  const syncCaret = () => { picker.syncCaret(); ed.syncSel(); };

  return (
    <form class="care-composer" data-testid="care-chat-composer" onSubmit={(e) => { e.preventDefault(); void r.submit(); }}>
      <ComposerTabs
        channel={conversation.channel}
        tab={tab}
        onTab={onTab}
        right={quota ? ct('inbox2.composer.sendFromQuota', { account: account?.label ?? '', used: quota.used, limit: quota.limit }) : account ? ct('inbox2.composer.sendFrom', { account: account.label }) : null}
      />
      <div class="care-cbody">
        {r.unavailable && <SendUnavailable conversationId={conversation.id} none={(account?.delivery?.replyVia) === 'none'} />}
        {!r.unavailable && !sendEnabled && <div class="care-banner is-warn" role="status"><span>{ct('composer.sendDisabledAccount')}</span></div>}
        <ComposerNotice notice={r.notice} />
        {zalo && toolbar && (
          <div class="care-rtoolbar" role="toolbar" aria-label={ct('inbox2.format.toggle')} data-testid="care-format-toolbar">
            <RichToolbar styles={ed.styles} sel={ed.sel} disabled={blocked} onInline={ed.inline} onExclusive={ed.exclusive} onList={ed.list} labels={TOOLBAR_LABELS} />
            {ed.formatHint && <span class="care-rtoolbar-hint" role="status">{ct('inbox2.format.selectFirst')}</span>}
          </div>
        )}
        <HighlightTextarea
          id={`care-chat-${conversation.id}`}
          taRef={picker.ta}
          value={draft.text}
          rows={3}
          label={ct('composer.chatLabel')}
          placeholder={ct('inbox2.composer.chatPlaceholder')}
          maxLength={maxLength}
          controls={ed.mention.open ? mentionId : listId}
          expanded={picker.open || ed.mention.open}
          onText={setText}
          onCaret={syncCaret}
          onSelect={ed.syncSel}
          onKeyDown={(e) => {
            if (zalo && ed.mention.onKeyDown(e)) return;
            if (picker.onKeyDown(e)) return;
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void r.submit(); return; }
            if (zalo) ed.onShortcut(e);
          }}
        />
        {zalo && ed.styles.length > 0 && draft.text.length > 0 && (
          <div class="care-rpreview" data-testid="care-format-preview">
            <span class="care-rpreview-label">{ct('inbox2.format.preview')}</span>
            <RichTextPreview text={draft.text} styles={ed.styles} />
          </div>
        )}
        <AttachmentChips items={attachments} uploading={uploading} onRemove={(id) => r.update((d) => (d.kind === 'chat' ? { ...d, attachments: (d.attachments ?? []).filter((a) => a.mediaId !== id) } : d))} />
        {blanks > 0 && <p class="care-faint" data-testid="care-blanks-block">{ct('inbox2.blanks.block')}</p>}
        {/* Send sits on the left: the floating Jarvis orb lives in the bottom-right corner. */}
        <div class="care-composer-actions">
          <button type="submit" class="cc-button is-primary" disabled={!canSend} data-testid="care-send">
            {r.submitting ? <Loader2 size={13} class="animate-spin" aria-hidden="true" /> : <Send size={13} aria-hidden="true" />}
            {r.submitting ? ct('composer.sending') : ct('composer.send')}
          </button>
          <button type="button" class={`care-tool${picker.buttonOpen ? ' is-on' : ''}`} aria-expanded={picker.open} aria-haspopup="listbox" aria-controls={listId} aria-label={ct('inbox2.canned.button')} title={ct('inbox2.canned.button')} onClick={picker.toggleButton} data-testid="care-canned-button">/</button>
          {zalo && (
            <>
              <button type="button" class={`care-tool${toolbar ? ' is-on' : ''}`} aria-pressed={toolbar} aria-label={ct('inbox2.format.toggle')} title={ct('inbox2.format.toggle')} onMouseDown={(e) => e.preventDefault()} onClick={() => setToolbar((v) => !v)} data-testid="care-format-toggle">Aa</button>
              <button type="button" class={`care-tool${emoji ? ' is-on' : ''}`} data-emoji-toggle="" aria-expanded={emoji} aria-haspopup="dialog" aria-controls={emojiId} aria-label={ct('inbox2.emoji.button')} title={ct('inbox2.emoji.button')} disabled={blocked} onMouseDown={(e) => e.preventDefault()} onClick={() => setEmoji((v) => !v)} data-testid="care-emoji-button"><Smile size={14} aria-hidden="true" /></button>
              {isGroup && (
                <button type="button" class="care-tool" aria-label={ct('inbox2.mention.button')} title={ct('inbox2.mention.button')} disabled={blocked} onMouseDown={(e) => e.preventDefault()} onClick={ed.startMention} data-testid="care-mention-button"><AtSign size={14} aria-hidden="true" /></button>
              )}
            </>
          )}
          {extras.map((Extra, i) => (
            <Extra
              key={i}
              channel={conversation.channel}
              account={account}
              threadId={conversation.id}
              thread={conversation}
              disabled={blocked}
              attachments={attachments}
              onAttachmentsChange={(next) => r.update((d) => (d.kind === 'chat' ? { ...d, attachments: next } : d))}
            />
          ))}
          <span class="care-faint care-composer-hint">{ct('inbox2.composer.sendHint')}</span>
        </div>
      </div>
      <CannedMenu picker={picker} id={listId} hasItems={canned.length > 0} />
      {zalo && ed.mention.open && <MentionMenu id={mentionId} matches={ed.mention.matches} active={ed.mention.active} onChoose={ed.mention.choose} onHover={ed.mention.setActive} />}
      {zalo && emoji && <EmojiPanel id={emojiId} onPick={ed.insertAtCaret} onClose={closeEmoji} />}
    </form>
  );
}
