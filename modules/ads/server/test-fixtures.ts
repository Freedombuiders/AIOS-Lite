/**
 * Test double for the Meta Ads read tools (no network). Answers the five
 * read-only slugs the ads workstream uses and throws for anything else, so a
 * test fails loudly if code ever reaches for a write tool.
 */

import { addDays } from './metrics.js';

export const READ_ONLY_SLUGS = new Set([
  'METAADS_GET_AD_ACCOUNTS',
  'METAADS_LIST_CAMPAIGNS',
  'METAADS_READ_ADSETS',
  'METAADS_LIST_ADS',
  'METAADS_GET_INSIGHTS',
]);

export interface FakeCall { slug: string; args: Record<string, any>; target: unknown }

export interface FakeMetaOptions {
  /** Make a slug fail with this error (thrown once per call). */
  failSlug?: Record<string, Error>;
  /** Fail METAADS_LIST_ADS only when the nested creative expansion is requested. */
  rejectNestedCreative?: boolean;
}

type Row = Record<string, unknown>;

const lead = (n: number) => (n > 0 ? [{ action_type: 'lead', value: String(n) }] : []);

interface Spec { id: string; name: string; parent?: string; campaign?: string; spend: number; leads: number; video?: boolean }

const CAMPAIGNS: Spec[] = [
  { id: 'c1', name: 'Lead · Lớp AI Agent T11', spend: 2_000_000, leads: 17 },
  { id: 'c2', name: 'Test · Video dài case study', spend: 400_000, leads: 0 },
];
const ADSETS: Spec[] = [
  { id: 'a1', name: 'Chủ shop online 25–45', campaign: 'c1', spend: 1_700_000, leads: 20 },
  { id: 'a2', name: 'Sở thích: marketing', campaign: 'c1', spend: 300_000, leads: 1 },
  { id: 'a3', name: 'Broad 25–45', campaign: 'c2', spend: 400_000, leads: 0 },
];
const ADS: Spec[] = [
  { id: 'd1', name: 'Reel "3 prompt viết caption"', parent: 'a1', campaign: 'c1', spend: 1_200_000, leads: 12, video: true },
  { id: 'd2', name: 'Ảnh lịch học', parent: 'a1', campaign: 'c1', spend: 880_000, leads: 8 },
  { id: 'd3', name: 'Video dài case study', parent: 'a3', campaign: 'c2', spend: 400_000, leads: 0, video: true },
];

function daysBetween(since: string, until: string): string[] {
  const out: string[] = [];
  for (let d = since; d <= until && out.length < 120; d = addDays(d, 1)) out.push(d);
  return out;
}

function metricRow(spec: { spend: number; leads: number; video?: boolean }, day: string): Row {
  const actions: Row[] = [...lead(spec.leads), { action_type: 'landing_page_view', value: String(Math.round(spec.leads * 8)) }];
  if (spec.video) actions.push({ action_type: 'video_view', value: '3800' });
  return {
    date_start: day, date_stop: day, spend: String(spec.spend), impressions: '10000', reach: '8000', frequency: '1.25',
    clicks: '200', inline_link_clicks: '150', actions,
    ...(spec.video ? { video_thruplay_watched_actions: [{ action_type: 'video_view', value: '800' }] } : {}),
  };
}

const wrap = (rows: Row[], paging?: Row) => ({ data: { data: rows, ...(paging ? { paging } : {}) } });

