import { Loader2, TriangleAlert } from 'lucide-preact';
import { relTime } from '@modules/care/web/lib/care/timeFormat';
import { ct } from '@modules/care/web/lib/care/i18n';
import type { CareAccountDto } from '@modules/care/web/lib/care/dto';
import type { SearchState } from '@modules/care/web/lib/care/useInbox';

/** Message-level search results with the scope / truncated indicator the server reports. */
export function SearchHits({ state, accounts, titleOf, onOpen, onLoadMore }: {
  state: SearchState;
  accounts: CareAccountDto[];
  titleOf: (conversationId: string) => string | undefined;
  onOpen: (conversationId: string, around: string) => void;
  onLoadMore: () => void;
}) {
  const { hits, scope, truncated, loading, loadingMore, error, nextCursor } = state;
  return (
    <section class="care-hits" aria-label={ct('search.hitsTitle')} data-testid="care-search-hits">
      <h2 class="care-section-title">{ct('search.hitsTitle')}</h2>
      {loading && <div class="care-note" role="status"><Loader2 size={12} class="animate-spin" aria-hidden="true" /> {ct('list.loadingMore')}</div>}
      {error && <div class="care-note is-error" role="alert">{ct('search.error')}</div>}
      {scope && (
        <div class="care-scope" data-testid="care-search-scope">
          {ct('search.scope', { scanned: scope.scannedCandidates, budget: scope.candidateBudget })}
        </div>
      )}
      {truncated && scope && (
        <div class="care-banner is-warn" role="status" data-testid="care-search-truncated">
          <TriangleAlert size={13} aria-hidden="true" />
          <span>{ct('search.truncated', { budget: scope.candidateBudget })}</span>
        </div>
      )}
      {!loading && !error && scope && hits.length === 0 && <div class="care-note">{ct('search.noHits')}</div>}
      <ul class="care-hit-list">
        {hits.map((h) => {
          const acc = accounts.find((a) => a.id === h.accountId);
          return (
            <li key={h.messageId}>
              <button type="button" class="care-hit" onClick={() => onOpen(h.conversationId, h.around)} aria-label={`${ct('search.open')}: ${titleOf(h.conversationId) ?? ''}`} data-hit-id={h.messageId}>
                <span class="care-row-top">
                  <span class="care-row-title">{titleOf(h.conversationId) ?? acc?.label ?? h.conversationId}</span>
                  <span class="care-row-time">{relTime(h.sentAtMs)}</span>
                </span>
                <span class="care-hit-snippet">{h.snippet}</span>
                <span class="care-hit-meta">{h.matchedIn === 'body' ? ct('search.matchedBody') : ct('search.matchedMetadata')}{acc ? ` · ${acc.label}` : ''}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {nextCursor && (
        <button type="button" class="cc-button" disabled={loadingMore} onClick={onLoadMore}>
          {loadingMore && <Loader2 size={12} class="animate-spin" aria-hidden="true" />} {ct('search.loadMore')}
        </button>
      )}
    </section>
  );
}
