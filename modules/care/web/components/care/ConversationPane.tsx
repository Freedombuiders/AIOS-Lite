import { ArrowLeft, ArrowDownToLine, Bot, Check, Loader2, RotateCcw, UserRound } from 'lucide-preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { ChannelBadge } from './ChannelBadge';
import { ChatComposer } from './ChatComposer';
import { EmailComposer } from './EmailComposer';
import { conversationTitle } from '@modules/care/web/lib/care/title';
import { Timeline } from './Timeline';
import { CustomerDrawer } from './customer/CustomerDrawer';
import { Avatar } from './inbox/Avatar';
import type { ComposerTab } from './inbox/ComposerParts';
import { snoozeUntilText, waitText } from './inbox/format';
import { DraftNote, InlineDraftCard, type DraftNoteKind } from './inbox/InlineDraftCard';
import { SnoozeMenu } from './inbox/SnoozeMenu';
import { NoteComposer } from './NoteComposer';
import { PageState } from '@/components/PageState';
import { careApi, type WorkflowAction } from '@modules/care/web/lib/care/client';
import type { CareAccountDto, CareCannedReplyDto, CareConversationDto, CareInlineDraftDto } from '@modules/care/web/lib/care/dto';
import { toCareFailure } from '@modules/care/web/lib/care/failure';
import { ct } from '@modules/care/web/lib/care/i18n';
import { draftStore, intentStore } from '@modules/care/web/lib/care/singletons';
import { useConversation } from '@modules/care/web/lib/care/useConversation';
import { newRequestId } from '@modules/care/web/lib/care/composer';
import { stateChip } from '@modules/care/web/lib/care/botView';
import { waitMinutes } from '@modules/care/web/lib/care/inboxView';
import { reasonText } from '@modules/care/web/lib/care/reasons';
import { useZaloProfiles } from '@modules/care/web/lib/care/zaloProfiles';
import { useCustomerPanel } from '@modules/care/web/lib/care/useCustomerPanel';
import { useConversationExtras, type AgentLite } from '@modules/care/web/lib/care/useInboxExtras';
import { pushToast } from '@/lib/toasts';

export type WorkflowEvent = { conversation: CareConversationDto; action: 'done' | 'snooze' | 'reopen' };

function failureText(e: unknown): string {
  const f = toCareFailure(e);
  return reasonText(f.reason) ?? f.message;
}

