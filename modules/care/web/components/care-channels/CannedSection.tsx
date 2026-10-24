// "Câu trả lời nhanh": the replies typed as `/shortcut` in the composer. List, add / edit in a drawer, delete with an in-page confirm.
import { Pencil, Plus, Trash2 } from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import { ConfirmModal } from '@/components/ConfirmModal';
import { PageState } from '@/components/PageState';
import { channelsApi } from '@modules/care/web/lib/care-channels/api';
import { BODY_MAX, TITLE_MAX, cannedBody, draftFromCanned, emptyCanned, hasErrors, nextSort, normalizeShortcut, sortCanned, validateCanned, type CannedDraft, type CannedErrors } from '@modules/care/web/lib/care-channels/canned';
import { cc } from '@modules/care/web/lib/care-channels/i18n';
import { pushToast } from '@/lib/toasts';
import type { CareCannedReplyDto } from '@modules/care/server/api/dto-inbox';
import { SideDrawer } from './EditorShell';
import { errMsg } from './shared';

export function CannedSection() {
  const [items, setItems] = useState<CareCannedReplyDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; draft: CannedDraft } | null>(null);
  const [removing, setRemoving] = useState<CareCannedReplyDto | null>(null);

  async function load(): Promise<void> {
    try { setItems(sortCanned((await channelsApi.canned()).items)); setError(null); } catch (e) { setError(errMsg(e)); }
  }
  useEffect(() => { void load(); }, []);

  async function remove(c: CareCannedReplyDto): Promise<void> {
    try {
      await channelsApi.deleteCanned(c.id);
      pushToast({ tone: 'success', title: cc('canned.deleted') });
    } catch (e) {
      pushToast({ tone: 'error', title: cc('canned.deleteFailed'), description: errMsg(e) });
    }
    void load();
  }

  return (
    <section class="cch-panel" aria-labelledby="cch-canned-h" data-testid="cch-canned">
      <div class="cch-section-head">
        <h2 id="cch-canned-h" class="cch-h2">{cc('canned.title')}</h2>
        <button type="button" class="cch-btn" onClick={() => setEditing({ id: null, draft: emptyCanned() })} data-testid="cch-canned-add"><Plus size={13} aria-hidden="true" /> {cc('canned.add')}</button>
      </div>
      {error && !items && <PageState error={error} />}
      {!items && !error && <PageState loading />}
      {items && items.length === 0 && <div class="cch-empty" data-testid="cch-canned-empty">{cc('canned.empty')}<p>{cc('canned.emptyHint')}</p></div>}
      {items && items.length > 0 && (
        <ul class="cch-canned">
          {items.map((c) => (
            <li key={c.id} data-testid="cch-canned-row" data-shortcut={c.shortcut}>
              <b>/{c.shortcut}</b>
              <span class="cch-canned-text">{c.title}<small>{c.body}</small></span>
              <span class="cch-row-actions">
                <button type="button" class="care-icon-button" onClick={() => setEditing({ id: c.id, draft: draftFromCanned(c) })} aria-label={cc('canned.editOne', { shortcut: c.shortcut })} data-testid="cch-canned-edit"><Pencil size={13} aria-hidden="true" /></button>
                <button type="button" class="care-icon-button" onClick={() => setRemoving(c)} aria-label={cc('canned.deleteOne', { shortcut: c.shortcut })} data-testid="cch-canned-delete"><Trash2 size={13} aria-hidden="true" /></button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div class="cch-sub">{cc('canned.note')}</div>

      {editing && <CannedDrawer id={editing.id} initial={editing.draft} existing={items ?? []} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
      <ConfirmModal
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={() => { if (removing) void remove(removing); setRemoving(null); }}
        title={cc('canned.deleteTitle')}
        body={removing ? cc('canned.deleteBody', { shortcut: removing.shortcut }) : ''}
        confirmLabel={cc('canned.delete')}
        cancelLabel={cc('cancel')}
        destructive
      />
    </section>
  );
}

function CannedDrawer({ id, initial, existing, onClose, onSaved }: { id: string | null; initial: CannedDraft; existing: CareCannedReplyDto[]; onClose: () => void; onSaved: () => void }) {
  const [draft, setDraft] = useState<CannedDraft>(initial);
  const [shown, setShown] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errors: CannedErrors = validateCanned(draft, existing, id);
  const set = (patch: Partial<CannedDraft>) => { setDraft((d) => ({ ...d, ...patch })); setServerError(null); };
  const show = (f: keyof CannedErrors) => (shown || draft[f].length > 0) && errors[f] ? cc(`canned.err.${errors[f]}`) : null;

  async function submit(e?: Event): Promise<void> {
    e?.preventDefault();
    setShown(true);
    if (hasErrors(errors)) return;
    setBusy(true);
    try {
      if (id) await channelsApi.updateCanned(id, cannedBody(draft));
      else await channelsApi.createCanned(cannedBody(draft, nextSort(existing)));
      pushToast({ tone: 'success', title: cc('canned.saved') });
      onSaved();
    } catch (err) {
      const status = (err as { status?: number })?.status;
      setServerError(status === 409 ? cc('canned.err.shortcutTaken') : errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SideDrawer
      title={id ? cc('canned.editTitle') : cc('canned.addTitle')}
      width={480}
      onClose={onClose}
      testId="cch-canned-drawer"
      footer={(
        <>
          <button type="button" class="cch-btn" onClick={onClose} disabled={busy}>{cc('cancel')}</button>
          <button type="button" class="cch-btn is-primary" style={{ marginLeft: 'auto' }} onClick={() => void submit()} disabled={busy} data-testid="cch-canned-save">{cc('save')}</button>
        </>
      )}
    >
      <form class="care-fieldset" onSubmit={(e) => void submit(e)} noValidate>
        <div class="care-field">
          <label for="cch-c-shortcut">{cc('canned.shortcut')}</label>
          <div class="cch-shortcut">
            <span aria-hidden="true">/</span>
            <input id="cch-c-shortcut" type="text" maxLength={33} autocomplete="off" value={draft.shortcut} placeholder="nhantien" aria-invalid={Boolean(show('shortcut'))} aria-describedby="cch-c-shortcut-h"
              onInput={(e) => set({ shortcut: (e.target as HTMLInputElement).value })} onBlur={() => setDraft((d) => ({ ...d, shortcut: normalizeShortcut(d.shortcut) }))} data-testid="cch-c-shortcut" />
          </div>
          <span id="cch-c-shortcut-h" class="cch-sub">{cc('canned.shortcutHint')}</span>
          {show('shortcut') && <span class="care-field-error" role="alert" data-testid="cch-c-shortcut-error">{show('shortcut')}</span>}
        </div>
        <div class="care-field">
          <label for="cch-c-title">{cc('canned.titleLabel')}</label>
          <input id="cch-c-title" type="text" maxLength={TITLE_MAX + 20} value={draft.title} placeholder={cc('canned.titlePlaceholder')} onInput={(e) => set({ title: (e.target as HTMLInputElement).value })} data-testid="cch-c-title" />
          {show('title') && <span class="care-field-error" role="alert">{show('title')}</span>}
        </div>
        <div class="care-field">
          <label for="cch-c-body">{cc('canned.bodyLabel')}</label>
          <textarea id="cch-c-body" rows={6} value={draft.body} onInput={(e) => set({ body: (e.target as HTMLTextAreaElement).value })} data-testid="cch-c-body" />
          <span class="cch-sub">{draft.body.trim().length}/{BODY_MAX}</span>
          {show('body') && <span class="care-field-error" role="alert">{show('body')}</span>}
        </div>
        <div class="care-field">
          <label for="cch-c-email">{cc('canned.emailLabel')}</label>
          <textarea id="cch-c-email" rows={6} value={draft.emailBody} onInput={(e) => set({ emailBody: (e.target as HTMLTextAreaElement).value })} data-testid="cch-c-email" />
          <span class="cch-sub">{cc('canned.emailHint')}</span>
          {show('emailBody') && <span class="care-field-error" role="alert">{show('emailBody')}</span>}
        </div>
        {serverError && <span class="care-field-error" role="alert" data-testid="cch-c-server-error">{serverError}</span>}
      </form>
    </SideDrawer>
  );
}
