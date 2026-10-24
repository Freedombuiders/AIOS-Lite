import { _initTestDatabase } from './test-db.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getFbAdAccount,
  listFbAdAccounts,
  updateFbAdAccountSettings,
  upsertFbAdAccount,
} from './store.js';
import { metaRead } from './graph-tools.js';
import { makeFakeMeta } from './test-fixtures.js';

vi.mock('../../_lib/composio.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../_lib/composio.js')>();
  return { ...actual, listConnections: vi.fn(), hasComposioKey: vi.fn(() => true), getComposio: vi.fn() };
});
vi.mock('./graph-tools.js', () => ({ metaRead: vi.fn() }));
vi.mock('./context.js', async (original) => ({ ...await original<typeof import('./context.js')>(), notifyOwner: vi.fn(async () => {}), isFbStudioEnabled: vi.fn(() => true) }));

import {
  ComposioAuthError,
  ComposioConnectionExpiredError,
  getComposio,
  hasComposioKey,
  listConnections,
  type ComposioConnection,
} from '../../_lib/composio.js';
import {
  _resetAdsConnectionCache,
  AdsReconnectError,
  getMetaadsConnections,
  normalizeActId,
  startAdsConnect,
  startAdsReconnect,
  syncAdAccounts,
} from './accounts.js';

const conn = (over: Partial<ComposioConnection> = {}): ComposioConnection => ({
  id: 'ca_1', toolkit: 'metaads', status: 'ACTIVE', alias: null, entityId: 'e1', authConfigId: 'ac_1', ...over,
});

const list = vi.mocked(listConnections);
const run = vi.mocked(metaRead);

beforeEach(() => {
  _initTestDatabase(':memory:');
  _resetAdsConnectionCache();
  list.mockReset();
  run.mockReset();
  vi.mocked(hasComposioKey).mockReturnValue(true);
  run.mockImplementation(makeFakeMeta().execute as never);
});

describe('connection state', () => {
  it('is MISSING without a key or without any metaads connection', async () => {
    vi.mocked(hasComposioKey).mockReturnValue(false);
    expect((await getMetaadsConnections()).status).toBe('MISSING');
    expect(list).not.toHaveBeenCalled();
    vi.mocked(hasComposioKey).mockReturnValue(true);
    list.mockResolvedValue([]);
    expect((await getMetaadsConnections(true)).status).toBe('MISSING');
  });

  it('is EXPIRED when every connection is expired, and the accounts follow', async () => {
    upsertFbAdAccount({ id: 'act_111', name: 'Rocket', currency: 'VND', timezone: '', connectionId: 'ca_1', entityId: 'e1', status: 'ACTIVE' });
    list.mockResolvedValue([conn({ status: 'EXPIRED' }), conn({ id: 'ca_2', status: 'EXPIRED' })]);
    expect((await getMetaadsConnections()).status).toBe('EXPIRED');
    expect(getFbAdAccount('act_111')!.status).toBe('EXPIRED');
  });

  it('is ACTIVE when one connection is, and brings an account back once its own connection is', async () => {
    upsertFbAdAccount({ id: 'act_111', name: 'Rocket', currency: 'VND', timezone: '', connectionId: 'ca_1', entityId: 'e1', status: 'EXPIRED' });
    list.mockResolvedValue([conn({ id: 'ca_9', status: 'ACTIVE' }), conn({ status: 'EXPIRED' })]);
    expect((await getMetaadsConnections()).status).toBe('ACTIVE');
    // Its own connection (ca_1) is still expired, so the account stays EXPIRED until it is re-bound by a sync.
    expect(getFbAdAccount('act_111')!.status).toBe('EXPIRED');
    list.mockResolvedValue([conn({ status: 'ACTIVE' })]);
    await getMetaadsConnections(true);
    expect(getFbAdAccount('act_111')!.status).toBe('ACTIVE');
  });

  it('caches for five minutes and survives a failing listing', async () => {
    list.mockResolvedValue([conn()]);
    await getMetaadsConnections();
    await getMetaadsConnections();
    expect(list).toHaveBeenCalledTimes(1);
    list.mockRejectedValue(new Error('network'));
    const failed = await getMetaadsConnections(true);
    expect(failed.status).toBe('UNKNOWN');
    expect(failed.connections).toHaveLength(1);
  });
});

