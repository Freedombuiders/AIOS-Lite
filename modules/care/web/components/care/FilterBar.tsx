import type { ComponentChildren } from 'preact';
import { Search, X } from 'lucide-preact';
import { ct } from '@modules/care/web/lib/care/i18n';
import { effectiveQuery, hasExtraFilters, reconcileAccount, type InboxFilters } from '@modules/care/web/lib/care/filters';
import { INBOX_STATUSES, INBOX_VIEWS } from '@modules/care/web/lib/care/inboxView';
import type { CareAccountDto, CareApiChannel, CareInboxCountsDto } from '@modules/care/web/lib/care/dto';

const CHANNELS: CareApiChannel[] = ['zalo', 'email'];

/** One select for "where": every channel, one channel, or one account (an account implies its channel). */
export function scopeValue(f: Pick<InboxFilters, 'channel' | 'accountId'>): string {
  if (f.accountId) return `acc:${f.accountId}`;
  return f.channel ? `ch:${f.channel}` : '';
}

export function scopePatch(value: string, accounts: CareAccountDto[]): Pick<InboxFilters, 'channel' | 'accountId'> {
  if (value.startsWith('acc:')) {
    const acc = accounts.find((a) => a.id === value.slice(4));
    return acc ? { channel: acc.channel, accountId: acc.id } : { channel: '', accountId: '' };
  }
  if (value.startsWith('ch:')) {
    const ch = value.slice(3) as CareApiChannel;
    return CHANNELS.includes(ch) ? { channel: ch, accountId: '' } : { channel: '', accountId: '' };
  }
  return { channel: '', accountId: '' };
}

/**
 * Three compact rows: search + scope (channel/account) + unread + extras, the "who handles it" tabs
 * (Cần tôi / AI đang lo / Chưa giao / Tất cả) and the status tabs (Mở / Chờ khách / Hoãn / Xong).
 * The tab counters come from the server and are absent while a text search is running.
 */
export function FilterBar({ filters, accounts, counts, onChange, extra }: {
  filters: InboxFilters;
  accounts: CareAccountDto[];
  /** `inboxCounts` of the last list answer; null while searching or on a server without inbox v2. */
  counts: CareInboxCountsDto | null;
  onChange: (next: InboxFilters) => void;
  /** Small icon controls shown at the end of the first row (sound / desktop alerts). */
  extra?: ComponentChildren;
}) {
  const searching = effectiveQuery(filters.q).length > 0;
  const set = (patch: Partial<InboxFilters>) => onChange(reconcileAccount({ ...filters, ...patch }, accounts));
  const clearExtras = () => onChange({ ...filters, channel: '', accountId: '', unread: false, q: '' });
  const channelsWithAccounts = CHANNELS.filter((c) => accounts.some((a) => a.channel === c));
  return (
    <div class="care-filters" role="search" aria-label={ct('filters.label')}>
      <div class="care-filter-top">
        <div class="care-search">
          <Search size={13} class="care-search-icon" aria-hidden="true" />
          <input
            type="search"
            aria-label={ct('filters.search')}
            placeholder={ct('inbox2.searchShort')}
            title={ct('filters.searchPlaceholder')}
            value={filters.q}
            data-testid="care-search"
            onInput={(e) => set({ q: (e.target as HTMLInputElement).value })}
          />
        </div>
        <select
          class="care-scope-select"
          aria-label={ct('filters.channel')}
          value={scopeValue(filters)}
          onChange={(e) => set(scopePatch((e.target as HTMLSelectElement).value, accounts))}
          data-testid="care-filter-scope"
        >
          <option value="">{ct('inbox2.channel.all')}</option>
          <optgroup label={ct('filters.channel')}>
            {(channelsWithAccounts.length ? channelsWithAccounts : CHANNELS).map((c) => <option key={c} value={`ch:${c}`}>{ct(`channel.${c}`)}</option>)}
          </optgroup>
          {accounts.length > 1 && (
            <optgroup label={ct('filters.account')}>
              {accounts.map((a) => <option key={a.id} value={`acc:${a.id}`}>{`${ct(`channel.${a.channel}`)} · ${a.label}`}</option>)}
            </optgroup>
          )}
        </select>
        <button type="button" class={`care-pill${filters.unread ? ' is-on' : ''}`} aria-pressed={filters.unread} onClick={() => set({ unread: !filters.unread })} data-testid="care-filter-unread">
          {ct('filters.unread')}
        </button>
        {hasExtraFilters(filters) && (
          <button type="button" class="care-icon-button" aria-label={ct('filters.clear')} title={ct('filters.clear')} onClick={clearExtras} data-testid="care-filter-clear">
            <X size={13} aria-hidden="true" />
          </button>
        )}
        {extra}
      </div>
      {searching && <p class="care-faint care-search-note" data-testid="care-search-allstatus">{ct('inbox2.search.allStatuses')}</p>}

      <div class="care-pills" role="tablist" aria-label={ct('inbox2.view.label')} data-disabled={searching ? 'true' : undefined}>
        {INBOX_VIEWS.map((v) => (
          <button key={v} type="button" role="tab" aria-selected={!searching && filters.view === v} disabled={searching} class={`care-pill${!searching && filters.view === v ? ' is-on' : ''}`} data-testid={`care-view-${v}`} onClick={() => set({ view: v })}>
            {ct(`inbox2.view.${v}`)}{counts && <span class="care-pill-n">{counts.byView[v]}</span>}
          </button>
        ))}
      </div>

      <div class="care-status-tabs" role="group" aria-label={ct('inbox2.status.label')}>
        {INBOX_STATUSES.map((s) => (
          <button key={s} type="button" aria-pressed={!searching && filters.wf === s} disabled={searching} class={`care-status-tab${!searching && filters.wf === s ? ' is-on' : ''}`} data-testid={`care-status-${s}`} onClick={() => set({ wf: s })}>
            {ct(`inbox2.status.tab.${s}`)}{counts && <span class="care-status-n">{counts.byStatus[s]}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