export function makeFakeMeta(opts: FakeMetaOptions = {}) {
  const calls: FakeCall[] = [];

  async function execute(slug: string, args: Record<string, any>, target: unknown): Promise<unknown> {
    calls.push({ slug, args, target });
    if (!READ_ONLY_SLUGS.has(slug)) throw new Error(`fake meta: ${slug} is not a read-only tool`);
    const fail = opts.failSlug?.[slug];
    if (fail) throw fail;

    switch (slug) {
      case 'METAADS_GET_AD_ACCOUNTS':
        return wrap([{ id: 'act_111', account_id: '111', name: 'Rocket AI', currency: 'VND', timezone_name: 'Asia/Ho_Chi_Minh' }]);
      case 'METAADS_LIST_CAMPAIGNS':
        return wrap(CAMPAIGNS.map((c) => ({ id: c.id, name: c.name, effective_status: 'ACTIVE', daily_budget: '0' })));
      case 'METAADS_READ_ADSETS':
        return wrap(ADSETS.map((a) => ({
          id: a.id, name: a.name, campaign_id: a.campaign, effective_status: 'ACTIVE',
          daily_budget: a.id === 'a1' ? '1800000' : undefined,
          learning_stage_info: a.id === 'a2' ? { status: 'LEARNING' } : a.id === 'a3' ? undefined : { status: 'SUCCESS' },
        })));
      case 'METAADS_LIST_ADS': {
        if (opts.rejectNestedCreative && String(args.fields).includes('creative{')) throw new Error('(#100) Tried accessing nonexisting field');
        const nested = String(args.fields).includes('creative{');
        return wrap(ADS.map((a) => ({
          id: a.id, name: a.name, adset_id: a.parent, campaign_id: a.campaign, effective_status: 'ACTIVE',
          ...(nested ? { creative: a.video
            ? { id: `cr_${a.id}`, object_type: 'VIDEO', video_id: `v_${a.id}`, thumbnail_url: 'https://t/x.jpg', effective_object_story_id: a.id === 'd1' ? 'P1_300' : '' }
            : { id: `cr_${a.id}`, object_type: 'PHOTO' } } : {}),
        })));
      }
      case 'METAADS_GET_INSIGHTS':
        return insights(args);
    }
    throw new Error('unreachable');
  }

  function insights(args: Record<string, any>): unknown {
    const level = args.level as string;
    const { since, until } = args.time_range as { since: string; until: string };
    const days = daysBetween(since, until);

    if (args.breakdowns) {
      const rows: Row[] = [];
      for (const day of days) {
        rows.push({ date_start: day, publisher_platform: 'facebook', platform_position: 'facebook_reels', spend: '4100000', impressions: '50000', actions: lead(45) });
        rows.push({ date_start: day, publisher_platform: 'facebook', platform_position: 'feed', spend: '3800000', impressions: '40000', actions: lead(36) });
        rows.push({ date_start: day, publisher_platform: 'audience_network', platform_position: 'an_classic', spend: '700000', impressions: '9000', actions: lead(2) });
      }
      return wrap(rows);
    }

    if (args.time_increment === 'all_days') {
      const freq: Record<string, string> = { c1: '1.5', c2: '1.2', a1: '1.8', a2: '3.4', a3: '1.2', d1: '1.9', d2: '1.7', d3: '1.1' };
      const specs = level === 'campaign' ? CAMPAIGNS : level === 'adset' ? ADSETS : ADS;
      return wrap(specs.map((s) => ({
        date_start: since, date_stop: until, frequency: freq[s.id],
        ...(level === 'campaign' ? { campaign_id: s.id } : level === 'adset' ? { adset_id: s.id, campaign_id: s.campaign } : { ad_id: s.id, adset_id: s.parent, campaign_id: s.campaign }),
      })));
    }

    const rows: Row[] = [];
    for (const day of days) {
      if (level === 'account') {
        rows.push({
          ...metricRow({ spend: 6_500_000, leads: 59 }, day), account_id: '111',
          action_values: [{ action_type: 'purchase', value: '3000000' }],
        });
        continue;
      }
      const specs = level === 'campaign' ? CAMPAIGNS : level === 'adset' ? ADSETS : ADS;
      for (const s of specs) {
        rows.push({
          ...metricRow(s, day),
          ...(level === 'campaign' ? { campaign_id: s.id, campaign_name: s.name }
            : level === 'adset' ? { adset_id: s.id, adset_name: s.name, campaign_id: s.campaign }
              : { ad_id: s.id, ad_name: s.name, adset_id: s.parent, campaign_id: s.campaign }),
        });
      }
    }
    return wrap(rows);
  }

  return { execute, calls };
}
