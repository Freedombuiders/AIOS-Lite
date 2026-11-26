import type { ComponentChildren } from 'preact';
import { MoreHorizontal, Search } from 'lucide-preact';
import { Link } from 'wouter-preact';
import { NickPicker } from './NickPicker';
import { ct } from '@modules/care/web/lib/care/i18n';
import { cc } from '@modules/care/web/lib/care-channels/i18n';
import type { CareAccountDto } from '@modules/care/web/lib/care/dto';
import type { ZaloUsage } from '@modules/care/web/lib/care/useZaloUsage';

export type InboxTab = 'all' | 'unread' | 'unanswered';
export const INBOX_TABS: readonly InboxTab[] = ['all', 'unread', 'unanswered'];

/** The other Care screens, gathered under one small menu (T07: the inbox itself is the page). */
const OTHER_PAGES: Array<{ href: string; label: () => string; testid: string }> = [
  { href: '/m/care/drafts', label: () => cc('tabs.drafts'), testid: 'drafts' },
  { href: '/m/care/customers', label: () => cc('tabs.customers'), testid: 'customers' },
  { href: '/m/care/followups', label: () => cc('tabs.tasks'), testid: 'tasks' },
  { href: '/m/care/channels', label: () => cc('tabs.channels'), testid: 'channels' },
  { href: '/m/care/rules', label: () => 'Quy tắc', testid: 'rules' },
  { href: '/m/care/activity', label: () => cc('tabs.activity'), testid: 'activity' },
];

export function CareSubMenu() {
  return (
    <details class="care-submenu" data-testid="care-submenu">
      <summary class="care-icon-button" aria-label={ct('nav.label')}><MoreHorizontal size={16} aria-hidden="true" /></summary>
      <nav class="care-submenu-list" aria-label={ct('nav.label')}>
        {OTHER_PAGES.map((p) => <Link key={p.href} href={p.href} data-testid={`care-nav-${p.testid}`}>{p.label()}</Link>)}
      </nav>
    </details>
  );
}

/**
 * Head of the left column: title, nick picker (connection + today's sent / cap), search and the three filters
 * Tất cả / Chưa đọc / Chưa trả lời. The numbers on the filters come from the list answer, never from local counting.
 */
export function InboxHeader({ accounts, accountId, usage, query, tab, counts, onAccount, onQuery, onTab, extra }: {
  accounts: CareAccountDto[];
  accountId: string;
  usage: ZaloUsage | null;
  query: string;
  tab: InboxTab;
  counts: { unread: number | null; unanswered: number | null };
  onAccount: (id: string) => void;
  onQuery: (q: string) => void;
  onTab: (t: InboxTab) => void;
  /** Small icon controls next to the menu (sound / desktop alerts). */
  extra?: ComponentChildren;
}) {
  const zaloOnly = accounts.length > 0 && accounts.every((a) => a.channel === 'zalo');
  return (
    <div class="care-inbox-head">
      <div class="care-inbox-title">
        <h1>{zaloOnly || accounts.length === 0 ? ct('bot.list.title') : ct('bot.list.titleAny')}</h1>
        <span class="care-inbox-tools">{extra}<CareSubMenu /></span>
      </div>
      <NickPicker accounts={accounts} value={accountId} usage={usage} onChange={onAccount} />
      <label class="care-inbox-search">
        <span>{ct('bot.list.searchLabel')}</span>
        <span class="care-search">
          <Search size={13} class="care-search-icon" aria-hidden="true" />
          <input type="search" placeholder={ct('bot.list.searchPlaceholder')} value={query} data-testid="care-search" onInput={(e) => onQuery((e.target as HTMLInputElement).value)} />
        </span>
      </label>
      <div class="care-seg3" role="group" aria-label={ct('bot.list.filterLabel')}>
        {INBOX_TABS.map((t) => {
          const n = t === 'unread' ? counts.unread : t === 'unanswered' ? counts.unanswered : null;
          return (
            <button key={t} type="button" aria-pressed={tab === t} class={tab === t ? 'is-on' : ''} data-testid={`care-tab-${t}`} onClick={() => onTab(t)}>
              {ct(`bot.list.${t}`)}{n !== null && n > 0 ? <span class="care-seg3-n"> {n}</span> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
