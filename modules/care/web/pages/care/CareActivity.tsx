import { Bot, Loader2, Send } from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { CareTabs } from '@modules/care/web/components/care/CareTabs';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { careApi } from '@modules/care/web/lib/care/client';
import type { CareAccountDto } from '@modules/care/web/lib/care/dto';
import type { CareActivityItemDto } from '@modules/care/server/api/dto-ops';
import { KNOWN_REASONS, activityTone, appendActivity, reasonCode } from '@modules/care/web/lib/care/activity';
import { toCareFailure } from '@modules/care/web/lib/care/failure';
import { ct } from '@modules/care/web/lib/care/i18n';
import '@modules/care/web/styles/care.css';

function reasonLabel(code: string | null): string | null {
  const c = reasonCode(code);
  if (!c) return null;
  return KNOWN_REASONS.has(c) ? ct(`activity.reason.${c}`) : c;
}

export function CareActivity() {
  const [items, setItems] = useState<CareActivityItemDto[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<CareAccountDto[]>([]);
  const [account, setAccount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => { careApi.accounts().then((r) => setAccounts(r.items)).catch(() => {}); }, []);
  useEffect(() => {
    let live = true;
    setItems(null); setError(null);
    careApi.activity({ account: account || undefined })
      .then((r) => { if (live) { setItems(r.items); setNext(r.nextCursor); } })
      .catch((e) => { if (live) setError(toCareFailure(e).message); });
    return () => { live = false; };
  }, [account, reload]);

  async function loadMore(): Promise<void> {
    if (!next || more) return;
    setMore(true);
    try {
      const r = await careApi.activity({ account: account || undefined, cursor: next });
      setItems((cur) => appendActivity(cur ?? [], r.items));
      setNext(r.nextCursor);
    } catch (e) { setError(toCareFailure(e).message); } finally { setMore(false); }
  }

  const accLabel = (id: string) => accounts.find((a) => a.id === id)?.label ?? id.slice(-6);

  return (
    <div class="care-page" data-testid="care-activity">
      <PageHeader compact breadcrumb={ct('page.breadcrumb')} title={ct('activity.title')} tabs={<CareTabs current="activity" />}
        actions={(
          <>
            <select class="care-select" aria-label={ct('filters.account')} value={account} onChange={(e) => setAccount((e.target as HTMLSelectElement).value)}>
              <option value="">{ct('filters.allAccounts')}</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
            <button type="button" class="cc-button" onClick={() => setReload((n) => n + 1)}>{ct('activity.refresh')}</button>
          </>
        )} />
      <div class="care-scroll-page">
        <p class="care-intro">{ct('activity.intro')}</p>
        {error && <PageState error={error} />}
        {!items && !error && <PageState loading />}
        {items && items.length === 0 && <PageState empty emptyTitle={ct('activity.empty')} />}
        <ol class="care-activity" aria-label={ct('activity.title')}>
          {(items ?? []).map((i) => {
            const why = i.kind === 'run' ? reasonLabel(i.skipReason) : reasonLabel(i.statusReason);
            return (
              <li key={`${i.kind}:${i.id}`} class="care-act" data-testid="care-activity-item" data-kind={i.kind}>
                <span class="care-act-icon" aria-hidden="true">{i.kind === 'run' ? <Bot size={14} /> : <Send size={14} />}</span>
                <div class="care-act-main">
                  <div class="care-act-head">
                    <strong>{i.kind === 'run' ? ct('activity.run') : ct('activity.delivery')}</strong>
                    <span class={`care-status-chip tone-${activityTone(i)}`}>{ct(`activity.status.${i.status}`)}</span>
                    {i.kind === 'run' && i.mode && <span class="care-chip">{ct(`rules.modes.${i.mode}`)}</span>}
                    {i.kind === 'run' && <span class="care-chip">{ct(`activity.trigger.${i.triggerKind}`)}</span>}
                    {i.kind === 'delivery' && <span class="care-chip">{ct(`drafts.actor.${i.actor}`)}</span>}
                    {i.kind === 'delivery' && i.receiptLevel && <span class="care-chip">{ct(`activity.receipt.${i.receiptLevel}`)}</span>}
                  </div>
                  {why && <p class="care-act-reason" data-testid="care-activity-reason">{ct('activity.because')}: {why}</p>}
                  <div class="care-faint">
                    {accLabel(i.accountId)} · {new Date(i.atMs).toLocaleString('vi-VN')}
                    {i.conversationId && <> · <Link href={`/m/care/inbox/${encodeURIComponent(i.conversationId)}`} class="care-inline-link">{ct('drafts.openConversation')}</Link></>}
                    {i.kind === 'run' && i.draftRef && <> · <Link href="/m/care/drafts" class="care-inline-link">{ct('activity.openDraft')}</Link></>}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
        {next && <div class="care-center"><button type="button" class="cc-button" disabled={more} onClick={() => void loadMore()} data-testid="care-activity-more">{more && <Loader2 size={12} class="animate-spin" aria-hidden="true" />} {ct('list.loadMore')}</button></div>}
      </div>
    </div>
  );
}
