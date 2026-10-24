// Inbox list, search hits and status/accounts, driven by filters + stream ticks.

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { careApi } from './client';
import { appendPage, emptyList, mergeHead, replaceConversation, type ConversationListState } from './cursor';
import type { CareAccountDto, CareConversationCounts, CareConversationDto, CareInboxCountsDto, CareSearchHitDto, CareSearchResultDto, CareStatusDto } from './dto';
import { toCareFailure, type CareFailure } from './failure';
import { conversationQuery, effectiveQuery, filterKey, searchQuery, type InboxFilters } from './filters';

const REFRESH_DEBOUNCE_MS = 350;

export interface InboxListState {
  list: ConversationListState;
  counts: CareConversationCounts | null;
  /** Tab counters (status + view); null while searching or on a server without inbox v2. */
  inboxCounts: CareInboxCountsDto | null;
  truncated: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: CareFailure | null;
}

const INITIAL: InboxListState = { list: emptyList(), counts: null, inboxCounts: null, truncated: false, loading: true, loadingMore: false, error: null };

export function useInboxList(filters: InboxFilters, listTick: number, resyncTick: number) {
  const [state, setState] = useState<InboxListState>(INITIAL);
  const seq = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const key = filterKey(filters);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const loadHead = useCallback(async (mode: 'reset' | 'merge') => {
    const mine = ++seq.current;
    if (mode === 'reset') setState({ ...INITIAL, loading: true });
    try {
      const page = await careApi.conversations(conversationQuery(filtersRef.current));
      if (mine !== seq.current) return;
      setState((s) => ({
        list: mode === 'reset' ? { items: page.items, nextCursor: page.nextCursor } : mergeHead(s.list, page),
        counts: page.counts,
        inboxCounts: page.inboxCounts ?? null,
        truncated: page.truncated,
        loading: false,
        loadingMore: false,
        error: null,
      }));
    } catch (e) {
      if (mine !== seq.current) return;
      const failure = toCareFailure(e);
      // A failed background refresh keeps the rows on screen; a failed first load shows the error.
      setState((s) => (mode === 'merge' && s.list.items.length ? { ...s, loading: false } : { ...INITIAL, loading: false, error: failure }));
    }
  }, []);

  // Filter change or resync: cursors minted for the old scope are meaningless, start over.
  useEffect(() => {
    void loadHead('reset');
  }, [key, resyncTick, loadHead]);

  // Stream events: refetch the head (debounced) and merge, keeping the user's scroll depth.
  const firstTick = useRef(listTick);
  useEffect(() => {
    if (listTick === firstTick.current) return;
    const h = setTimeout(() => void loadHead('merge'), REFRESH_DEBOUNCE_MS);
    return () => clearTimeout(h);
  }, [listTick, loadHead]);

  const loadMore = useCallback(async () => {
    const s = stateRef.current;
    const cursor = s.list.nextCursor;
    if (!cursor || s.loadingMore) return;
    const mine = seq.current;
    setState((x) => ({ ...x, loadingMore: true }));
    try {
      const page = await careApi.conversations(conversationQuery(filtersRef.current, cursor));
      if (mine !== seq.current) return;
      setState((x) => ({ ...x, loadingMore: false, list: appendPage(x.list, page), truncated: page.truncated }));
    } catch (e) {
      if (mine !== seq.current) return;
      setState((x) => ({ ...x, loadingMore: false, error: toCareFailure(e) }));
    }
  }, []);

  const patchConversation = useCallback((c: CareConversationDto) => {
    setState((s) => ({ ...s, list: replaceConversation(s.list, c) }));
  }, []);

  return { state, loadMore, patchConversation, refresh: () => loadHead('merge'), reload: () => loadHead('reset') };
}

export interface SearchState {
  hits: CareSearchHitDto[];
  scope: CareSearchResultDto['scope'] | null;
  truncated: boolean;
  nextCursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: CareFailure | null;
}

const NO_SEARCH: SearchState = { hits: [], scope: null, truncated: false, nextCursor: null, loading: false, loadingMore: false, error: null };

/** Message-level search (/search). Idle (no request) while the query is shorter than the minimum. */
export function useMessageSearch(filters: InboxFilters, resyncTick: number) {
  const [state, setState] = useState<SearchState>(NO_SEARCH);
  const seq = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const q = effectiveQuery(filters.q);
  const account = filters.accountId;

  useEffect(() => {
    const mine = ++seq.current;
    if (!q) {
      setState(NO_SEARCH);
      return;
    }
    setState({ ...NO_SEARCH, loading: true });
    careApi.search(searchQuery({ ...filters, q }))
      .then((r) => {
        if (mine !== seq.current) return;
        setState({ ...NO_SEARCH, hits: r.items, scope: r.scope, truncated: r.truncated, nextCursor: r.nextCursor });
      })
      .catch((e) => {
        if (mine !== seq.current) return;
        setState({ ...NO_SEARCH, error: toCareFailure(e) });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, account, resyncTick]);

  const loadMore = useCallback(async () => {
    const s = stateRef.current;
    if (!s.nextCursor || s.loadingMore || !q) return;
    const mine = seq.current;
    setState((x) => ({ ...x, loadingMore: true }));
    try {
      const r = await careApi.search(searchQuery({ ...filters, q }, s.nextCursor));
      if (mine !== seq.current) return;
      setState((x) => ({ ...x, loadingMore: false, hits: [...x.hits, ...r.items.filter((h) => !x.hits.some((y) => y.messageId === h.messageId))], scope: r.scope, truncated: r.truncated, nextCursor: r.nextCursor }));
    } catch (e) {
      if (mine !== seq.current) return;
      setState((x) => ({ ...x, loadingMore: false, error: toCareFailure(e) }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, account]);

  return { state, loadMore };
}

export interface MetaState {
  status: CareStatusDto | null;
  accounts: CareAccountDto[];
  accountsLoaded: boolean;
  error: CareFailure | null;
}

/** Totals + reply capability (/status) and accounts, refreshed on stream ticks. */
export function useCareMeta(listTick: number, accountsTick: number, resyncTick: number): MetaState {
  const [status, setStatus] = useState<CareStatusDto | null>(null);
  const [accounts, setAccounts] = useState<CareAccountDto[]>([]);
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const [error, setError] = useState<CareFailure | null>(null);

  useEffect(() => {
    const first = listTick === 0 && resyncTick === 0;
    const h = setTimeout(() => {
      careApi.status().then((s) => { setStatus(s); setError(null); }).catch((e) => setError(toCareFailure(e)));
    }, first ? 0 : REFRESH_DEBOUNCE_MS);
    return () => clearTimeout(h);
  }, [listTick, resyncTick]);

  useEffect(() => {
    let live = true;
    careApi.accounts().then((r) => { if (live) { setAccounts(r.items); setAccountsLoaded(true); } }).catch(() => { if (live) setAccountsLoaded(true); });
    return () => { live = false; };
  }, [accountsTick, resyncTick]);

  return { status, accounts, accountsLoaded, error };
}
