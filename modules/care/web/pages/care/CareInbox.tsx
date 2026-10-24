import { Inbox, Loader2, MessageSquareText, X } from 'lucide-preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { useLocation, useRoute, useSearch } from 'wouter-preact';
import { CareTabs } from '@modules/care/web/components/care/CareTabs';
import { ConnectionBanner } from '@modules/care/web/components/care/ConnectionBanner';
import { ConversationPane, type WorkflowEvent } from '@modules/care/web/components/care/ConversationPane';
import { ConversationRow } from '@modules/care/web/components/care/ConversationRow';
import { FilterBar } from '@modules/care/web/components/care/FilterBar';
import { AlertToggles } from '@modules/care/web/components/care/inbox/AlertToggles';
import { snoozeUntilText } from '@modules/care/web/components/care/inbox/format';
import { SearchHits } from '@modules/care/web/components/care/SearchHits';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { careApi } from '@modules/care/web/lib/care/client';
import { snapshotIsAhead } from '@modules/care/web/lib/care/cursor';
import { ct } from '@modules/care/web/lib/care/i18n';
import { EMPTY_FILTERS, effectiveQuery, filterKey, hasActiveFilters, reconcileAccount, type InboxFilters } from '@modules/care/web/lib/care/filters';
import { DEFAULT_WAIT_MINUTES, titleCount } from '@modules/care/web/lib/care/inboxView';
import { useBrowserAlerts, useInboxTitle } from '@modules/care/web/lib/care/useBrowserAlerts';
import { useCareMeta, useInboxList, useMessageSearch } from '@modules/care/web/lib/care/useInbox';
import { useAgents, useCanned } from '@modules/care/web/lib/care/useInboxExtras';
import { useCareStream } from '@modules/care/web/lib/care/useCareStream';
import { anyDirty } from '@modules/care/web/lib/care/dirtyGuard';
import { conversationTitle } from '@modules/care/web/lib/care/title';
import { toCareFailure } from '@modules/care/web/lib/care/failure';
import { pushToast } from '@/lib/toasts';
import { useDebouncedValue } from '@/lib/useDebounce';
import '@modules/care/web/styles/care.css';
import '@modules/care/web/styles/care-inbox.css';

const BASE = '/m/care/inbox';
const NOW_TICK_MS = 30_000;

function channelFromSearch(search: string): InboxFilters['channel'] {
  const v = new URLSearchParams(search).get('channel');
  return v === 'zalo' || v === 'email' ? v : '';
}

