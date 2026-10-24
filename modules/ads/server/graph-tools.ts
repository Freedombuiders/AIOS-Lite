/**
 * Read-only Meta Ads calls over the Graph API, through Composio's proxy.
 *
 * The ads snapshot and account sync were written against `METAADS_*` tools, but
 * the `metaads` toolkit only ships METAADS_GET_INSIGHTS and METAADS_READ_ADSETS
 * (there is no tool to list ad accounts, campaigns or ads), and
 * METAADS_GET_INSIGHTS mangles an object `time_range` (Meta answers "time_range
 * must be non-empty"). So the same five read operations are served from the
 * Graph API with the connection's own token, keeping the old slug names as the
 * vocabulary so the callers and their argument shapes stay as they were.
 *
 * Only these five GET reads are reachable; any other slug is refused.
 */

import { graphProxy, type FbCallTarget } from '../../_lib/composio.js';

export const READ_SLUGS = [
  'METAADS_GET_AD_ACCOUNTS',
  'METAADS_LIST_CAMPAIGNS',
  'METAADS_READ_ADSETS',
  'METAADS_LIST_ADS',
  'METAADS_GET_INSIGHTS',
] as const;

type ReadSlug = (typeof READ_SLUGS)[number];

export interface GraphReadRequest {
  path: string;
  query: Record<string, string | number | boolean>;
}

const csv = (v: unknown): string | undefined => {
  if (Array.isArray(v)) return v.map(String).join(',');
  return typeof v === 'string' && v ? v : undefined;
};

function actPath(id: unknown): string {
  const s = String(id ?? '').trim();
  if (!/^(act_)?\d+$/.test(s)) throw new Error('graph read: bad ad account id');
  return s.startsWith('act_') ? s : `act_${s}`;
}

function put(q: GraphReadRequest['query'], key: string, value: string | number | undefined): void {
  if (value !== undefined && value !== '') q[key] = value;
}

/** Maps a (slug, tool-style args) pair to the Graph request that answers it. Pure; exported for tests. */
export function toGraphRequest(slug: string, args: Record<string, unknown>): GraphReadRequest {
  if (!(READ_SLUGS as readonly string[]).includes(slug)) throw new Error(`graph read: ${slug} is not a read-only ads operation`);
  const query: GraphReadRequest['query'] = {};
  put(query, 'fields', csv(args.fields));
  put(query, 'limit', typeof args.limit === 'number' ? args.limit : undefined);
  put(query, 'after', typeof args.after === 'string' ? args.after : undefined);

  switch (slug as ReadSlug) {
    case 'METAADS_GET_AD_ACCOUNTS':
      return { path: '/me/adaccounts', query };
    case 'METAADS_LIST_CAMPAIGNS':
      return { path: `/${actPath(args.ad_account_id)}/campaigns`, query };
    case 'METAADS_READ_ADSETS':
      return { path: `/${actPath(args.ad_account_id)}/adsets`, query };
    case 'METAADS_LIST_ADS':
      return { path: `/${actPath(args.ad_account_id)}/ads`, query };
    case 'METAADS_GET_INSIGHTS': {
      put(query, 'level', typeof args.level === 'string' ? args.level : undefined);
      const range = args.time_range as { since?: unknown; until?: unknown } | undefined;
      if (range && typeof range.since === 'string' && typeof range.until === 'string') {
        query.time_range = JSON.stringify({ since: range.since, until: range.until });
      }
      put(query, 'time_increment', typeof args.time_increment === 'number' || typeof args.time_increment === 'string' ? args.time_increment : undefined);
      put(query, 'breakdowns', csv(args.breakdowns));
      return { path: `/${actPath(args.object_id)}/insights`, query };
    }
  }
}