describe('syncAdAccounts', () => {
  it('normalises ids, starts new accounts disabled and never overwrites the owner\'s settings', async () => {
    list.mockResolvedValue([conn()]);
    const first = await syncAdAccounts();
    expect(first.connection).toBe('ACTIVE');
    expect(first.accounts).toHaveLength(1);
    expect(first.accounts[0]).toMatchObject({
      id: 'act_111', name: 'Rocket AI', currency: 'VND', timezone: 'Asia/Ho_Chi_Minh', connection_id: 'ca_1', entity_id: 'e1',
      enabled: 0, result_type: 'lead', target_cpa: null, status: 'ACTIVE',
    });
    updateFbAdAccountSettings('act_111', { enabled: true, resultType: 'message', targetCpa: 150_000, monthlyBudget: 1e8 });
    await syncAdAccounts();
    expect(getFbAdAccount('act_111')).toMatchObject({ enabled: 1, result_type: 'message', target_cpa: 150_000, monthly_budget: 1e8 });
    expect(normalizeActId('123')).toBe('act_123');
    expect(normalizeActId('act_123')).toBe('act_123');
  });

  it('uses the connection\'s own entity for the call', async () => {
    list.mockResolvedValue([conn({ entityId: 'entity-x' })]);
    await syncAdAccounts();
    expect(run).toHaveBeenCalledWith('METAADS_GET_AD_ACCOUNTS', expect.any(Object), { area: 'ads', connectionId: 'ca_1', entityId: 'entity-x' });
  });

  it('makes no tool call when no connection is ACTIVE and reports the state', async () => {
    upsertFbAdAccount({ id: 'act_111', name: 'Rocket', currency: 'VND', timezone: '', connectionId: 'ca_1', entityId: 'e1', status: 'ACTIVE' });
    list.mockResolvedValue([conn({ status: 'EXPIRED' })]);
    const out = await syncAdAccounts();
    expect(run).not.toHaveBeenCalled();
    expect(out.connection).toBe('EXPIRED');
    expect(out.accounts[0]!.status).toBe('EXPIRED');
  });

  it('re-binds an account whose connection expired to a new ACTIVE one', async () => {
    upsertFbAdAccount({ id: 'act_111', name: 'Rocket', currency: 'VND', timezone: '', connectionId: 'ca_old', entityId: 'e-old', status: 'EXPIRED' });
    list.mockResolvedValue([conn({ id: 'ca_old', status: 'EXPIRED', entityId: 'e-old' }), conn({ id: 'ca_new', entityId: 'e-new' })]);
    await syncAdAccounts();
    expect(getFbAdAccount('act_111')).toMatchObject({ connection_id: 'ca_new', entity_id: 'e-new', status: 'ACTIVE' });
  });

  it('keeps an account on its own ACTIVE connection when another one also sees it', async () => {
    upsertFbAdAccount({ id: 'act_111', name: 'Rocket', currency: 'VND', timezone: '', connectionId: 'ca_2', entityId: 'e2', status: 'ACTIVE' });
    list.mockResolvedValue([conn({ id: 'ca_1' }), conn({ id: 'ca_2', entityId: 'e2' })]);
    await syncAdAccounts();
    expect(getFbAdAccount('act_111')).toMatchObject({ connection_id: 'ca_2', entity_id: 'e2' });
  });

  it('skips a connection that turns out to be expired and carries on with the next', async () => {
    list.mockResolvedValue([conn({ id: 'ca_1' }), conn({ id: 'ca_2', entityId: 'e2' })]);
    run.mockReset();
    run.mockRejectedValueOnce(new ComposioConnectionExpiredError());
    run.mockImplementation(makeFakeMeta().execute as never);
    const out = await syncAdAccounts();
    expect(out.accounts).toHaveLength(1);
    expect(out.accounts[0]!.connection_id).toBe('ca_2');
  });

  it('ignores malformed rows', async () => {
    list.mockResolvedValue([conn()]);
    run.mockReset();
    run.mockResolvedValue({ data: { data: [{ name: 'no id' }, 7, null, { id: 222, name: 'Số' }] } } as never);
    const out = await syncAdAccounts();
    expect(out.accounts.map((a) => a.id)).toEqual(['act_222']);
    expect(listFbAdAccounts()).toHaveLength(1);
  });
});

