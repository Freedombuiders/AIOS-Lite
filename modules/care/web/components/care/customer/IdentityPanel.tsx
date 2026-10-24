import { Link2, Loader2, Search, Unlink } from 'lucide-preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { LinkPreview } from './LinkPreview';
import { PageState } from '@/components/PageState';
import { careApi } from '@modules/care/web/lib/care/client';
import type { CareCustomerDetailDto, CareCustomerDto } from '@modules/care/web/lib/care/dto';
import type { CareLinkPreviewDto } from '@modules/care/server/api/dto-ops';
import {
  buildLinkBody, buildUnlinkBody, canLink, emptyChoices, requestIdFor, undecidedFieldNames, undecidedFromDetails, unlinkReady,
  type LinkChoices, type UndecidedItem,
} from '@modules/care/web/lib/care/customer/link';
import { newRequestId } from '@modules/care/web/lib/care/composer';
import { toCareFailure } from '@modules/care/web/lib/care/failure';
import { ct } from '@modules/care/web/lib/care/i18n';
import { reasonText } from '@modules/care/web/lib/care/reasons';
import { useDebouncedValue } from '@/lib/useDebounce';
import { pushToast } from '@/lib/toasts';

/** Identities of the customer, merge another customer in (preview first), and undo a link. */
export function IdentityPanel({ customerId, onChanged }: { customerId: string; onChanged: () => void }) {
  const [detail, setDetail] = useState<CareCustomerDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [q, setQ] = useState('');
  const dq = useDebouncedValue(q, 300).trim();
  const [found, setFound] = useState<CareCustomerDto[]>([]);
  const [other, setOther] = useState<CareCustomerDto | null>(null);
  const [preview, setPreview] = useState<CareLinkPreviewDto | null>(null);
  const [choices, setChoices] = useState<LinkChoices>(emptyChoices());
  const [needFields, setNeedFields] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const reqId = useRef<{ key: string; id: string } | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [undecided, setUndecided] = useState<UndecidedItem[]>([]);
  const [decisions, setDecisions] = useState<Record<string, string>>({});
  const unlinkReq = useRef<{ key: string; id: string } | null>(null);

  useEffect(() => {
    let live = true;
    setDetail(null); setError(null);
    careApi.customer(customerId).then((d) => { if (live) setDetail(d); }).catch((e) => { if (live) setError(toCareFailure(e).message); });
    return () => { live = false; };
  }, [customerId, reload]);

  useEffect(() => {
    if (dq.length < 2) { setFound([]); return; }
    let live = true;
    careApi.customers(new URLSearchParams({ q: dq, limit: '8' }).toString())
      .then((r) => { if (live) setFound(r.items.filter((c) => c.id !== customerId)); })
      .catch(() => { if (live) setFound([]); });
    return () => { live = false; };
  }, [dq, customerId]);

  function resetLink(): void {
    setOther(null); setPreview(null); setChoices(emptyChoices()); setNeedFields([]); setMessage(null); reqId.current = null;
  }

  async function pick(c: CareCustomerDto): Promise<void> {
    setOther(c); setBusy(true); setMessage(null); setPreview(null); setChoices(emptyChoices()); setNeedFields([]);
    try {
      setPreview(await careApi.previewLink({ customerIds: [c.id], targetCustomerId: customerId }));
    } catch (e) {
      setMessage(toCareFailure(e).message);
    } finally {
      setBusy(false);
    }
  }

  async function link(): Promise<void> {
    if (!preview || !other) return;
    const draft = buildLinkBody({ customerIds: [other.id] }, preview, choices, '');
    const { requestId: _drop, ...payload } = draft;
    reqId.current = requestIdFor(payload, reqId.current, newRequestId);
    setBusy(true); setMessage(null);
    try {
      const res = await careApi.link({ ...payload, requestId: reqId.current.id });
      pushToast({ tone: 'success', title: res.replayed ? ct('identity.linkReplayed') : ct('identity.linked', { n: res.movedIdentityIds.length }) });
      resetLink(); setQ(''); setReload((n) => n + 1); onChanged();
    } catch (e) {
      const f = toCareFailure(e);
      if (f.reason === 'UNDECIDED_ITEMS') {
        // Nothing was written: mark the fields that still need an explicit choice.
        setNeedFields(undecidedFieldNames(undecidedFromDetails(f.details)));
        // "Keep the target for the rest" is not enough for these: the server wants a stated choice.
        setChoices((c) => ({ ...c, keepTargetForUnresolved: false }));
        setMessage(ct('identity.undecidedFields'));
      } else if (f.code === 'STALE_REVISION') {
        setMessage(ct('identity.stale'));
        if (other) void pick(other);
      } else setMessage(reasonText(f.reason) ?? f.message);
    } finally {
      setBusy(false);
    }
  }

  async function unlink(): Promise<void> {
    if (!detail || selected.length === 0) return;
    const body = buildUnlinkBody(selected, { [detail.id]: detail.revision }, decisions, '');
    const { requestId: _drop, ...payload } = body;
    unlinkReq.current = requestIdFor(payload, unlinkReq.current, newRequestId);
    setBusy(true); setMessage(null);
    try {
      const res = await careApi.unlink({ ...payload, requestId: unlinkReq.current.id });
      pushToast({ tone: 'success', title: res.applied ? ct('identity.unlinked', { n: res.restored.length }) : ct('identity.unlinkNoop') });
      setSelected([]); setUndecided([]); setDecisions({}); unlinkReq.current = null; setReload((n) => n + 1); onChanged();
    } catch (e) {
      const f = toCareFailure(e);
      if (f.reason === 'UNDECIDED_ITEMS') {
        setUndecided(undecidedFromDetails(f.details));
        setMessage(ct('identity.undecidedItems'));
      } else if (f.code === 'STALE_REVISION') {
        setMessage(ct('identity.stale')); setReload((n) => n + 1);
      } else if (f.code === 'INVALID_COMMAND') {
        // The undo also needs the revisions of the customers it restores to; there is no preview for that yet.
        setMessage(ct('identity.unlinkNeedsPreview'));
      } else setMessage(reasonText(f.reason) ?? f.message);
    } finally {
      setBusy(false);
    }
  }

  if (error) return <PageState error={error} />;
  if (!detail) return <PageState loading />;
  const name = (id: string) => (id === detail.id ? ct('identity.thisCustomer') : `#${id.slice(-6)}`);

  return (
    <div class="care-identities" data-testid="care-identity-panel">
      <h3 class="care-subtitle">{ct('identity.title', { n: detail.identities.length })}</h3>
      <ul class="care-identity-list">
        {detail.identities.map((i) => (
          <li key={i.id}>
            <label>
              <input type="checkbox" checked={selected.includes(i.id)} onChange={() => { setSelected((cur) => (cur.includes(i.id) ? cur.filter((x) => x !== i.id) : [...cur, i.id])); setUndecided([]); setDecisions({}); }} aria-label={ct('identity.select', { name: i.displayName || i.username || i.namespace })} />
              <span>{i.displayName || i.username || i.namespace}</span>
            </label>
            <span class="care-faint">{i.namespace}{i.verified ? ` · ${ct('identity.verified')}` : ''}</span>
          </li>
        ))}
      </ul>
      {selected.length > 0 && (
        <div class="care-unlink">
          {undecided.length > 0 && (
            <div class="care-decisions" data-testid="care-unlink-decisions">
              <p class="care-faint">{ct('identity.undecidedItems')}</p>
              {undecided.map((u) => (
                <label key={u.itemKey} class="care-field">
                  <span>{ct(`identity.item.${u.type}`)} <code>{u.id.slice(-8)}</code></span>
                  <select value={decisions[u.itemKey] ?? ''} onChange={(e) => setDecisions({ ...decisions, [u.itemKey]: (e.target as HTMLSelectElement).value })}>
                    <option value="">{ct('identity.chooseKeeper')}</option>
                    {u.candidateCustomerIds.map((id) => <option key={id} value={id}>{name(id)}</option>)}
                  </select>
                </label>
              ))}
            </div>
          )}
          <button type="button" class="cc-button" disabled={busy || (undecided.length > 0 && !unlinkReady(undecided, decisions))} onClick={() => void unlink()} data-testid="care-unlink">
            <Unlink size={12} aria-hidden="true" /> {ct('identity.unlink', { n: selected.length })}
          </button>
        </div>
      )}

      <h3 class="care-subtitle">{ct('identity.mergeTitle')}</h3>
      <div class="care-search">
        <Search size={13} class="care-search-icon" aria-hidden="true" />
        <input type="search" aria-label={ct('identity.search')} placeholder={ct('identity.search')} value={q} onInput={(e) => { setQ((e.target as HTMLInputElement).value); if (other) resetLink(); }} data-testid="care-identity-search" />
      </div>
      {!other && found.length > 0 && (
        <ul class="care-found" data-testid="care-identity-found">
          {found.map((c) => (
            <li key={c.id}><button type="button" class="care-hit" onClick={() => void pick(c)}><span class="care-row-title">{c.displayName}</span><span class="care-faint">{[c.phone, c.email, c.company].filter(Boolean).join(' · ')}</span></button></li>
          ))}
        </ul>
      )}
      {busy && !preview && <div class="care-note"><Loader2 size={12} class="animate-spin" aria-hidden="true" /> {ct('list.loadingMore')}</div>}
      {preview && other && (
        <>
          <LinkPreview preview={preview} choices={choices} onChoices={setChoices} needFields={needFields} />
          <div class="care-composer-actions">
            <button type="button" class="cc-button is-primary" disabled={busy || !canLink(preview, choices)} onClick={() => void link()} data-testid="care-link-confirm">
              {busy ? <Loader2 size={12} class="animate-spin" aria-hidden="true" /> : <Link2 size={12} aria-hidden="true" />} {ct('identity.confirmLink')}
            </button>
            <button type="button" class="cc-button" disabled={busy} onClick={resetLink}>{ct('identity.cancel')}</button>
          </div>
        </>
      )}
      {message && <div class="care-banner is-warn" role="alert" data-testid="care-identity-message"><span>{message}</span></div>}
    </div>
  );
}
