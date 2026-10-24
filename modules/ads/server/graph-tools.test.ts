import { _initTestDatabase } from './test-db.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../_lib/composio.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../_lib/composio.js')>();
  return { ...actual, graphProxy: vi.fn() };
});

import { graphProxy } from '../../_lib/composio.js';
import { metaRead, splitInsightsFields, toGraphRequest } from './graph-tools.js';

const proxy = vi.mocked(graphProxy);
const target = { area: 'ads', connectionId: 'ca_1', entityId: 'user_1' } as const;

beforeEach(() => { proxy.mockReset(); });

describe('toGraphRequest', () => {
  it('lists ad accounts from /me', () => {
    expect(toGraphRequest('METAADS_GET_AD_ACCOUNTS', { limit: 200, fields: 'id,name' }))
      .toEqual({ path: '/me/adaccounts', query: { fields: 'id,name', limit: 200 } });
  });

  it('lists campaigns, adsets and ads under the account, adding act_ when missing', () => {
    expect(toGraphRequest('METAADS_LIST_CAMPAIGNS', { ad_account_id: '123', fields: ['id', 'name'], limit: 200, after: 'c' }))
      .toEqual({ path: '/act_123/campaigns', query: { fields: 'id,name', limit: 200, after: 'c' } });
    expect(toGraphRequest('METAADS_READ_ADSETS', { ad_account_id: 'act_123', fields: ['id'] }).path).toBe('/act_123/adsets');
    expect(toGraphRequest('METAADS_LIST_ADS', { ad_account_id: 'act_123', fields: 'id' }).path).toBe('/act_123/ads');
  });

  it('sends insights time_range as the JSON string Meta expects, not as an object', () => {
    const req = toGraphRequest('METAADS_GET_INSIGHTS', {
      object_id: 'act_123', level: 'ad', time_range: { since: '2026-09-01', until: '2026-09-28' },
      time_increment: 1, fields: ['spend', 'actions'], breakdowns: ['publisher_platform', 'platform_position'], limit: 500,
    });
    expect(req.path).toBe('/act_123/insights');
    expect(req.query).toEqual({
      fields: 'spend,actions', limit: 500, level: 'ad',
      time_range: '{"since":"2026-09-01","until":"2026-09-28"}',
      time_increment: 1, breakdowns: 'publisher_platform,platform_position',
    });
  });

  it('keeps time_increment all_days as a string', () => {
    const req = toGraphRequest('METAADS_GET_INSIGHTS', { object_id: '9', level: 'campaign', time_increment: 'all_days' });
    expect(req.query.time_increment).toBe('all_days');
  });

  it('refuses anything that is not one of the five reads', () => {
    expect(() => toGraphRequest('METAADS_PAUSE_CAMPAIGN', { ad_account_id: '1' })).toThrow(/not a read-only/);
    expect(() => toGraphRequest('METAADS_CREATE_CAMPAIGN', {})).toThrow(/not a read-only/);
  });

  it('refuses an ad account id that is not numeric', () => {
    expect(() => toGraphRequest('METAADS_LIST_ADS', { ad_account_id: '1/../me' })).toThrow(/bad ad account id/);
  });
});

describe('metaRead', () => {
  it('issues a GET through the proxy and returns the Graph body', async () => {
    proxy.mockResolvedValue({ status: 200, data: { data: [{ id: 'act_1' }] } });
    const out = await metaRead('METAADS_GET_AD_ACCOUNTS', { fields: 'id' }, target);
    expect(out).toEqual({ data: [{ id: 'act_1' }] });
    expect(proxy).toHaveBeenCalledWith({ method: 'GET', path: '/me/adaccounts', query: { fields: 'id' } }, target);
  });

  it('lets the typed Composio errors through', async () => {
    proxy.mockRejectedValue(new Error('boom'));
    await expect(metaRead('METAADS_LIST_ADS', { ad_account_id: '1' }, target)).rejects.toThrow('boom');
  });
});

describe('splitInsightsFields', () => {
  it('splits any insights read that asks for spend or impressions with action-type fields', () => {
    expect(splitInsightsFields('METAADS_GET_INSIGHTS', { level: 'account', fields: 'date_start,spend,impressions,clicks,inline_link_clicks,actions,action_values,account_id' }))
      .toEqual({ money: 'date_start,account_id,spend,impressions', activity: 'date_start,account_id,clicks,inline_link_clicks,actions,action_values' });
    expect(splitInsightsFields('METAADS_GET_INSIGHTS', { level: 'campaign', fields: ['spend', 'actions', 'campaign_id', 'campaign_name'] }))
      .toEqual({ money: 'date_start,campaign_id,spend,campaign_name', activity: 'date_start,campaign_id,actions' });
    expect(splitInsightsFields('METAADS_GET_INSIGHTS', { breakdowns: 'publisher_platform', fields: 'spend,actions' })).toEqual({ money: 'date_start,spend', activity: 'date_start,actions' });
  });
  it('leaves single-group reads alone', () => {
    expect(splitInsightsFields('METAADS_GET_INSIGHTS', { fields: 'date_start,spend,impressions,reach,frequency' })).toBeNull();
    expect(splitInsightsFields('METAADS_GET_INSIGHTS', { fields: 'date_start,actions,clicks' })).toBeNull();
    expect(splitInsightsFields('METAADS_GET_INSIGHTS', { fields: 'frequency,campaign_id' })).toBeNull();
    expect(splitInsightsFields('METAADS_LIST_ADS', { fields: 'spend,actions' })).toBeNull();
  });
});

describe('metaRead split insights', () => {
  beforeEach(() => proxy.mockReset());
  it('reads every page of both halves and merges on day and ids', async () => {
    proxy.mockImplementation(async (...args: unknown[]) => {
      const q = (args[0] as { query?: { fields?: string; after?: string } } | undefined)?.query ?? {};
      if (String(q.fields).includes('spend')) {
        return q.after
          ? { status: 200, data: { data: [{ date_start: '2026-10-20', campaign_id: 'c2', spend: '300' }] } }
          : { status: 200, data: { data: [{ date_start: '2026-10-20', campaign_id: 'c1', spend: '200' }], paging: { next: 'https://x', cursors: { after: 'p2' } } } };
      }
      return { status: 200, data: { data: [{ date_start: '2026-10-20', campaign_id: 'c2', clicks: '5' }, { date_start: '2026-10-20', campaign_id: 'c1', clicks: '1' }, { date_start: '2026-10-21', campaign_id: 'c1', clicks: '9' }] } };
    });
    const out = await metaRead<{ data: unknown[]; paging?: unknown }>('METAADS_GET_INSIGHTS', { object_id: 'act_1', level: 'campaign', fields: 'date_start,campaign_id,spend,clicks', after: 'ignored' }, target);
    expect(proxy).toHaveBeenCalledTimes(3);
    expect(out.data).toEqual([
      { date_start: '2026-10-20', campaign_id: 'c1', spend: '200', clicks: '1' },
      { date_start: '2026-10-20', campaign_id: 'c2', spend: '300', clicks: '5' },
      { date_start: '2026-10-21', campaign_id: 'c1', clicks: '9' },
    ]);
    expect(out.paging).toBeUndefined();
  });
});
