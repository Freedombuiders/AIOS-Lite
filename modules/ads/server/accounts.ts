/**
 * Meta Ads connections and ad accounts: which Composio `metaads` connections
 * exist, whether they are alive, the ad accounts they can see, and the
 * re-link flow for an expired one. Read-only towards Meta.
 */

import {
  getFbSetting,
  listFbAdAccounts,
  setFbAdAccountStatus,
  setFbSetting,
  upsertFbAdAccount,
  type FbAdAccountRow,
} from './store.js';
import { logger } from '../../../src/modules/compat/logger.js';
import {
  ComposioAuthError,
  ComposioConnectionExpiredError,
  getComposio,
  hasComposioKey,
  listConnections,
  type ComposioConnection,
} from '../../_lib/composio.js';
import { notifyOwner } from './context.js';
import type { ConnStatus } from '../../_lib/fb-types.js';
import { metaRead } from './graph-tools.js';
import { extractRows } from './metrics.js';
import { z } from 'zod';

export const LIST_AD_ACCOUNTS_TOOL = 'METAADS_GET_AD_ACCOUNTS';

const OK_TTL_MS = 5 * 60_000;
const FAIL_TTL_MS = 60_000;

export class AdsReconnectError extends Error {
  constructor(message: string) { super(message); this.name = 'AdsReconnectError'; }
}

interface ConnectionSnapshot {
  status: ConnStatus;
  connections: ComposioConnection[];
}

let cache: { at: number; ttl: number; value: ConnectionSnapshot } | null = null;

export function _resetAdsConnectionCache(): void { cache = null; }

function summarise(connections: ComposioConnection[]): ConnStatus {
  if (!connections.length) return 'MISSING';
  if (connections.some((c) => c.status === 'ACTIVE')) return 'ACTIVE';
  if (connections.some((c) => ['EXPIRED', 'FAILED', 'INACTIVE'].includes(c.status))) return 'EXPIRED';
  return 'UNKNOWN';
}

/**
 * The state of the `metaads` connections (cached 5 minutes; the listing is a
 * plain REST call and does not count against the API budget). Account rows
 * follow their connection: ACTIVE, otherwise EXPIRED.
 */
export async function getMetaadsConnections(force = false): Promise<ConnectionSnapshot> {
  if (!hasComposioKey()) return { status: 'MISSING', connections: [] };
  if (!force && cache && Date.now() - cache.at < cache.ttl) return cache.value;
  try {
    const connections = await listConnections('metaads');
    const value = { status: summarise(connections), connections };
    cache = { at: Date.now(), ttl: OK_TTL_MS, value };
    applyConnectionStatuses(connections);
    return value;
  } catch (err) {
    logger.warn({ err: (err as Error).name }, 'fbstudio ads: could not list metaads connections');
    const value: ConnectionSnapshot = { status: 'UNKNOWN', connections: cache?.value.connections ?? [] };
    cache = { at: Date.now(), ttl: FAIL_TTL_MS, value };
    return value;
  }
}

/** Account status follows its connection: ACTIVE only while that connection is ACTIVE. */
function applyConnectionStatuses(connections: ComposioConnection[]): void {
  const byId = new Map(connections.map((c) => [c.id, c]));
  for (const account of listFbAdAccounts()) {
    if (!account.connection_id) continue;
    const alive = byId.get(account.connection_id)?.status === 'ACTIVE';
    const next = alive ? 'ACTIVE' : 'EXPIRED';
    if (account.status !== next) setFbAdAccountStatus(account.id, next);
  }
}

// ── Expiry notification (once per expiry) ─────────────────────────────

const notifiedKey = (accountId: string) => `ads_expired_notified:${accountId}`;

/** Marks the account EXPIRED and tells the owner once until it works again. */
export async function markAccountExpired(account: Pick<FbAdAccountRow, 'id' | 'name'>): Promise<void> {
  setFbAdAccountStatus(account.id, 'EXPIRED');
  if (getFbSetting(notifiedKey(account.id)) === '1') return;
  setFbSetting(notifiedKey(account.id), '1');
  await notifyOwner(
    `Kết nối Meta Ads đã hết hạn nên tài khoản quảng cáo "${account.name || account.id}" tạm dừng cập nhật. `
    + 'Vào Marketing › Facebook › Quảng cáo và bấm "Kết nối lại".',
  );
}

export function clearExpiredNotice(accountId: string): void {
  if (getFbSetting(notifiedKey(accountId)) === '1') setFbSetting(notifiedKey(accountId), '0');
}

// ── Ad account sync ───────────────────────────────────────────────────

const AdAccountSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  account_id: z.union([z.string(), z.number()]).optional(),
  name: z.string().nullish(),
  currency: z.string().nullish(),
  timezone_name: z.string().nullish(),
});

/** Meta wants the `act_` prefix on ad account ids in every call. */
export function normalizeActId(id: string | number): string {
  const s = String(id).trim();
  return s.startsWith('act_') ? s : `act_${s}`;
}

/**
 * Lists the ad accounts of every ACTIVE metaads connection into
 * fb_ad_accounts. New accounts start disabled. An account keeps the ACTIVE
 * connection it already has; otherwise the first ACTIVE connection that sees
 * it takes it over (this is how a re-linked connection is picked up).
 */