/**
 * Meta answers `spend`, `impressions` and `reach` as "0" for some accounts and
 * days when they are asked for together with action-type fields (`actions`,
 * `action_values`, `video_thruplay_watched_actions`, sometimes `clicks`) —
 * at any level, with or without breakdowns (seen 2026-10-21, not consistent
 * from one call to the next). Asked for apart, both halves are right. So an
 * insights read that mixes the two groups is split, every page of each half
 * is read, and the rows are merged on day + ids + breakdown values.
 */
const isActivityField = (f: string): boolean => f.includes('action') || f.includes('click');
const isKeyField = (f: string): boolean => f === 'date_start' || f === 'date_stop' || f.endsWith('_id');
const MONEY_FIELDS = new Set(['spend', 'impressions', 'reach', 'frequency', 'cpm', 'cpp']);
const MERGE_KEYS = ['date_start', 'date_stop', 'account_id', 'campaign_id', 'adset_id', 'ad_id', 'publisher_platform', 'platform_position', 'age', 'gender', 'country', 'region', 'device_platform', 'impression_device'];
const SPLIT_MAX_PAGES = 10;

/** The two field lists of a split read, or null when the read is safe as it is. Pure; exported for tests. */
export function splitInsightsFields(slug: string, args: Record<string, unknown>): { money: string; activity: string } | null {
  if (slug !== 'METAADS_GET_INSIGHTS') return null;
  const fields = (csv(args.fields) ?? '').split(',').map((f) => f.trim()).filter(Boolean);
  const activity = fields.filter(isActivityField);
  const money = fields.filter((f) => !isActivityField(f));
  if (!activity.length || !money.some((f) => MONEY_FIELDS.has(f))) return null;
  const keys = fields.filter(isKeyField);
  if (!keys.includes('date_start')) keys.unshift('date_start');
  return { money: [...new Set([...keys, ...money])].join(','), activity: [...new Set([...keys, ...activity])].join(',') };
}

interface GraphBody { data?: Record<string, unknown>[]; paging?: { next?: unknown; cursors?: { after?: unknown } } }

async function readAllPages(path: string, query: GraphReadRequest['query'], target: FbCallTarget): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let after: string | undefined;
  for (let page = 0; page < SPLIT_MAX_PAGES; page++) {
    const res = await graphProxy<GraphBody>({ method: 'GET', path, query: { ...query, ...(after ? { after } : {}) } }, target);
    out.push(...(res.data?.data ?? []));
    const next = res.data?.paging?.cursors?.after;
    if (!res.data?.paging?.next || typeof next !== 'string') break;
    after = next;
  }
  return out;
}

/**
 * Runs one of the read operations and returns the Graph body (`{ data: [...], paging }`).
 * A split insights read comes back whole, without `paging`. Throws the typed Composio errors.
 */
export async function metaRead<T = unknown>(slug: string, args: Record<string, unknown>, target: FbCallTarget): Promise<T> {
  const split = splitInsightsFields(slug, args);
  if (!split) {
    const req = toGraphRequest(slug, args);
    const res = await graphProxy<T>({ method: 'GET', path: req.path, query: req.query }, target);
    return res.data;
  }
  const { after: _ignored, ...rest } = args;
  const money = toGraphRequest(slug, { ...rest, fields: split.money });
  const activity = toGraphRequest(slug, { ...rest, fields: split.activity });
  const [a, b] = await Promise.all([
    readAllPages(money.path, money.query, target),
    readAllPages(activity.path, activity.query, target),
  ]);
  const keys = [...new Set([...MERGE_KEYS, ...(csv(args.breakdowns) ?? '').split(',').map((k) => k.trim()).filter(Boolean)])];
  const key = (r: Record<string, unknown>) => keys.map((k) => String(r[k] ?? '')).join('|');
  const extra = new Map(b.map((r) => [key(r), r]));
  const data = a.map((r) => {
    const k = key(r);
    const more = extra.get(k);
    extra.delete(k);
    return more ? { ...more, ...r } : r;
  });
  data.push(...extra.values());
  return { data } as T;
}
