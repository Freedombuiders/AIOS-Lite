/**
 * Who and when: the account's results split by age × gender and by hour of
 * the day, read live from Meta when the account screen asks for them (two
 * insights reads, each split by metaRead into money/activity halves) and
 * cached for half an hour. Read-only towards Meta; nothing is stored.
 */

import type { FbAdAccountRow } from './store.js';
import type { AdsBreakdownsDto } from '../../_lib/fb-types.js';
import { metaRead } from './graph-tools.js';
import { addDays, dayIn, extractRows, InsightsRowSchema, metricsFromInsights } from './metrics.js';
import { accountResultType, accountTimezone } from './model.js';
import { z } from 'zod';

const CACHE_TTL_SEC = 30 * 60;
const FIELDS = 'spend,impressions,inline_link_clicks,actions,action_values';
const HOUR_KEY = 'hourly_stats_aggregated_by_advertiser_time_zone';

const cache = new Map<string, { at: number; dto: AdsBreakdownsDto }>();
export function _resetAdsBreakdownsCache(): void { cache.clear(); }

const BreakdownRowSchema = InsightsRowSchema.extend({
  age: z.string().optional(),
  gender: z.string().optional(),
  [HOUR_KEY]: z.string().optional(),
});
type BreakdownRow = z.infer<typeof BreakdownRowSchema>;

interface Cell { spend: number; impressions: number; linkClicks: number; results: number }

function cellOf(rows: BreakdownRow[], resultType: ReturnType<typeof accountResultType>): Cell {
  const c: Cell = { spend: 0, impressions: 0, linkClicks: 0, results: 0 };
  for (const r of rows) {
    const m = metricsFromInsights(r, resultType);
    c.spend += m.spend; c.impressions += m.impressions; c.linkClicks += m.linkClicks; c.results += m.results;
  }
  return c;
}

const finish = (c: Cell) => ({
  ...c,
  cpa: c.results > 0 ? c.spend / c.results : null,
  ctr: c.impressions > 0 ? (c.linkClicks / c.impressions) * 100 : null,
});

/** Builds the DTO from the two raw row sets. Pure; exported for tests. */
export function buildBreakdowns(
  account: Pick<FbAdAccountRow, 'id' | 'result_type'>,
  input: { from: string; to: string; fetchedAt: number; ageGender: unknown[]; hours: unknown[] },
): AdsBreakdownsDto {
  const type = accountResultType(account);
  const parse = (rows: unknown[]) => rows.map((r) => BreakdownRowSchema.safeParse(r)).filter((p) => p.success).map((p) => p.data as BreakdownRow);

  const groups = new Map<string, BreakdownRow[]>();
  for (const r of parse(input.ageGender)) {
    const key = `${r.age ?? 'unknown'}|${r.gender ?? 'unknown'}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
  }
  const ageGender = [...groups.entries()]
    .map(([key, rows]) => { const [age, gender] = key.split('|'); return { age, gender, ...finish(cellOf(rows, type)) }; })
    .filter((g) => g.spend > 0 || g.results > 0)
    .sort((a, b) => a.age.localeCompare(b.age) || a.gender.localeCompare(b.gender));

  const byHour = new Map<number, BreakdownRow[]>();
  for (const r of parse(input.hours)) {
    const h = Number.parseInt(String(r[HOUR_KEY] ?? '').slice(0, 2), 10);
    if (!Number.isFinite(h) || h < 0 || h > 23) continue;
    (byHour.get(h) ?? byHour.set(h, []).get(h)!).push(r);
  }
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, ...finish(cellOf(byHour.get(hour) ?? [], type)) }));

  return { accountId: account.id, resultType: type, from: input.from, to: input.to, fetchedAt: input.fetchedAt, ageGender, hours };
}

/** Live read, cached per account and window. Throws the typed Composio errors. */
export async function loadAdsBreakdowns(account: FbAdAccountRow, days: number, nowSec: number = Math.floor(Date.now() / 1000)): Promise<AdsBreakdownsDto> {
  const key = `${account.id}:${days}:${account.result_type}`;
  const hit = cache.get(key);
  if (hit && nowSec - hit.at < CACHE_TTL_SEC) return hit.dto;

  const to = dayIn(accountTimezone(account), nowSec);
  const from = addDays(to, -(days - 1));
  const target = { area: 'ads' as const, connectionId: account.connection_id, entityId: account.entity_id };
  const read = (breakdowns: string) => metaRead('METAADS_GET_INSIGHTS', {
    object_id: account.id, level: 'account', time_range: { since: from, until: to }, breakdowns, fields: FIELDS, limit: 500,
  }, target).then((raw) => extractRows(raw).rows);

  const [ageGender, hours] = await Promise.all([read('age,gender'), read(HOUR_KEY)]);
  const dto = buildBreakdowns(account, { from, to, fetchedAt: nowSec, ageGender, hours });
  cache.set(key, { at: nowSec, dto });
  return dto;
}
