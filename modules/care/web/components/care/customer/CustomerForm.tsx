import { Link2Off, Loader2, RefreshCw, Save, Undo2 } from 'lucide-preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { CustomerTasks } from './CustomerTasks';
import { PageState } from '@/components/PageState';
import type { CustomerAdapter } from '@modules/care/web/lib/care/customer/adapters';
import {
  NEED_FIELDS, STAGES, classifySaveFailure, isDirty, rebaseEdits, validate, type CustomerFormValue, type CustomerSnapshot, type SaveProblem,
} from '@modules/care/web/lib/care/customer/model';
import { setDirty } from '@modules/care/web/lib/care/dirtyGuard';
import { toCareFailure } from '@modules/care/web/lib/care/failure';
import { ct } from '@modules/care/web/lib/care/i18n';
import { pushToast } from '@/lib/toasts';
import type { CareApiChannel } from '@modules/care/web/lib/care/dto';

/**
 * Customer 360 form, shared across channels. It knows no URL: a `CustomerAdapter` loads and saves.
 * Saves are guarded by the revisions the operator saw; a legacy-owned account is shown read-only with
 * a pointer to the module that still owns it (not an error).
 */
export function CustomerForm({ adapter, dirtyKey, conversationId, channel, onTasksChanged }: {
  adapter: CustomerAdapter;
  dirtyKey: string;
  conversationId: string | null;
  channel: CareApiChannel;
  onTasksChanged?: () => void;
}) {
  const [snap, setSnap] = useState<CustomerSnapshot | null>(null);
  const [edited, setEdited] = useState<CustomerFormValue | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [problem, setProblem] = useState<SaveProblem | null>(null);
  const [rebased, setRebased] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  useEffect(() => {
    let live = true;
    setSnap(null); setEdited(null); setLoadError(null); setProblem(null); setRebased(null);
    adapter.load().then((s) => { if (live) { setSnap(s); setEdited(s.value); } })
      .catch((e) => { if (live) setLoadError(toCareFailure(e).code === 'NOT_FOUND' ? ct('customer.notFound') : toCareFailure(e).message); });
    return () => { live = false; };
  }, [adapter, reload]);

  const dirty = !!snap && !!edited && isDirty(snap.value, edited);
  useEffect(() => {
    setDirty(dirtyKey, dirty);
    return () => setDirty(dirtyKey, false);
  }, [dirty, dirtyKey]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  if (loadError) {
    return (
      <div class="care-pad" data-testid="care-customer-error">
        <PageState error={loadError} />
        <div class="care-center"><button type="button" class="cc-button" onClick={() => setReload((n) => n + 1)}>{ct('list.retry')}</button></div>
      </div>
    );
  }
  if (!snap || !edited) return <div class="care-pad"><PageState loading /></div>;

  const errors = validate(edited);
  const readOnly = !snap.writable;
  const set = (patch: Partial<CustomerFormValue>) => { setEdited({ ...edited, ...patch }); if (problem?.kind === 'invalid') setProblem(null); };
  const setNeed = (k: (typeof NEED_FIELDS)[number], v: string) => set({ need: { ...edited.need, [k]: v } });

  async function save(): Promise<void> {
    if (!snap || !edited || Object.keys(errors).length || busy) return;
    setBusy(true); setProblem(null); setRebased(null);
    try {
      const next = await adapter.save(snap, edited);
      if (!mounted.current) return;
      setSnap(next); setEdited(next.value);
      pushToast({ tone: 'success', title: ct('customer.saved') });
    } catch (e) {
      if (mounted.current) setProblem(classifySaveFailure(toCareFailure(e)));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  /** Reload the server copy and keep what the operator typed on top of it. */
  async function keepMine(): Promise<void> {
    if (!snap || !edited) return;
    setBusy(true);
    try {
      const fresh = await adapter.load();
      const { value, overlapping } = rebaseEdits(snap.value, edited, fresh.value);
      setSnap(fresh); setEdited(value); setProblem(null); setRebased(overlapping);
    } catch (e) {
      setProblem({ kind: 'other', message: toCareFailure(e).message });
    } finally {
      setBusy(false);
    }
  }

  async function refreshTasks(): Promise<void> {
    try {
      const fresh = await adapter.load();
      // Tasks only: revisions and the form value stay, so unsaved edits are not disturbed.
      setSnap((cur) => (cur ? { ...cur, tasks: fresh.tasks } : cur));
      onTasksChanged?.();
    } catch { /* the list keeps its previous rows */ }
  }

  const fieldError = (k: keyof typeof errors) => errors[k] && <span class="care-field-error" role="alert">{ct(`customer.error.${errors[k]}`)}</span>;
  const id = `care-cust-${dirtyKey}`;

  return (
    <div class="care-customer" data-testid="care-customer-form">
      <div class="care-save-bar">
        <span class="care-faint" aria-live="polite">{dirty ? ct('customer.dirty') : ct('customer.clean')}</span>
        <button type="button" class="cc-button" disabled={!dirty || busy} onClick={() => { setEdited(snap.value); setProblem(null); setRebased(null); }}>
          <Undo2 size={12} aria-hidden="true" /> {ct('customer.discard')}
        </button>
        <button type="button" class="cc-button is-primary" disabled={!dirty || busy || readOnly || Object.keys(errors).length > 0} onClick={() => void save()} data-testid="care-customer-save">
          {busy ? <Loader2 size={12} class="animate-spin" aria-hidden="true" /> : <Save size={12} aria-hidden="true" />} {busy ? ct('customer.saving') : ct('customer.save')}
        </button>
      </div>
      {readOnly && (
        <div class="care-banner is-info care-legacy" role="status" data-testid="care-legacy-owned">
          <Link2Off size={14} aria-hidden="true" />
          <span>
            <strong>{snap.writeOwner === 'draining' ? ct('customer.draining') : ct('customer.legacyOwned')}</strong>{' '}
          </span>
        </div>
      )}
      {problem && <ProblemBanner problem={problem} busy={busy} onKeepMine={() => void keepMine()} onReload={() => setReload((n) => n + 1)} />}
      {rebased && (
        <div class="care-banner is-info" role="status" data-testid="care-rebased">
          <span>{rebased.length ? ct('customer.rebasedOverlap', { fields: rebased.join(', ') }) : ct('customer.rebased')}</span>
        </div>
      )}

      <fieldset class="care-fieldset" disabled={readOnly || busy}>
        <div class="care-field">
          <label for={`${id}-name`}>{ct('customer.displayName')}</label>
          <input id={`${id}-name`} type="text" value={edited.displayName} maxLength={512} onInput={(e) => set({ displayName: (e.target as HTMLInputElement).value })} aria-invalid={!!errors.displayName} />
          {fieldError('displayName')}
        </div>
        <div class="care-grid-2">
          <div class="care-field">
            <label for={`${id}-stage`}>{ct('customer.stage')}</label>
            <select id={`${id}-stage`} value={edited.stage} onChange={(e) => set({ stage: (e.target as HTMLSelectElement).value as CustomerFormValue['stage'] })}>
              {STAGES.map((s) => <option key={s} value={s}>{ct(`customer.stages.${s}`)}</option>)}
            </select>
          </div>
          <div class="care-field">
            <label for={`${id}-owner`}>{ct('customer.owner')}</label>
            <input id={`${id}-owner`} type="text" value={edited.owner} maxLength={128} onInput={(e) => set({ owner: (e.target as HTMLInputElement).value })} />
          </div>
          <div class="care-field">
            <label for={`${id}-phone`}>{ct('customer.phone')}</label>
            <input id={`${id}-phone`} type="text" value={edited.phone} maxLength={64} onInput={(e) => set({ phone: (e.target as HTMLInputElement).value })} />
          </div>
          {adapter.capabilities.email && (
            <div class="care-field">
              <label for={`${id}-email`}>{ct('customer.email')}</label>
              <input id={`${id}-email`} type="text" value={edited.email} maxLength={320} onInput={(e) => set({ email: (e.target as HTMLInputElement).value })} aria-invalid={!!errors.email} />
              {fieldError('email')}
            </div>
          )}
          <div class="care-field">
            <label for={`${id}-company`}>{ct('customer.company')}</label>
            <input id={`${id}-company`} type="text" value={edited.company} maxLength={512} onInput={(e) => set({ company: (e.target as HTMLInputElement).value })} />
          </div>
          <div class="care-field">
            <label for={`${id}-tags`}>{ct('customer.tags')}</label>
            <input id={`${id}-tags`} type="text" value={edited.tags} maxLength={2000} onInput={(e) => set({ tags: (e.target as HTMLInputElement).value })} />
          </div>
        </div>

        <h3 class="care-subtitle">{ct('customer.need')}</h3>
        <div class="care-grid-2">
          {NEED_FIELDS.filter((k) => k !== 'details').map((k) => (
            <div class="care-field" key={k}>
              <label for={`${id}-need-${k}`}>{ct(`customer.needFields.${k}`)}</label>
              <input id={`${id}-need-${k}`} type="text" value={edited.need[k]} maxLength={200} onInput={(e) => setNeed(k, (e.target as HTMLInputElement).value)} />
            </div>
          ))}
        </div>
        <div class="care-field">
          <label for={`${id}-need-details`}>{ct('customer.needFields.details')}</label>
          <textarea id={`${id}-need-details`} rows={3} value={edited.need.details} maxLength={4000} onInput={(e) => setNeed('details', (e.target as HTMLTextAreaElement).value)} />
        </div>
        <div class="care-field">
          <label for={`${id}-note`}>{ct('customer.note')}</label>
          <textarea id={`${id}-note`} rows={4} value={edited.note} maxLength={20000} onInput={(e) => set({ note: (e.target as HTMLTextAreaElement).value })} data-testid="care-customer-note" />
          <span class="care-faint">{ct('customer.noteHint')}</span>
        </div>
      </fieldset>

      <div class="care-provenance" data-testid="care-provenance">
        <span class="care-faint">
          {ct('customer.revisions', { customer: snap.revisions.customer, profile: snap.revisions.profile ?? '—' })}
          {snap.profileProvenance ? ` · ${ct('customer.provenance', { source: provenanceLabel(snap.profileProvenance) })}` : ` · ${ct('customer.noProfile')}`}
        </span>
        {snap.otherProfiles.length > 0 && (
          <details>
            <summary>{ct('customer.otherProfiles', { n: snap.otherProfiles.length })}</summary>
            <ul class="care-other-profiles">
              {snap.otherProfiles.map((p) => (
                <li key={p.id}>
                  <strong>{provenanceLabel(p.provenance)}</strong> <span class="care-faint">#{p.revision}</span>
                  {p.note && <p>{p.note}</p>}
                </li>
              ))}
            </ul>
            <span class="care-faint">{ct('customer.otherProfilesHint')}</span>
          </details>
        )}
      </div>

      {snap.history.length > 0 && (
        <details class="care-history">
          <summary>{ct('customer.history', { n: snap.history.length })}</summary>
          <ul>{snap.history.slice(0, 20).map((h) => <li key={h.id}>{h.text} <span class="care-faint">{new Date(h.atMs).toLocaleString('vi-VN')}</span></li>)}</ul>
        </details>
      )}

      {adapter.capabilities.tasks === 'api' && (
        <CustomerTasks customerId={snap.customerId} conversationId={conversationId} tasks={snap.tasks} readOnly={readOnly} onChanged={() => void refreshTasks()} />
      )}

    </div>
  );
}

function provenanceLabel(p: string): string {
  if (p === 'care:customer_care') return ct('customer.prov.care');
  if (p === 'zalo:legacy') return ct('customer.prov.zaloLegacy');
  return p;
}

function ProblemBanner({ problem, busy, onKeepMine, onReload }: { problem: SaveProblem; busy: boolean; onKeepMine: () => void; onReload: () => void }) {
  if (problem.kind === 'legacy_owned') {
    return <div class="care-banner is-info" role="status" data-testid="care-legacy-owned-save"><Link2Off size={14} aria-hidden="true" /><span>{ct('customer.legacyOwned')}</span></div>;
  }
  if (problem.kind === 'draining') return <div class="care-banner is-warn" role="status"><span>{ct('customer.draining')}</span></div>;
  if (problem.kind === 'stale') {
    return (
      <div class="care-banner is-warn" role="alert" data-testid="care-stale">
        <span>{ct(problem.part === 'profile' ? 'customer.staleProfile' : 'customer.stale')}</span>
        <button type="button" class="care-link-button" disabled={busy} onClick={onKeepMine}><RefreshCw size={11} aria-hidden="true" /> {ct('customer.keepMine')}</button>
        <button type="button" class="care-link-button" disabled={busy} onClick={onReload}>{ct('customer.reloadTheirs')}</button>
      </div>
    );
  }
  if (problem.kind === 'gone') return <div class="care-banner is-error" role="alert"><span>{ct('customer.notFound')}</span></div>;
  if (problem.kind === 'invalid') return <div class="care-banner is-error" role="alert"><span>{ct('customer.invalid')}</span></div>;
  return <div class="care-banner is-error" role="alert"><span>{ct('customer.saveFailed', { message: problem.message })}</span></div>;
}
