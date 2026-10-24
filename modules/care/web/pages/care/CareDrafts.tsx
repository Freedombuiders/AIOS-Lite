import { Check, Loader2, Save, Trash2, XCircle } from 'lucide-preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { CareTabs } from '@modules/care/web/components/care/CareTabs';
import { ChannelBadge } from '@modules/care/web/components/care/ChannelBadge';
import { DraftContext } from '@modules/care/web/components/care/DraftReview';
import { OutboxChip } from '@modules/care/web/components/care/OutboxChip';
import { ConfirmModal } from '@/components/ConfirmModal';
import { PageHeader, Tab } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { careApi } from '@modules/care/web/lib/care/client';
import type { CareDraftDto } from '@modules/care/server/api/dto-ops';
import {
  REVIEW_GROUPS, canCancelScheduled, draftPatch, editFromDraft, isReviewable, planApprove, validateEdit, type DraftEdit, type ReviewGroup,
} from '@modules/care/web/lib/care/draftReview';
import { toCareFailure } from '@modules/care/web/lib/care/failure';
import { ct } from '@modules/care/web/lib/care/i18n';
import { reasonText } from '@modules/care/web/lib/care/reasons';
import { pushToast } from '@/lib/toasts';
import '@modules/care/web/styles/care.css';
import '@modules/care/web/styles/care-inbox.css';

const GROUPS: ReviewGroup[] = ['review', 'scheduled', 'history'];

type ReviewRow = { kind: 'core'; id: string; atMs: number; draft: CareDraftDto };