export function ConversationPane({ conversationId, around, accounts, agents, canned, replyEnabled, convTick, resyncTick, onBack, onClearAround, onConversation, onOpenConversation, onWorkflow, onOpenBot }: {
  conversationId: string;
  around: string | null;
  accounts: CareAccountDto[];
  agents: AgentLite[];
  canned: CareCannedReplyDto[];
  replyEnabled: boolean | null;
  convTick: number;
  resyncTick: number;
  onBack: () => void;
  onClearAround: () => void;
  /** Fresh server copy of the open conversation (after read-marking or a refresh). */
  onConversation: (c: CareConversationDto) => void;
  /** Open another conversation (customer timeline), optionally at a message. */
  onOpenConversation: (conversationId: string, messageId?: string) => void;
  /** The owner changed the status (Xong / Hoãn / Mở lại): the list shows a banner and refreshes. */
  onWorkflow?: (e: WorkflowEvent) => void;
  /** Mobile: the bot column is its own screen; this opens it. */
  onOpenBot?: () => void;
}) {
  const { state, loadOlder, loadNewer, setConversation, reload, refresh } = useConversation(conversationId, around, convTick, resyncTick);
  const { conversation, window: w } = state;
  const extras = useConversationExtras(conversationId, convTick, resyncTick);
  const profiles = useZaloProfiles(conversationId, conversation?.channel ?? 'email');
  const [, force] = useState(0);
  const [busyIntent, setBusyIntent] = useState<string | null>(null);
  const [busyNote, setBusyNote] = useState<string | null>(null);
  const [wfBusy, setWfBusy] = useState(false);
  const markedFor = useRef<string | null>(null);
  const panel = useCustomerPanel(false);
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftAction, setDraftAction] = useState<'send' | 'discard' | null>(null);
  const [draftNote, setDraftNote] = useState<DraftNoteKind | null>(null);
  const [tab, setTab] = useState<ComposerTab>('reply');

  useEffect(() => intentStore.subscribe(() => force((n) => n + 1)), []);
  const tracked = intentStore.get(conversationId);

  // Dashboard "seen": only once the newest message is actually in view (window at the latest end).
  useEffect(() => {
    if (!conversation || !conversation.localUnread || w.newerCursor !== null) return;
    const key = `${conversation.id}:${conversation.lastMessageId}`;
    if (markedFor.current === key) return;
    markedFor.current = key;
    careApi.markRead(conversation.id).then((c) => { setConversation(c); onConversation(c); }).catch(() => { markedFor.current = null; });
  }, [conversation?.id, conversation?.localUnread, conversation?.lastMessageId, w.newerCursor]);

  // Open intents settle on the server: each is refetched by id when the care stream reports this conversation changed
  // (convTick), never on a timer.
  const open = intentStore.open(conversationId);
  const openKey = open.map((t) => t.intent.id).join(',');
  useEffect(() => {
    if (!openKey) return undefined;
    let cancelled = false;
    for (const t of intentStore.open(conversationId)) {
      careApi.outbox(t.intent.id).then((i) => { if (!cancelled) intentStore.upsert(conversationId, i); }).catch(() => {});
    }
    return () => { cancelled = true; };
  }, [conversationId, openKey, convTick]);

  const visibleDraft = extras.drafts[0] ?? null;
  // A new draft replaces whatever the last one left behind.
  useEffect(() => { if (visibleDraft) setDraftNote(null); }, [visibleDraft?.id]);

  async function act(kind: 'cancel' | 'reconcile', intentId: string): Promise<void> {
    setBusyIntent(intentId);
    try {
      const next = kind === 'cancel' ? await careApi.cancel(intentId) : await careApi.reconcile(intentId);
      intentStore.upsert(conversationId, next);
    } catch (e) {
      pushToast({ tone: 'error', title: ct(kind === 'cancel' ? 'outbox.cancelFailed' : 'outbox.reconcileFailed'), description: toCareFailure(e).message });
    } finally {
      setBusyIntent(null);
    }
  }

  async function requestDraft(): Promise<void> {
    setDraftBusy(true);
    try {
      const r = await careApi.requestDraft(conversationId, newRequestId());
      pushToast({ tone: 'success', title: r.duplicate ? ct('detail.draftDuplicate') : conversation?.workflow ? ct('inbox2.draft.requested') : ct('detail.draftRequested') });
      setDraftNote(null);
    } catch (e) {
      const f = toCareFailure(e);
      pushToast({ tone: 'error', title: ct('detail.draftFailed'), description: reasonText(f.reason) ?? f.message });
    } finally {
      setDraftBusy(false);
    }
  }

  /** Runs one of the PUT actions; the answer is the updated conversation (list + header follow at once). */
  async function change(run: () => Promise<CareConversationDto>, after?: (c: CareConversationDto) => void): Promise<void> {
    setWfBusy(true);
    try {
      const c = await run();
      setConversation(c);
      onConversation(c);
      after?.(c);
      void extras.reloadDrafts();
    } catch (e) {
      const f = toCareFailure(e);
      pushToast({ tone: 'error', title: ct('inbox2.changeFailed'), description: reasonText(f.reason) ?? f.message });
      if (f.code === 'STALE_REVISION') void refresh();
    } finally {
      setWfBusy(false);
    }
  }
  const workflow = (body: WorkflowAction, action: WorkflowEvent['action']) => change(
    () => careApi.setWorkflow(conversationId, { ...body, ...(conversation?.workflow ? { expectedStateRevision: conversation.workflow.stateRevision } : {}) }),
    (c) => onWorkflow?.({ conversation: c, action }),
  );

  /** Gửi: approves the exact revision the owner is looking at (a stale one is a 409 and the card reloads). */
  async function draftApprove(d: CareInlineDraftDto, editedText?: string): Promise<void> {
    setDraftAction('send');
    try {
      let revision = d.payloadRevision ?? (await careApi.drafts(['draft', 'needs_review']).then((r) => r.items.find((x) => x.id === d.id)?.payloadRevision));
      if (typeof revision !== 'number') throw new Error('revision');
      // "Sửa rồi gửi": the edit becomes the next revision first, then that revision is approved.
      if (editedText !== undefined) revision = (await careApi.editDraft(d.id, { expectedRevision: revision, text: editedText })).payloadRevision;
      const approved = await careApi.approveDraft(d.id, revision);
      // The approved delivery is tracked like a typed reply, so its chip and the sent message show up in the timeline.
      if (approved && typeof approved.id === 'string') intentStore.upsert(conversationId, approved, editedText ?? d.text);
      pushToast({ tone: 'success', title: ct('bot.draft.sent') });
      await Promise.all([extras.reloadDrafts(), refresh()]);
    } catch (e) {
      const f = toCareFailure(e);
      pushToast({ tone: 'error', title: ct('bot.draft.failed'), description: f.code === 'STALE_REVISION' ? ct('bot.draft.stale') : failureText(e) });
      void extras.reloadDrafts();
    } finally {
      setDraftAction(null);
    }
  }

  async function draftDiscard(d: CareInlineDraftDto): Promise<void> {
    setDraftAction('discard');
    try {
      await careApi.discardDraft(d.id);
      setDraftNote('discarded');
      await extras.reloadDrafts();
    } catch (e) {
      pushToast({ tone: 'error', title: ct('bot.draft.discardFailed'), description: failureText(e) });
    } finally {
      setDraftAction(null);
    }
  }

  // aria-live announcement for a customer message that arrives while the thread is open.
  const announce = state.announce;

  if (state.loading && !conversation) return <div class="care-detail"><PageState loading /></div>;
  if (state.error && !conversation) {
    return (
      <div class="care-detail">
        <button type="button" class="care-back" onClick={onBack}><ArrowLeft size={14} aria-hidden="true" /> {ct('detail.back')}</button>
        <PageState error={state.error.code === 'NOT_FOUND' ? ct('detail.notFound') : state.error.message} />
      </div>
    );
  }
  if (!conversation) return null;

  const account = accounts.find((a) => a.id === conversation.accountId);
  const isEmail = conversation.channel === 'email';
  const wf = conversation.workflow;
  const nowMs = Date.now();
  const participants = Array.from(new Set(w.items.filter((m) => m.senderRole === 'customer' && m.senderIdentityId).map((m) => m.senderIdentityId as string)));
  const title = conversationTitle(conversation.title) || ct('list.untitled');
  // Until (or without) the channel's profiles, a 1-1 chat still names its person: the conversation title and stored picture.
  const people = profiles ?? (conversation.kind === 'direct'
    ? { thread: { name: conversationTitle(conversation.title), avatarUrl: conversation.avatarUrl ?? '' }, senders: {} }
    : null);
  const bot = stateChip(wf?.bot?.label);
  // "Bạn tự nhắn thì bot nhường": only worth saying while a bot could answer here
  const yieldMinutes = wf?.bot && wf.bot.mode && wf.bot.mode !== 'observe' && wf.bot.humanPauseMinutes ? wf.bot.humanPauseMinutes : null;
  const aiOn = Boolean(wf?.bot && (wf.bot.label === 'active' || wf.bot.label === 'review'));
  const onAccepted = () => {
    // A reply typed by hand while an AI draft was waiting retires that draft.
    setDraftNote(visibleDraft ? 'superseded' : null);
    void refresh();
    void extras.reloadDrafts();
  };

  let statusChip: { tone: string; text: string } | null = null;
  if (wf) {
    if (wf.status === 'open') statusChip = { tone: 'warn', text: conversation.waitingSinceMs !== null ? ct('inbox2.status.openWait', { wait: waitText(waitMinutes(conversation.waitingSinceMs, nowMs)) }) : ct('inbox2.status.open') };
    else if (wf.status === 'pending') statusChip = { tone: 'neutral', text: ct('inbox2.status.pending') };
    else if (wf.status === 'snoozed') statusChip = { tone: 'neutral', text: wf.snoozedUntilMs !== null ? ct('inbox2.snooze.until', { when: snoozeUntilText(wf.snoozedUntilMs, nowMs) }) : ct('inbox2.status.snoozed') };
    else statusChip = { tone: 'done', text: ct('inbox2.status.done') };
  } else if (conversation.waitingSinceMs !== null) {
    statusChip = { tone: 'warn', text: ct('filters.waiting') };
  }

  return (
    <div class="care-detail-wrap" data-panel={panel.open ? (panel.wide ? 'column' : 'drawer') : 'closed'}>
    <section class="care-detail" aria-label={ct('a11y.detailRegion')} data-testid="care-detail">
      <header class="care-detail-head">
        <button type="button" class="care-back" onClick={onBack} aria-label={ct('detail.back')}><ArrowLeft size={15} aria-hidden="true" /></button>
        <Avatar id={conversation.id} title={title} channel={conversation.channel} url={people?.thread.avatarUrl || conversation.avatarUrl} />
        <div class="care-detail-title">
          <h2>{title}</h2>
          <div class="care-detail-sub">
            <ChannelBadge channel={conversation.channel} account={account?.label} />
            {conversation.kind !== 'direct' && conversation.kind !== 'email_thread' && <span class="care-chip">{ct(`kind.${conversation.kind}`)}</span>}
            {statusChip && <span class={`care-chip is-status-${statusChip.tone}`} data-testid="care-status-chip">{statusChip.text}</span>}
            {bot && <span class={`care-chip care-state is-state-${bot.tone}`} data-testid="care-head-state">{bot.text}</span>}
          </div>
        </div>
        {wf && (
          <>
            <SnoozeMenu busy={wfBusy} onPick={(untilMs) => void workflow({ action: 'snooze', snoozeUntilMs: untilMs }, 'snooze')} />
            {(wf.status === 'done' || wf.status === 'snoozed') && (
              <button type="button" class="care-ctl" disabled={wfBusy} onClick={() => void workflow({ action: 'reopen' }, 'reopen')} data-testid="care-reopen">
                <RotateCcw size={13} aria-hidden="true" /> <span class="care-btn-label">{ct('inbox2.reopen')}</span>
              </button>
            )}
            {wf.status !== 'done' && (
              <button type="button" class="care-ctl is-done" disabled={wfBusy} onClick={() => void workflow({ action: 'done' }, 'done')} data-testid="care-done">
                <Check size={13} aria-hidden="true" /> <span class="care-btn-label">{ct('inbox2.done')}</span>
              </button>
            )}
          </>
        )}
        {/* A server without inbox v2 has no AI bar: the old entry point stays. */}
        {!wf && (
          <button type="button" class="cc-button" disabled={draftBusy} onClick={() => void requestDraft()} data-testid="care-request-draft">
            {draftBusy ? <Loader2 size={12} class="animate-spin" aria-hidden="true" /> : <Bot size={12} aria-hidden="true" />} <span class="care-btn-label">{ct('detail.requestDraft')}</span>
          </button>
        )}
        {onOpenBot && (
          <button type="button" class="cc-button care-open-bot" onClick={onOpenBot} data-testid="care-open-bot">
            <Bot size={12} aria-hidden="true" /> <span>{ct('bot.open')}</span>
          </button>
        )}
        <button type="button" class={`cc-button${panel.open ? ' is-on' : ''}`} aria-pressed={panel.open} onClick={panel.toggle} data-testid="care-customer-toggle">
          <UserRound size={12} aria-hidden="true" /> <span class={panel.open && panel.wide ? 'care-sr-only' : 'care-btn-label'}>{ct('customer.drawer')}</span>
        </button>
      </header>

      <div class="care-sr-only" aria-live="polite" aria-atomic="true" data-testid="care-live">
        {announce ? ct('detail.newMessage', { text: announce.text }) : ''}
      </div>

      {state.behind && (
        <div class="care-banner is-info" role="status" data-testid="care-behind">
          <ArrowDownToLine size={13} aria-hidden="true" />
          <span>{ct('detail.behind')}</span>
          <button type="button" class="care-link-button" onClick={() => { if (around) onClearAround(); else reload(); }}>{ct('detail.jumpLatest')}</button>
        </div>
      )}

      <Timeline
        key={conversationId}
        window={w}
        channel={conversation.channel}
        profiles={people}
        notes={extras.notes}
        busyNote={busyNote}
        hitId={around ?? w.aroundId}
        tracked={tracked}
        busyIntent={busyIntent}
        loadingOlder={state.loadingOlder}
        loadingNewer={state.loadingNewer}
        onLoadOlder={() => void loadOlder()}
        onLoadNewer={() => void loadNewer()}
        onCancel={(id) => void act('cancel', id)}
        onReconcile={(id) => void act('reconcile', id)}
        onDeleteNote={(id) => {
          setBusyNote(id);
          extras.removeNote(id)
            .catch((e) => pushToast({ tone: 'error', title: ct('inbox2.note.deleteFailed'), description: failureText(e) }))
            .finally(() => setBusyNote(null));
        }}
      />

      {visibleDraft && (
        <InlineDraftCard
          draft={visibleDraft}
          more={extras.drafts.length - 1}
          agents={agents}
          busy={draftAction}
          onSend={() => void draftApprove(visibleDraft)}
          onSendEdited={(text) => void draftApprove(visibleDraft, text)}
          onDiscard={() => void draftDiscard(visibleDraft)}
        />
      )}
      {!visibleDraft && draftNote && (
        <DraftNote kind={draftNote} busy={draftBusy} canRetry={aiOn} onRedo={() => void requestDraft()} />
      )}

      {tab === 'note' ? (
        <NoteComposer conversationId={conversationId} channel={conversation.channel} tab={tab} onTab={setTab} onAdd={(body, id) => extras.addNote(body, id)} />
      ) : isEmail ? (
        <EmailComposer key={conversationId} conversation={conversation} messages={w.items} account={account} replyEnabled={replyEnabled} canned={canned} tab={tab} onTab={setTab} onAccepted={onAccepted} />
      ) : (
        <ChatComposer key={conversationId} conversation={conversation} messages={w.items} replyEnabled={replyEnabled} account={account} canned={canned} tab={tab} onTab={setTab} onAccepted={onAccepted} onAskBot={wf ? () => void requestDraft() : undefined} askBusy={draftBusy} yieldMinutes={yieldMinutes} />
      )}
    </section>
    {panel.open && (
      <CustomerDrawer
        conversation={conversation}
        participants={participants}
        variant={panel.wide ? 'column' : 'drawer'}
        onClose={panel.close}
        onOpenConversation={(cid, mid) => onOpenConversation(cid, mid)}
      />
    )}
    </div>
  );
}
