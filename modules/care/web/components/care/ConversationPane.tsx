import { ArrowLeft, ArrowDownToLine, Bot, Check, Loader2, RotateCcw, UserRound } from 'lucide-preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { ChannelBadge } from './ChannelBadge';
import { ChatComposer } from './ChatComposer';
import { EmailComposer } from './EmailComposer';
import { conversationTitle } from '@modules/care/web/lib/care/title';
import { Timeline } from './Timeline';
import { CustomerDrawer } from './customer/CustomerDrawer';
import { AiBar } from './inbox/AiBar';
import { AssigneeMenu } from './inbox/AssigneeMenu';
import { Avatar } from './inbox/Avatar';
import type { ComposerTab } from './inbox/ComposerParts';
import { snoozeUntilText, waitText } from './inbox/format';
import { DraftNote, InlineDraftCard, type DraftNoteKind } from './inbox/InlineDraftCard';
import { SnoozeMenu } from './inbox/SnoozeMenu';
import { NoteComposer } from './NoteComposer';
import { ConfirmModal } from '@/components/ConfirmModal';
import { PageState } from '@/components/PageState';
import { careApi, type AssigneeChoice, type WorkflowAction } from '@modules/care/web/lib/care/client';
import type { CareAccountDto, CareCannedReplyDto, CareConversationDto, CareInlineDraftDto } from '@modules/care/web/lib/care/dto';
import { toCareFailure } from '@modules/care/web/lib/care/failure';
import { ct } from '@modules/care/web/lib/care/i18n';
import { draftStore, intentStore } from '@modules/care/web/lib/care/singletons';
import { useConversation } from '@modules/care/web/lib/care/useConversation';
import { draftText, newRequestId } from '@modules/care/web/lib/care/composer';
import { waitMinutes } from '@modules/care/web/lib/care/inboxView';
import { reasonText } from '@modules/care/web/lib/care/reasons';
import { useZaloProfiles } from '@modules/care/web/lib/care/zaloProfiles';
import { useCustomerPanel } from '@modules/care/web/lib/care/useCustomerPanel';
import { useConversationExtras, type AgentLite } from '@modules/care/web/lib/care/useInboxExtras';
import { pushToast } from '@/lib/toasts';

const POLL_MS = 3000;

export type WorkflowEvent = { conversation: CareConversationDto; action: 'done' | 'snooze' | 'reopen' };

function failureText(e: unknown): string {
  const f = toCareFailure(e);
  return reasonText(f.reason) ?? f.message;
}