export function CareDrafts() {
  const [group, setGroup] = useState<ReviewGroup>('review');
  const [items, setItems] = useState<CareDraftDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setItems(null); setError(null);
    careApi.drafts(REVIEW_GROUPS[group])
      .then((r) => { if (live) setItems(r.items); })
      .catch((e) => { if (live) setError(toCareFailure(e).message); });
    return () => { live = false; };
  }, [group, reload]);

  const rows = useMemo<ReviewRow[] | null>(() => {
    if (!items && !error) return null;
    return (items ?? []).map((d): ReviewRow => ({ kind: 'core', id: d.id, atMs: d.updatedAtMs, draft: d })).sort((a, b) => b.atMs - a.atMs);
  }, [items, error]);

  const selected = rows?.find((r) => r.id === selectedId) ?? null;

  return (
    <div class="care-page" data-testid="care-drafts">
      <PageHeader compact breadcrumb={ct('page.breadcrumb')} title={ct('drafts.title')} tabs={<CareTabs current="drafts" />}
        actions={<>{GROUPS.map((g) => <Tab key={g} label={ct(`drafts.group.${g}`)} active={g === group} onClick={() => { setGroup(g); setSelectedId(null); }} />)}</>} />
      <div class="care-layout" data-selected={selected ? 'true' : 'false'}>
        <aside class="care-list" aria-label={ct('drafts.list')}>
          <div class="care-list-scroll">
            {error && <PageState error={error} />}
            {!rows && !error && <PageState loading />}
            {rows && rows.length === 0 && <PageState empty emptyTitle={ct(`drafts.empty.${group}`)} />}
            <ul role="list">
              {(rows ?? []).map((r) => {
                const d = r.draft;
                const title = d.email ? d.email.subject || ct('msg.noSubject') : d.text.slice(0, 60);
                return (
                  <li key={r.id}>
                    <button type="button" class={`care-row${r.id === selectedId ? ' is-active' : ''}`} onClick={() => setSelectedId(r.id)} data-testid="care-draft-row" data-draft-id={r.id} data-source={r.kind} aria-current={r.id === selectedId ? 'true' : undefined}>
                      <span class="care-row-top"><span class="care-row-title">{title}</span><span class="care-row-time">{new Date(r.atMs).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}</span></span>
                      <span class="care-row-preview">{d.text}</span>
                      <span class="care-row-meta">
                        <ChannelBadge channel={d.channel} />
                        <span class="care-chip">{ct(`drafts.actor.${r.draft.actor}`)}</span><OutboxChip intent={r.draft} />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </aside>
        <div class="care-main">
          {selected ? (
            <DraftEditor key={selected.id} draft={selected.draft} onBack={() => setSelectedId(null)} onChanged={() => setReload((n) => n + 1)} />
          ) : (
            <div class="care-placeholder-pane"><span>{ct('drafts.select')}</span></div>
          )}
        </div>
      </div>
    </div>
  );
}

function DraftEditor({ draft: initial, onBack, onChanged }: { draft: CareDraftDto; onBack: () => void; onChanged: () => void }) {
  const [draft, setDraft] = useState(initial);
  const [edit, setEdit] = useState<DraftEdit>(editFromDraft(initial));
  const [busy, setBusy] = useState<'save' | 'approve' | 'discard' | 'cancel' | null>(null);
  const [message, setMessage] = useState<{ tone: 'warn' | 'error' | 'info'; text: string } | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const contextRev = useRef<number | undefined>(undefined);

  useEffect(() => {
    let live = true;
    // The conversation revision the reviewer is looking at; the server compares it with the draft's context.
    careApi.conversation(initial.conversationId).then((c) => { if (live) contextRev.current = c.revision; }).catch(() => {});
    return () => { live = false; };
  }, [initial.conversationId]);

  const errors = useMemo(() => validateEdit(draft, edit), [draft, edit]);
  const dirty = draftPatch(draft, edit) !== null;
  const plan = planApprove(draft, edit, contextRev.current);
  const reviewable = isReviewable(draft);
  const set = (patch: Partial<DraftEdit>) => { setEdit({ ...edit, ...patch }); setMessage(null); };

  function fail(e: unknown): void {
    const f = toCareFailure(e);
    if (f.code === 'STALE_REVISION') setMessage({ tone: 'warn', text: ct('drafts.stale', { revision: f.currentRevision ?? '?' }) });
    else setMessage({ tone: 'error', text: reasonText(f.reason) ?? f.message });
  }

  async function reloadLatest(): Promise<void> {
    try {
      const r = await careApi.drafts(['draft', 'pending', 'sending', 'retry_wait', 'sent', 'uncertain', 'needs_review', 'failed', 'cancelled', 'discarded']);
      const fresh = r.items.find((d) => d.id === draft.id);
      if (fresh) { setDraft(fresh); setEdit(editFromDraft(fresh)); setMessage(null); }
    } catch (e) { fail(e); }
  }

  async function save(): Promise<CareDraftDto | null> {
    const patch = draftPatch(draft, edit, contextRev.current);
    if (!patch) return draft;
    setBusy('save');
    try {
      const next = await careApi.editDraft(draft.id, patch);
      setDraft(next); setEdit(editFromDraft(next));
      return next;
    } catch (e) { fail(e); return null; } finally { setBusy(null); }
  }

  async function approve(): Promise<void> {
    if (errors.length > 0) return;
    // Approve exactly the revision shown: the loaded one, or the one the save above just produced.
    let revision = plan.kind === 'approve' ? plan.revision : -1;
    if (plan.kind === 'save_then_approve') {
      const saved = await save();
      if (!saved) return;
      revision = saved.payloadRevision;
    }
    setBusy('approve');
    try {
      await careApi.approveDraft(draft.id, revision, contextRev.current);
      pushToast({ tone: 'success', title: ct('drafts.approved') });
      onChanged();
      onBack();
    } catch (e) { fail(e); } finally { setBusy(null); }
  }

  async function discard(): Promise<void> {
    setBusy('discard');
    try { await careApi.discardDraft(draft.id); pushToast({ tone: 'success', title: ct('drafts.discarded') }); onChanged(); onBack(); } catch (e) { fail(e); } finally { setBusy(null); }
  }

  async function cancelScheduled(): Promise<void> {
    setBusy('cancel');
    try { await careApi.cancel(draft.id); pushToast({ tone: 'success', title: ct('drafts.cancelled') }); onChanged(); onBack(); } catch (e) { fail(e); } finally { setBusy(null); }
  }

  const err = (k: string) => errors.includes(k as never) && <span class="care-field-error" role="alert">{ct(`drafts.error.${k}`)}</span>;

  return (
    <section class="care-detail care-draft-editor" aria-label={ct('drafts.editor')} data-testid="care-draft-editor">
      <header class="care-detail-head">
        <button type="button" class="care-back" onClick={onBack} aria-label={ct('detail.back')}>←</button>
        <div class="care-detail-title">
          <h2>{draft.email ? ct('drafts.emailDraft') : ct('drafts.chatDraft')}</h2>
          <div class="care-detail-sub"><ChannelBadge channel={draft.channel} /><OutboxChip intent={draft} /><Link href={`/m/care/inbox/${encodeURIComponent(draft.conversationId)}`} class="care-inline-link" data-testid="care-draft-open">{ct('drafts.openConversation')}</Link></div>
        </div>
      </header>
      <div class="care-draft-body">
        <dl class="care-kv" data-testid="care-draft-meta">
          <div><dt>{ct('drafts.revision')}</dt><dd data-testid="care-draft-revision">{draft.payloadRevision}{draft.approvedRevision !== null ? ` · ${ct('drafts.approvedRevision', { n: draft.approvedRevision })}` : ''}</dd></div>
          <div><dt>{ct('drafts.origin')}</dt><dd>{ct(`drafts.actor.${draft.actor}`)}{draft.policyRevision ? ` · ${ct('drafts.policy', { rev: draft.policyRevision.slice(0, 8) })}` : ''}</dd></div>
        </dl>
        <DraftContext conversationId={draft.conversationId} />
        {message && <div class={`care-banner is-${message.tone}`} role="alert" data-testid="care-draft-message"><span>{message.text}</span>{message.tone === 'warn' && <button type="button" class="care-link-button" onClick={() => void reloadLatest()}>{ct('drafts.reload')}</button>}</div>}
        <fieldset class="care-fieldset" disabled={!reviewable || busy !== null}>
          {draft.email && (
            <>
              <div class="care-field"><label for="care-d-to">{ct('emailComposer.to')}</label><input id="care-d-to" type="text" value={edit.to} onInput={(e) => set({ to: (e.target as HTMLInputElement).value })} data-testid="care-draft-to" />{err('toRequired')}{err('toInvalid')}</div>
              <div class="care-field"><label for="care-d-cc">{ct('emailComposer.cc')}</label><input id="care-d-cc" type="text" value={edit.cc} onInput={(e) => set({ cc: (e.target as HTMLInputElement).value })} />{err('ccInvalid')}</div>
              <div class="care-field"><label for="care-d-subject">{ct('emailComposer.subject')}</label><input id="care-d-subject" type="text" value={edit.subject} onInput={(e) => set({ subject: (e.target as HTMLInputElement).value })} data-testid="care-draft-subject" />{err('subjectRequired')}</div>
              {draft.email.hasBcc && <p class="care-faint" data-testid="care-draft-bcc">{ct('drafts.hasBcc')}</p>}
            </>
          )}
          <div class="care-field"><label for="care-d-text">{ct('drafts.text')}</label><textarea id="care-d-text" rows={10} value={edit.text} onInput={(e) => set({ text: (e.target as HTMLTextAreaElement).value })} data-testid="care-draft-text" />{err('textRequired')}</div>
        </fieldset>
        {!reviewable && <p class="care-faint">{ct('drafts.readOnly')}</p>}
        <div class="care-composer-actions">
          {reviewable && (
            <>
              <button type="button" class="cc-button is-primary" disabled={busy !== null || errors.length > 0} onClick={() => void approve()} data-testid="care-draft-approve">
                {busy === 'approve' ? <Loader2 size={12} class="animate-spin" aria-hidden="true" /> : <Check size={12} aria-hidden="true" />} {dirty ? ct('drafts.saveAndApprove') : ct('drafts.approve')}
              </button>
              <button type="button" class="cc-button" disabled={!dirty || busy !== null || errors.length > 0} onClick={() => void save()} data-testid="care-draft-save"><Save size={12} aria-hidden="true" /> {ct('drafts.save')}</button>
              <button type="button" class="cc-button" disabled={busy !== null} onClick={() => setConfirmDiscard(true)} data-testid="care-draft-discard"><Trash2 size={12} aria-hidden="true" /> {ct('drafts.discard')}</button>
            </>
          )}
          {canCancelScheduled(draft) && (
            <button type="button" class="cc-button" disabled={busy !== null} onClick={() => void cancelScheduled()} data-testid="care-draft-cancel"><XCircle size={12} aria-hidden="true" /> {ct('drafts.cancelSend')}</button>
          )}
        </div>
        {reviewable && <p class="care-faint">{ct('drafts.approveHint', { revision: dirty ? ct('drafts.newRevision') : String(draft.payloadRevision) })}</p>}
      </div>
      <ConfirmModal open={confirmDiscard} onClose={() => setConfirmDiscard(false)} onConfirm={() => void discard()} title={ct('drafts.discardTitle')} body={ct('drafts.discardBody')} confirmLabel={ct('drafts.discard')} cancelLabel={ct('identity.cancel')} destructive />
    </section>
  );
}
