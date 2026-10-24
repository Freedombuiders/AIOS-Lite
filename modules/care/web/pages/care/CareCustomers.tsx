import { Search } from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import { Link, useLocation } from 'wouter-preact';
import { ChannelBadge } from '@modules/care/web/components/care/ChannelBadge';
import { CustomerTimeline } from '@modules/care/web/components/care/customer/CustomerTimeline';
import { CareTabs } from '@modules/care/web/components/care/CareTabs';
import { SideDrawer } from '@modules/care/web/components/care-channels/EditorShell';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { careApi } from '@modules/care/web/lib/care/client';
import type { CareApiStage, CareCustomerDetailDto, CareCustomerDto } from '@modules/care/web/lib/care/dto';
import { toCareFailure } from '@modules/care/web/lib/care/failure';
import { ct } from '@modules/care/web/lib/care/i18n';
import { cc } from '@modules/care/web/lib/care-channels/i18n';
import { customersQuery, relativeDay, stageTone, STAGES } from '@modules/care/web/lib/care-channels/customers';
import { useDebouncedValue } from '@/lib/useDebounce';
import '@modules/care/web/styles/care.css';
import '@modules/care/web/styles/care-channels.css';

/** /care/customers: search + stage filter over GET /api/m/care/customers; a row opens the customer's timeline in a drawer. */
export function CareCustomers() {
  const [, navigate] = useLocation();
  const [q, setQ] = useState('');
  const [stage, setStage] = useState<'' | CareApiStage>('');
  const dq = useDebouncedValue(q, 300);
  const [items, setItems] = useState<CareCustomerDto[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState<CareCustomerDto | null>(null);

  useEffect(() => {
    let live = true;
    setItems(null); setError(null);
    careApi.customers(customersQuery({ q: dq, stage }))
      .then((r) => { if (live) { setItems(r.items); setNext(r.nextCursor); } })
      .catch((e) => { if (live) setError(toCareFailure(e).message); });
    return () => { live = false; };
  }, [dq, stage]);

  async function loadMore(): Promise<void> {
    if (!next || more) return;
    setMore(true);
    try {
      const r = await careApi.customers(customersQuery({ q: dq, stage, cursor: next }));
      setItems((cur) => [...(cur ?? []), ...r.items.filter((i) => !(cur ?? []).some((c) => c.id === i.id))]);
      setNext(r.nextCursor);
    } catch (e) {
      setError(toCareFailure(e).message);
    } finally {
      setMore(false);
    }
  }

  return (
    <div class="care-page module-fill" data-testid="care-customers">
      <PageHeader compact breadcrumb={cc('breadcrumb')} title={cc('customers.title')} tabs={<CareTabs current="customers" />} />
      <div class="care-scroll-page">
        <div class="cch-page">
          <div class="cch-toolbar">
            <div class="cch-search">
              <Search size={14} aria-hidden="true" />
              <input type="search" value={q} placeholder={cc('customers.search')} aria-label={cc('customers.search')} onInput={(e) => setQ((e.target as HTMLInputElement).value)} data-testid="cch-customer-search" />
            </div>
            <select class="cch-select" value={stage} aria-label={cc('customers.stage')} onChange={(e) => setStage((e.target as HTMLSelectElement).value as '' | CareApiStage)} data-testid="cch-customer-stage">
              <option value="">{cc('customers.allStages')}</option>
              {STAGES.map((s) => <option key={s} value={s}>{ct(`customer.stages.${s}`)}</option>)}
            </select>
          </div>

          {error && <PageState error={error} />}
          {!items && !error && <PageState loading />}
          {items && items.length === 0 && <PageState empty emptyTitle={cc('customers.empty')} emptyDescription={q || stage ? cc('customers.emptyFiltered') : cc('customers.emptyHint')} />}
          {items && items.length > 0 && (
            <div class="cch-table-wrap">
              <table class="cch-table" style={{ minWidth: '640px' }}>
                <thead>
                  <tr>
                    <th scope="col">{cc('customers.col.name')}</th>
                    <th scope="col">{cc('customers.col.contact')}</th>
                    <th scope="col">{cc('customers.col.stage')}</th>
                    <th scope="col">{cc('customers.col.owner')}</th>
                    <th scope="col">{cc('customers.col.updated')}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((c) => (
                    <tr key={c.id} class="cch-cust-row" onClick={() => setOpen(c)} data-testid="cch-customer-row" data-customer-id={c.id}>
                      <td>
                        <button type="button" class="cch-name" onClick={(e) => { e.stopPropagation(); setOpen(c); }}>{c.displayName || cc('customers.unnamed')}</button>
                        {c.company && <span class="cch-from-inbox">{c.company}</span>}
                      </td>
                      <td class="cch-muted">{[c.phone, c.email].filter(Boolean).join(' · ') || '—'}</td>
                      <td><span class={`cch-stage is-${stageTone(c.stage)}`}>{ct(`customer.stages.${c.stage}`)}</span></td>
                      <td class="cch-muted">{c.owner || '—'}</td>
                      <td class="cch-muted">{relativeDay(c.updatedAtMs, Date.now())}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {next && <button type="button" class="cch-btn cch-more" disabled={more} onClick={() => void loadMore()} data-testid="cch-customers-more">{cc('customers.more')}</button>}
        </div>
      </div>

      {open && (
        <CustomerDrawer
          customer={open}
          onClose={() => setOpen(null)}
          onOpenConversation={(id, messageId) => navigate(`/m/care/inbox/${encodeURIComponent(id)}${messageId ? `?around=${encodeURIComponent(messageId)}` : ''}`)}
        />
      )}
    </div>
  );
}

function CustomerDrawer({ customer, onClose, onOpenConversation }: { customer: CareCustomerDto; onClose: () => void; onOpenConversation: (conversationId: string, messageId: string) => void }) {
  const [detail, setDetail] = useState<CareCustomerDetailDto | null>(null);
  useEffect(() => {
    let live = true;
    careApi.customer(customer.id).then((d) => { if (live) setDetail(d); }).catch(() => {});
    return () => { live = false; };
  }, [customer.id]);
  const c = detail ?? customer;
  return (
    <SideDrawer title={c.displayName || cc('customers.unnamed')} width={460} onClose={onClose} testId="cch-customer-drawer">
      <div class="cch-profile">
        <dl>
          <dt>{cc('customers.col.stage')}</dt><dd>{ct(`customer.stages.${c.stage}`)}</dd>
          {c.company && <><dt>{cc('customers.company')}</dt><dd>{c.company}</dd></>}
          {c.phone && <><dt>{cc('customers.phone')}</dt><dd>{c.phone}</dd></>}
          {c.email && <><dt>Email</dt><dd>{c.email}</dd></>}
          {c.tags && <><dt>{cc('customers.tags')}</dt><dd>{c.tags}</dd></>}
          {c.owner && <><dt>{cc('customers.col.owner')}</dt><dd>{c.owner}</dd></>}
        </dl>
      </div>
      {detail && detail.conversations.length > 0 && (
        <>
          <h3 class="care-subtitle">{cc('customers.conversations')}</h3>
          <ul class="cch-conv-links">
            {detail.conversations.slice(0, 6).map((conv) => (
              <li key={conv.id}><Link href={`/m/care/inbox/${encodeURIComponent(conv.id)}`}><ChannelBadge channel={conv.channel} /> {conv.title}</Link></li>
            ))}
          </ul>
        </>
      )}
      <h3 class="care-subtitle">{cc('customers.timeline')}</h3>
      <CustomerTimeline customerId={customer.id} onOpen={onOpenConversation} />
    </SideDrawer>
  );
}