export async function syncAdAccounts(): Promise<{ accounts: FbAdAccountRow[]; connection: ConnStatus }> {
  const { status, connections } = await getMetaadsConnections(true);
  const active = connections.filter((c) => c.status === 'ACTIVE');
  const activeIds = new Set(active.map((c) => c.id));
  const existing = new Map(listFbAdAccounts().map((a) => [a.id, a]));
  const seen = new Set<string>();

  for (const conn of active) {
    let raw: unknown;
    try {
      raw = await metaRead(
        LIST_AD_ACCOUNTS_TOOL,
        { limit: 200, fields: 'id,account_id,name,currency,timezone_name,account_status' },
        { area: 'ads', connectionId: conn.id, entityId: conn.entityId },
      );
    } catch (err) {
      if (err instanceof ComposioConnectionExpiredError) continue;
      throw err;
    }
    for (const row of extractRows(raw).rows) recordListedAccount(row, conn, { existing, activeIds, seen });
  }
  return { accounts: listFbAdAccounts(), connection: status };
}

/**
 * Stores one row of `/me/adaccounts` seen through `conn`. Returns the act_ id,
 * or null for an unparseable row or one already recorded in this pass.
 */
export function recordListedAccount(
  row: unknown,
  conn: Pick<ComposioConnection, 'id' | 'entityId'>,
  pass: { existing: Map<string, FbAdAccountRow>; activeIds: Set<string>; seen: Set<string> },
): string | null {
  const parsed = AdAccountSchema.safeParse(row);
  const idRaw = parsed.success ? (parsed.data.id ?? parsed.data.account_id) : undefined;
  if (!parsed.success || idRaw === undefined) return null;
  const id = normalizeActId(idRaw);
  if (pass.seen.has(id)) return null;
  pass.seen.add(id);
  const prior = pass.existing.get(id);
  const keepConnection = prior && prior.connection_id !== conn.id && pass.activeIds.has(prior.connection_id);
  upsertFbAdAccount({
    id,
    name: parsed.data.name || prior?.name || id,
    currency: parsed.data.currency || prior?.currency || 'VND',
    timezone: parsed.data.timezone_name || prior?.timezone || '',
    connectionId: keepConnection ? prior.connection_id : conn.id,
    entityId: keepConnection ? prior.entity_id : conn.entityId,
    status: 'ACTIVE',
  });
  clearExpiredNotice(id);
  return id;
}

// ── Connect / reconnect ───────────────────────────────────────────────

/** Composio's OAuth callback; the Meta app must allow it under Facebook Login › Valid OAuth Redirect URIs. */
export const COMPOSIO_REDIRECT_URI = 'https://backend.composio.dev/api/v1/auth-apps/add';
/** Read-only: insights and the account list. `business_management` lets Meta list accounts owned by a business portfolio. */
export const METAADS_SCOPES = 'ads_read,business_management';
const METAADS_USER_ID = 'aios-lite-metaads';

interface AuthConfigSummary { id: string; status: string }

async function listMetaadsAuthConfigs(): Promise<AuthConfigSummary[]> {
  const res = await getComposio().authConfigs.list({ toolkit: 'metaads' });
  return (res.items ?? []).map((i) => ({ id: i.id, status: String(i.status ?? '') }));
}

/** What the connect screen needs to know before the owner clicks "Kết nối". */
export async function getAdsConnectInfo(): Promise<{ hasAuthConfig: boolean; redirectUri: string; scopes: string }> {
  if (!hasComposioKey()) throw new ComposioAuthError('COMPOSIO_API_KEY is not set');
  const configs = await listMetaadsAuthConfigs();
  return { hasAuthConfig: configs.length > 0, redirectUri: COMPOSIO_REDIRECT_URI, scopes: METAADS_SCOPES };
}

/**
 * Starts the Meta OAuth flow and returns the URL the owner opens.
 *
 * Re-uses, in order: an expired connection's auth config and Composio user
 * (so the re-linked connection takes over its accounts), any existing
 * `metaads` auth config, or a new custom-OAuth auth config built from the
 * owner's own Meta app (`appId` / `appSecret`; the toolkit has no
 * Composio-managed app). Every new connection is allowed alongside the old
 * ones, so several Meta logins can each bring their ad accounts.
 */
export async function startAdsConnect(app?: { appId: string; appSecret: string }): Promise<{ redirectUrl: string }> {
  if (!hasComposioKey()) throw new ComposioAuthError('COMPOSIO_API_KEY is not set');
  const connections = await listConnections('metaads');
  const expired = connections.find((c) => c.status !== 'ACTIVE' && c.authConfigId);
  let authConfigId = expired?.authConfigId ?? connections.find((c) => c.authConfigId)?.authConfigId ?? '';
  const userId = expired?.entityId ?? connections[0]?.entityId ?? METAADS_USER_ID;

  if (!authConfigId) {
    const existing = (await listMetaadsAuthConfigs()).find((c) => c.status !== 'DISABLED');
    if (existing) authConfigId = existing.id;
  }
  if (!authConfigId) {
    if (!app?.appId || !app.appSecret) {
      throw new AdsReconnectError('Cần App ID và App Secret của một Meta App để tạo kết nối Meta Ads lần đầu.');
    }
    const created = await getComposio().authConfigs.create('metaads', {
      type: 'use_custom_auth',
      authScheme: 'OAUTH2',
      name: 'Meta Ads (AIOS-Lite)',
      credentials: { client_id: app.appId.trim(), client_secret: app.appSecret.trim(), scopes: METAADS_SCOPES },
    });
    authConfigId = created.id;
    logger.info({ authConfigId }, 'fbstudio ads: created metaads auth config');
  }

  const request = await getComposio().connectedAccounts.link(userId, authConfigId, { allowMultiple: true });
  if (!request.redirectUrl) throw new AdsReconnectError('Composio không trả về đường dẫn kết nối.');
  cache = null;
  return { redirectUrl: request.redirectUrl };
}

/** Re-link flow for an expired connection; same as connect when no app credentials are needed. */
export async function startAdsReconnect(): Promise<{ redirectUrl: string }> {
  return startAdsConnect();
}