export function ConversationPane({ conversationId, around, accounts, agents, canned, replyEnabled, convTick, resyncTick, onBack, onClearAround, onConversation, onOpenConversation, onWorkflow }: {
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
  const panel = useCustomerPanel();
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftAction, setDraftAction] = useState<'send' | 'discard' | null>(null);
  const [draftNote, setDraftNote] = useState<DraftNoteKind | null>(null);
  /** Drafts copied into the composer ("Sửa rồi gửi"): their card stays hidden. */
  const [editedIds, setEditedIds] = useState<string[]>([]);
  const [pendingEdit, setPendingEdit] = useState<CareInlineDraftDto | null>(null);
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

  // Open intents settle on the server; poll each by id until terminal (and on every stream tick).
  const open = intentStore.open(conversationId);
  const openKey = open.map((t) => t.intent.id).join(',');
  useEffect(() => {
    if (!openKey) return;
    let cancelled = false;
    const poll = () => {
      for (const t of intentStore.open(conversationId)) {
        careApi.outbox(t.intent.id).then((i) => { if (!cancelled) intentStore.upsert(conversationId, i); }).catch(() => {});
      }
    };
    poll();
    const h = setInterval(poll, POLL_MS);
    return () => { cancelled = true; clearInterval(h); };
  }, [conversationId, openKey, convTick]);

  const visibleDraft = extras.drafts.find((d) => !editedIds.includes(d.id)) ?? null;
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
  const pickAssignee = (choice: AssigneeChoice) => change(() => careApi.setAssignee(conversationId, choice));

  async function draftApprove(d: CareInlineDraftDto): Promise<void> {
    setDraftAction('send');
    try {
      const res = await careApi.approveInline(d.id);
      const r = res as { id?: unknown; status?: unknown; conversationId?: unknown } | null;
      // Some answers carry the delivery row; track it like a reply so the timeline shows its status.
      if (r && typeof r.id === 'string' && typeof r.status === 'string' && typeof r.conversationId === 'string') intentStore.upsert(conversationId, res as never, d.text);
      pushToast({ tone: 'success', title: ct('inbox2.draft.sentToast') });
      await Promise.all([extras.reloadDrafts(), refresh()]);
    } catch (e) {
      pushToast({ tone: 'error', title: ct('inbox2.draft.sendFailed'), description: failureText(e) });
      void extras.reloadDrafts();
    } finally {
      setDraftAction(null);
    }
  }

  async function draftDiscard(d: CareInlineDraftDto): Promise<void> {
    setDraftAction('discard');
    try {
      await careApi.discardInline(d.id);
      setDraftNote('discarded');
      await extras.reloadDrafts();
    } catch (e) {
      pushToast({ tone: 'error', title: ct('inbox2.draft.discardFailed'), description: failureText(e) });
    } finally {
      setDraftAction(null);
    }
  }

  /** Copies the draft into the composer (chat text, or email body + subject + recipients) and hides its card. */
  function loadDraft(d: CareInlineDraftDto): void {
    const isEmail = d.channel === 'email';
    if (isEmail) {
      draftStore.update(conversationId, 'email', (cur) => (cur.kind === 'email'
        ? { ...cur, mode: 'reply', body: d.text, subject: d.email?.subject ?? cur.subject, removedCc: [], recipients: d.email ? { to: d.email.to, cc: d.email.cc } : null, fromDraftId: d.id, requestId: null, payloadKey: null }
        : cur));
    } else {
      draftStore.update(conversationId, 'chat', (cur) => (cur.kind === 'chat' ? { ...cur, text: d.text, styles: undefined, mentions: undefined, fromDraftId: d.id, requestId: null, payloadKey: null } : cur));
    }
    setEditedIds((ids) => [...ids, d.id]);
    setDraftNote('edited');
    setTab('reply');
    setTimeout(() => document.getElementById(isEmail ? `care-mail-${conversationId}-body` : `care-chat-${conversationId}`)?.focus(), 0);
  }

  function editDraft(d: CareInlineDraftDto): void {
    const cur = draftStore.get(conversationId, d.channel === 'email' ? 'email' : 'chat');
    // Never drop what the owner already typed without asking.
    if (draftText(cur).trim() && draftText(cur) !== d.text) setPendingEdit(d);
    else loadDraft(d);
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
  const aiOn = Boolean(wf && wf.ai.supported && wf.ai.agentId && !wf.ai.takenOver && wf.ai.mode !== 'off');
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
        <Avatar id={conversation.id} title={title} channel={conversation.channel} url={profiles?.thread.avatarUrl} />
        <div class="care-detail-title">
          <h2>{title}</h2>
          <div class="care-detail-sub">
            <ChannelBadge channel={conversation.channel} account={account?.label} />
            {conversation.kind !== 'direct' && conversation.kind !== 'email_thread' && <span class="care-chip">{ct(`kind.${conversation.kind}`)}</span>}
            {statusChip && <span class={`care-chip is-status-${statusChip.tone}`} data-testid="care-status-chip">{statusChip.text}</span>}
          </div>
        </div>
        {wf && (
          <>
            <AssigneeMenu workflow={wf} agents={agents} isEmail={isEmail} busy={wfBusy} onPick={(c) => void pickAssignee(c)} />
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
        <button type="button" class={`cc-button${panel.open ? ' is-on' : ''}`} aria-pressed={panel.open} onClick={panel.toggle} data-testid="care-customer-toggle">
          <UserRound size={12} aria-hidden="true" /> <span class={panel.open && panel.wide ? 'care-sr-only' : 'care-btn-label'}>{ct('customer.drawer')}</span>
        </button>
      </header>

      {wf && <AiBar workflow={wf} agents={agents} isEmail={isEmail} busy={wfBusy} draftBusy={draftBusy} onMode={(m) => void change(() => careApi.setAiMode(conversationId, m))} onTakeover={(on) => void change(() => careApi.setTakeover(conversationId, on))} onRequestDraft={() => void requestDraft()} />}

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
        profiles={profiles}
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
          more={extras.drafts.filter((d) => !editedIds.includes(d.id)).length - 1}
          agents={agents}
          busy={draftAction}
          onSend={() => void draftApprove(visibleDraft)}
          onEdit={() => editDraft(visibleDraft)}
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
        <ChatComposer key={conversationId} conversation={conversation} messages={w.items} replyEnabled={replyEnabled} account={account} canned={canned} tab={tab} onTab={setTab} onAccepted={onAccepted} />
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
    <ConfirmModal
      open={pendingEdit !== null}
      onClose={() => setPendingEdit(null)}
      onConfirm={() => { if (pendingEdit) loadDraft(pendingEdit); setPendingEdit(null); }}
      title={ct('inbox2.draft.replaceTitle')}
      body={ct('inbox2.draft.replaceBody')}
      confirmLabel={ct('inbox2.draft.replaceConfirm')}
      cancelLabel={ct('identity.cancel')}
    />
    </div>
  );
}