describe('startAdsReconnect / startAdsConnect', () => {
  const initiate = vi.fn();
  const listConfigs = vi.fn();
  const createConfig = vi.fn();
  beforeEach(() => {
    initiate.mockReset();
    initiate.mockResolvedValue({ redirectUrl: 'https://connect.composio.dev/link/abc' });
    listConfigs.mockReset();
    listConfigs.mockResolvedValue({ items: [] });
    createConfig.mockReset();
    createConfig.mockResolvedValue({ id: 'ac_new' });
    vi.mocked(getComposio).mockReturnValue({ connectedAccounts: { link: initiate }, authConfigs: { list: listConfigs, create: createConfig } } as never);
  });

  it('uses an existing metaads auth config when there is no connection yet', async () => {
    list.mockResolvedValue([]);
    listConfigs.mockResolvedValue({ items: [{ id: 'ac_have', status: 'ENABLED' }] });
    await expect(startAdsConnect()).resolves.toEqual({ redirectUrl: 'https://connect.composio.dev/link/abc' });
    expect(createConfig).not.toHaveBeenCalled();
    expect(initiate).toHaveBeenCalledWith('aios-lite-metaads', 'ac_have', { allowMultiple: true });
  });

  it('creates a custom OAuth auth config from the owner\'s Meta app', async () => {
    list.mockResolvedValue([]);
    await startAdsConnect({ appId: ' 1234567890 ', appSecret: 'a'.repeat(32) });
    expect(createConfig).toHaveBeenCalledWith('metaads', expect.objectContaining({
      type: 'use_custom_auth',
      authScheme: 'OAUTH2',
      credentials: { client_id: '1234567890', client_secret: 'a'.repeat(32), scopes: 'ads_read,business_management' },
    }));
    expect(initiate).toHaveBeenCalledWith('aios-lite-metaads', 'ac_new', { allowMultiple: true });
  });

  it('adds a second login through the active connection\'s auth config and user', async () => {
    list.mockResolvedValue([conn({ id: 'ca_ok', entityId: 'entity-ok', authConfigId: 'ac_ok' })]);
    await startAdsConnect();
    expect(initiate).toHaveBeenCalledWith('entity-ok', 'ac_ok', { allowMultiple: true });
  });

  it('re-links through the expired connection\'s auth config and entity', async () => {
    list.mockResolvedValue([conn({ id: 'ca_ok', authConfigId: 'ac_ok' }), conn({ id: 'ca_dead', status: 'EXPIRED', entityId: 'entity-dead', authConfigId: 'ac_dead' })]);
    await expect(startAdsReconnect()).resolves.toEqual({ redirectUrl: 'https://connect.composio.dev/link/abc' });
    expect(initiate).toHaveBeenCalledWith('entity-dead', 'ac_dead', { allowMultiple: true });
  });

  it('says so when there is no connection to re-link', async () => {
    list.mockResolvedValue([]);
    await expect(startAdsReconnect()).rejects.toBeInstanceOf(AdsReconnectError);
    list.mockResolvedValue([conn({ status: 'EXPIRED', authConfigId: '' })]);
    await expect(startAdsReconnect()).rejects.toBeInstanceOf(AdsReconnectError);
  });

  it('needs the Composio key and a redirect URL back', async () => {
    vi.mocked(hasComposioKey).mockReturnValue(false);
    await expect(startAdsReconnect()).rejects.toBeInstanceOf(ComposioAuthError);
    vi.mocked(hasComposioKey).mockReturnValue(true);
    list.mockResolvedValue([conn({ status: 'EXPIRED' })]);
    initiate.mockResolvedValue({ redirectUrl: null });
    await expect(startAdsReconnect()).rejects.toBeInstanceOf(AdsReconnectError);
  });
});