/** Re-renders every `ms` so wait chips ("Chờ 12 phút") keep counting without a server round trip. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(h);
  }, [ms]);
  return now;
}

interface ListNotice { id: string; title: string; action: WorkflowEvent['action']; untilMs: number | null }

export function CareInbox() {
  const [, navigate] = useLocation();
  const [, params] = useRoute(`${BASE}/:id`);
  const search = useSearch();
  const selectedId = params?.id ? decodeURIComponent(params.id) : null;
  const around = new URLSearchParams(search).get('around');
  // `?channel=zalo|email` pre-selects the channel filter
  const channelParam = channelFromSearch(search);

  const [filters, setFilters] = useState<InboxFilters>({ ...EMPTY_FILTERS, channel: channelParam });
  useEffect(() => {
    if (channelParam) setFilters((f) => (f.channel === channelParam ? f : { ...f, channel: channelParam, accountId: '' }));
  }, [channelParam]);
  const { state: stream, retry } = useCareStream();
  const meta = useCareMeta(stream.listTick, stream.accountsTick, stream.resyncTick);
  // Typing is debounced; every other filter applies immediately.
  const debouncedQ = useDebouncedValue(filters.q, 300);
  const applied = useMemo(() => ({ ...filters, q: debouncedQ }), [filters, debouncedQ]);
  const inbox = useInboxList(applied, stream.listTick, stream.resyncTick);
  const hits = useMessageSearch(applied, stream.resyncTick);
  const { list, counts, inboxCounts, truncated } = inbox.state;
  const agents = useAgents();
  const canned = useCanned();
  const nowMs = useNow(NOW_TICK_MS);
  const [notice, setNotice] = useState<ListNotice | null>(null);

  // The stream may have attached after the first list fetch: if its snapshot knows more, refetch once.
  useEffect(() => {
    if (stream.snapshotTick === 0 || inbox.state.loading) return;
    if (snapshotIsAhead(list.items, stream.snapshotRows, list.nextCursor !== null)) void inbox.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream.snapshotTick]);

  const accounts = meta.accounts;
  const accountById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  function setFilterState(next: InboxFilters): void {
    setFilters(reconcileAccount(next, accounts));
  }
  /** Unsaved Customer 360 edits are never dropped by navigating: refuse and say why (same rule as the Zalo screen). */
  const blocked = (id: string | null): boolean => {
    if (!anyDirty() || id === selectedId) return false;
    pushToast({ tone: 'info', title: ct('customer.navBlocked') });
    return true;
  };
  const open = (id: string, aroundId?: string) => {
    if (blocked(id)) return;
    navigate(`${BASE}/${encodeURIComponent(id)}${aroundId ? `?around=${encodeURIComponent(aroundId)}` : ''}`);
  };
  const back = () => { if (!blocked(null)) navigate(BASE); };

  const status = meta.status;
  const searching = effectiveQuery(applied.q).length > 0;
  const showAccount = accounts.length > 1 && !filters.accountId;
  const titleOf = (id: string) => list.items.find((c) => c.id === id)?.title;
  const noAccounts = meta.accountsLoaded && accounts.length === 0 && !inbox.state.loading && list.items.length === 0 && !hasActiveFilters(filters);
  const waitThresholdMin = DEFAULT_WAIT_MINUTES;

  // Tab title "(N) Hộp thư chung": N = conversations that need the owner, measured on the default scope (status Mở, every
  // channel and account) so browsing another tab or channel does not make the number jump.
  const [needsMe, setNeedsMe] = useState<number | null>(null);
  useEffect(() => {
    const defaultScope = filters.wf === 'open' && !filters.channel && !filters.accountId && !filters.unread && !searching;
    const n = defaultScope ? titleCount(inboxCounts) : null;
    if (n !== null) setNeedsMe(n);
  }, [inboxCounts, filters.wf, filters.channel, filters.accountId, filters.unread, searching]);
  useInboxTitle(ct('page.title'), needsMe);

  const alerts = useBrowserAlerts({
    items: list.items,
    loading: inbox.state.loading,
    resetKey: filterKey(applied),
    openId: selectedId,
    prefs: null,
    titleOf: (c) => conversationTitle(c.title) || ct('list.untitled'),
    onOpen: open,
  });

  function onWorkflow(e: WorkflowEvent): void {
    const c = e.conversation;
    setNotice(e.action === 'reopen' ? null : { id: c.id, title: c.title, action: e.action, untilMs: c.workflow?.snoozedUntilMs ?? null });
    void inbox.refresh();
  }
  async function undo(n: ListNotice): Promise<void> {
    try {
      const c = await careApi.setWorkflow(n.id, { action: 'reopen' });
      inbox.patchConversation(c);
      setNotice(null);
      void inbox.refresh();
    } catch (e) {
      pushToast({ tone: 'error', title: ct('inbox2.changeFailed'), description: toCareFailure(e).message });
    }
  }

  const emptyKey = hasActiveFilters(filters) ? `inbox2.empty.${filters.wf}` : null;

  return (
    <div class="care-page" data-testid="care-inbox">
      <PageHeader
        compact
        breadcrumb={ct('page.breadcrumb')}
        title={ct('page.title')}
        tabs={<CareTabs current="inbox" />}
        actions={status && (
          <span class="care-totals" data-testid="care-totals" aria-label={ct('counts.global')}>
            <span>{ct('counts.total', { n: status.conversations.total })}</span>
            <span class="is-waiting">{ct('counts.waiting', { n: status.conversations.waiting })}</span>
            <span class="is-unread">{ct('counts.unread', { n: status.conversations.unread })}</span>
          </span>
        )}
      />
      <ConnectionBanner stream={stream} onRetry={retry} />

      <div class="care-layout" data-selected={selectedId ? 'true' : 'false'}>
        <aside class="care-list" aria-label={ct('a11y.listRegion')}>
          <FilterBar
            filters={filters}
            accounts={accounts}
            counts={searching ? null : inboxCounts}
            onChange={setFilterState}
            extra={<AlertToggles settings={alerts.settings} permission={alerts.permission} onSound={alerts.toggleSound} onNotify={() => void alerts.toggleNotify()} />}
          />
          {searching && !counts && <p class="care-faint care-search-note" data-testid="care-counts">{ct('counts.hidden')}</p>}

          {notice && (
            <div class="care-listnote" role="status" data-testid="care-list-notice">
              <span>{notice.action === 'done' ? ct('inbox2.banner.done', { name: notice.title }) : notice.untilMs !== null ? ct('inbox2.banner.snoozed', { name: notice.title, when: snoozeUntilText(notice.untilMs, nowMs) }) : ct('inbox2.banner.snoozedNoTime', { name: notice.title })}</span>
              <button type="button" class="care-link-button" onClick={() => void undo(notice)} data-testid="care-list-undo">{ct('inbox2.banner.undo')}</button>
              <button type="button" class="care-icon-button" aria-label={ct('stream.dismiss')} onClick={() => setNotice(null)}><X size={12} aria-hidden="true" /></button>
            </div>
          )}

          {truncated && (
            <div class="care-banner is-warn" role="status" data-testid="care-list-truncated"><span>{ct('list.truncated')}</span></div>
          )}

          <div class="care-list-scroll">
            {inbox.state.error && list.items.length === 0 && (
              <div>
                <PageState error={inbox.state.error.message || ct('list.loadError')} />
                <div class="care-center"><button type="button" class="cc-button" onClick={() => void inbox.reload()}>{ct('list.retry')}</button></div>
              </div>
            )}
            {inbox.state.loading && list.items.length === 0 && <PageState loading />}
            {!inbox.state.loading && !inbox.state.error && list.items.length === 0 && (
              <div class="care-empty" data-testid="care-empty">
                <Inbox size={20} aria-hidden="true" />
                <p>{searching ? ct('list.noMatch') : emptyKey ? ct(emptyKey) : noAccounts ? ct('list.empty') : accounts.length > 0 ? ct('inbox2.empty.open') : ct('list.noMatch')}</p>
                {!hasActiveFilters(filters) && noAccounts && <p class="care-faint">{ct('list.emptyHint')}</p>}
              </div>
            )}
            <div role="list">
              {list.items.map((c) => (
                <div role="listitem" key={c.id}>
                  <ConversationRow conversation={c} account={accountById.get(c.accountId)} agents={agents} waitThresholdMin={waitThresholdMin} nowMs={nowMs} active={c.id === selectedId} showAccount={showAccount} onSelect={() => open(c.id)} />
                </div>
              ))}
            </div>
            {list.nextCursor && (
              <div class="care-center">
                <button type="button" class="cc-button" disabled={inbox.state.loadingMore} onClick={() => void inbox.loadMore()} data-testid="care-load-more">
                  {inbox.state.loadingMore && <Loader2 size={12} class="animate-spin" aria-hidden="true" />} {inbox.state.loadingMore ? ct('list.loadingMore') : ct('list.loadMore')}
                </button>
              </div>
            )}
            {searching && <SearchHits state={hits.state} accounts={accounts} titleOf={titleOf} onOpen={open} onLoadMore={() => void hits.loadMore()} />}
          </div>
        </aside>

        <div class="care-main">
          {selectedId ? (
            <ConversationPane
              key={selectedId}
              conversationId={selectedId}
              around={around}
              accounts={accounts}
              agents={agents}
              canned={canned}
              replyEnabled={status ? status.replyEnabled : null}
              convTick={stream.convTicks[selectedId] ?? 0}
              resyncTick={stream.resyncTick}
              onBack={back}
              onClearAround={() => navigate(`${BASE}/${encodeURIComponent(selectedId)}`)}
              onOpenConversation={open}
              onConversation={inbox.patchConversation}
              onWorkflow={onWorkflow}
            />
          ) : (
            <div class="care-placeholder-pane">
              <MessageSquareText size={22} aria-hidden="true" />
              <span>{ct('detail.select')}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
