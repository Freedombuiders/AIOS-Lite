/**
 * The all-accounts campaign table: campaign rows of every tracked account,
 * read from the stored snapshots (no Meta call), with the same window and
 * rules as each account's own screen.
 */

import { listFbAdAccounts } from './store.js';
import type { AdsCampaignsDto, ConnStatus } from '../../_lib/fb-types.js';
import { loadAdsDashboard } from './dashboard.js';
import { accountResultType } from './model.js';

const STALE_SEC = 2 * 3600;

export function loadAdsCampaigns(days: number, connection: ConnStatus, nowSec: number): AdsCampaignsDto {
  const campaigns: AdsCampaignsDto['campaigns'] = [];
  const staleAccounts: string[] = [];
  for (const account of listFbAdAccounts()) {
    if (account.enabled !== 1) continue;
    if (!account.synced_at || nowSec - account.synced_at > STALE_SEC) staleAccounts.push(account.name || account.id);
    const dto = loadAdsDashboard(account, account.status === 'EXPIRED' ? 'EXPIRED' : connection, days, nowSec);
    const adsets = new Map<string, number>();
    for (const n of dto.tree) if (n.level === 'adset' && n.parentId) adsets.set(n.parentId, (adsets.get(n.parentId) ?? 0) + 1);
    for (const n of dto.tree) {
      if (n.level !== 'campaign') continue;
      campaigns.push({
        accountId: account.id,
        accountName: account.name || account.id,
        currency: account.currency,
        resultType: accountResultType(account),
        targetCpa: account.target_cpa,
        id: n.id,
        name: n.name,
        status: n.status,
        dailyBudget: n.dailyBudget,
        adsets: adsets.get(n.id) ?? 0,
        spend: n.spend,
        spendToday: n.spendToday,
        results: n.results,
        cpa: n.cpa,
        ctr: n.ctr,
        cpm: n.cpm,
        frequency: n.frequency,
        recommendation: n.recommendation,
      });
    }
  }
  campaigns.sort((a, b) => b.spend - a.spend || b.spendToday - a.spendToday);
  return { days, campaigns, staleAccounts };
}
