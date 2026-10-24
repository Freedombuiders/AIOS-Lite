import { currentContext } from './context.js';
import { organicPosts } from './organic.js';
/**
 * /* — read-only Meta Ads dashboard. Nothing here changes anything
 * in Meta: the only writes are to our own tables (account settings, the
 * "done" / "snooze" state of a recommendation).
 *
 * The contract is in ../types.ts. Beyond it, error bodies from the dashboard
 * and refresh endpoints may carry `code` and `connection` so the UI can show
 * the right state (reconnect, enable an account, configure Composio).
 */

import type { Context, Hono } from 'hono';
import { z } from 'zod';

import {
  getFbAdAccount,
  getFbAdsRecommendation,
  listFbAdAccounts,
  recomputeFbAdsResults,
  updateFbAdAccountSettings,
  updateFbAdsRecommendation,
  type FbAdAccountRow,
} from './store.js';
import { logger } from '../../../src/modules/compat/logger.js';
import {
  ComposioAuthError,
  ComposioConnectionExpiredError,
  ComposioRateLimitError,
  FbBudgetExceeded,
  hasComposioKey,
} from '../../_lib/composio.js';
import type { ConnStatus } from '../../_lib/fb-types.js';
import {
  AdsReconnectError,
  getAdsConnectInfo,
  getMetaadsConnections,
  normalizeActId,
  startAdsConnect,
  startAdsReconnect,
  syncAdAccounts,
} from './accounts.js';
import { accountDto, loadAdsDashboard } from './dashboard.js';
import { runEvaluation } from './evaluate.js';
import { isResultType, resultsFromRaw } from './metrics.js';
import { _resetAdsOverviewCache, loadAdsOverview, overviewWindow } from './overview.js';
import { loadAdsBreakdowns } from './breakdowns.js';
import { loadAdsCampaigns } from './campaigns.js';
import { accountResultType } from './model.js';
import { THRESHOLDS } from './rules.js';
import { AdsRefreshBusyError, AdsRefreshTooSoonError, runAccountSnapshot } from './snapshot.js';

const NO_KEY = 'Chưa cấu hình khóa Composio. Vào Kết nối › Composio để nhập khóa.';

const nowSec = (): number => Math.floor(Date.now() / 1000);

function failure(c: Context, err: unknown): Response {
  if (err instanceof ComposioAuthError) return c.json({ error: NO_KEY, code: 'composio_not_configured' }, 503);
  if (err instanceof ComposioConnectionExpiredError) {
    return c.json({ error: 'Kết nối Meta Ads đã hết hạn. Hãy kết nối lại.', code: 'connection_expired', connection: 'EXPIRED' as ConnStatus }, 409);
  }
  if (err instanceof ComposioRateLimitError || err instanceof FbBudgetExceeded) {
    return c.json({ error: 'Đã chạm giới hạn gọi API, thử lại sau ít phút.', code: 'rate_limited' }, 429);
  }
  if (err instanceof AdsRefreshBusyError) return c.json({ error: err.message, code: 'busy' }, 409);
  if (err instanceof AdsRefreshTooSoonError) return c.json({ error: err.message, code: 'too_soon', retryAfterSec: err.retryAfterSec }, 429);
  if (err instanceof AdsReconnectError) return c.json({ error: err.message, code: 'no_connection' }, 404);
  logger.warn({ err: (err as Error)?.name, message: String((err as Error)?.message ?? err).slice(0, 200) }, 'fbstudio ads route failed');
  return c.json({ error: 'Không lấy được dữ liệu từ Meta Ads. Xem nhật ký để biết thêm.' }, 502);
}

const AccountUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  resultType: z.enum(['lead', 'message', 'purchase', 'registration']).optional(),
  targetCpa: z.number().positive().finite().nullable().optional(),
  monthlyBudget: z.number().positive().finite().nullable().optional(),
}).strict();

const RecommendationStateSchema = z.object({ state: z.enum(['done', 'snoozed']) }).strict();
const RefreshSchema = z.object({ accountId: z.string().min(1) }).strict();
const ConnectSchema = z.object({
  appId: z.string().trim().regex(/^\d{6,20}$/, 'App ID chỉ gồm chữ số').optional(),
  appSecret: z.string().trim().regex(/^[a-f0-9]{32}$/i, 'App Secret gồm 32 ký tự a–f, 0–9').optional(),
}).strict();
const ResultTypeSchema = z.enum(['lead', 'message', 'purchase', 'registration']);
const EnableAllSchema = z.object({
  enabled: z.boolean(),
  ids: z.array(z.string().min(1)).max(500).optional(),
  /** Result type per account id, for accounts the owner has not configured (the overview's guess). */
  resultTypes: z.record(z.string(), ResultTypeSchema).optional(),
}).strict();

function findAccount(raw: string): FbAdAccountRow | undefined {
  return getFbAdAccount(raw) ?? getFbAdAccount(normalizeActId(raw));
}

/** Kicks a snapshot without making the request wait for it. Failures are logged by the guard, never thrown. */
function snapshotInBackground(accountId: string): void {
  void runAccountSnapshot(accountId).catch((err) => {
    logger.info({ err: (err as Error)?.name, accountId }, 'fbstudio ads: background snapshot did not complete');
  });
}

export function registerAdsRoutes(app: Hono): void {
  app.get('/accounts', async (c) => {
    // `fresh=1` re-lists the connections (the connect screen polls it while the owner logs in).
    const { status } = await getMetaadsConnections(c.req.query('fresh') === '1');
    return c.json({ accounts: listFbAdAccounts().map(accountDto), connection: status });
  });

  app.post('/accounts/sync', async (c) => {
    if (!hasComposioKey()) return c.json({ error: NO_KEY, code: 'composio_not_configured' }, 503);
    try {
      const { accounts, connection } = await syncAdAccounts();
      return c.json({ accounts: accounts.map(accountDto), connection });
    } catch (err) {
      return failure(c, err);
    }
  });

  app.patch('/accounts/:id', async (c) => {
    const account = findAccount(c.req.param('id'));
    if (!account) return c.json({ error: 'Không tìm thấy tài khoản quảng cáo.' }, 404);
    const parsed = AccountUpdateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Dữ liệu không hợp lệ.' }, 400);
    const patch = parsed.data;

    updateFbAdAccountSettings(account.id, patch);
    _resetAdsOverviewCache();
    const resultTypeChanged = patch.resultType !== undefined && patch.resultType !== accountResultType(account);
    if (resultTypeChanged && isResultType(patch.resultType)) {
      // Daily results are re-derived from the stored action counts; placements refresh on the next snapshot.
      const type = patch.resultType;
      recomputeFbAdsResults(account.id, (raw) => resultsFromRaw(raw, type));
    }
    // Targets and result type change what the rules say; no API call needed.
    runEvaluation(account.id, nowSec());

    const updated = getFbAdAccount(account.id) as FbAdAccountRow;
    const justEnabled = patch.enabled === true && account.enabled !== 1;
    if ((justEnabled || resultTypeChanged) && updated.enabled === 1 && updated.status === 'ACTIVE' && hasComposioKey()) {
      snapshotInBackground(updated.id);
    }
    return c.json(accountDto(updated));
  });

  app.get('/dashboard', async (c) => {
    const accounts = listFbAdAccounts();
    const { status: global } = await getMetaadsConnections();

    const wanted = c.req.query('account');
    let account: FbAdAccountRow | undefined;
    if (wanted) {
      account = findAccount(wanted);
      if (!account) return c.json({ error: 'Không tìm thấy tài khoản quảng cáo.' }, 404);
    } else {
      account = accounts.find((a) => a.enabled === 1);
    }

    if (!account) {
      if (!hasComposioKey()) return c.json({ error: NO_KEY, code: 'composio_not_configured', connection: global }, 503);
      if (!accounts.length) {
        const error = global === 'EXPIRED'
          ? 'Kết nối Meta Ads đã hết hạn. Hãy kết nối lại để lấy tài khoản quảng cáo.'
          : global === 'MISSING'
            ? 'Chưa có kết nối Meta Ads trong Composio.'
            : 'Chưa có tài khoản quảng cáo nào. Bấm "Đồng bộ tài khoản".';
        return c.json({ error, code: 'no_account', connection: global }, 409);
      }
      return c.json({ error: 'Chưa bật tài khoản quảng cáo nào. Hãy bật một tài khoản để bắt đầu theo dõi.', code: 'no_enabled_account', connection: global }, 409);
    }

    const parsedDays = Number.parseInt(c.req.query('days') ?? '7', 10);
    const days = Number.isFinite(parsedDays) ? Math.min(28, Math.max(1, parsedDays)) : 7;
    // The account's own connection decides; the global state only fills in when it cannot be told.
    const connection: ConnStatus = account.status === 'EXPIRED' ? 'EXPIRED' : global === 'ACTIVE' ? 'ACTIVE' : global === 'EXPIRED' ? 'EXPIRED' : global;
    const ctx = currentContext();
    const organic = ctx?.modules ? await organicPosts(ctx) : { available: false, rows: [] };
    return c.json({ ...loadAdsDashboard(account, connection, days, nowSec(), organic.rows), organicAvailable: organic.available });
  });

  app.post('/recommendations/:id', async (c) => {
    const id = Number.parseInt(c.req.param('id'), 10);
    const rec = Number.isFinite(id) ? getFbAdsRecommendation(id) : undefined;
    if (!rec) return c.json({ error: 'Không tìm thấy gợi ý.' }, 404);
    const parsed = RecommendationStateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Trạng thái phải là "done" hoặc "snoozed".' }, 400);
    if (rec.state === 'expired') return c.json({ error: 'Gợi ý này đã hết hiệu lực.' }, 409);
    if (parsed.data.state === 'done') {
      updateFbAdsRecommendation(id, { state: 'done', snoozedUntil: null });
    } else {
      updateFbAdsRecommendation(id, { state: 'snoozed', snoozedUntil: nowSec() + THRESHOLDS.snoozeSec });
    }
    return c.json({ ok: true });
  });

  app.post('/refresh', async (c) => {
    const parsed = RefreshSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Thiếu accountId.' }, 400);
    const account = findAccount(parsed.data.accountId);
    if (!account) return c.json({ error: 'Không tìm thấy tài khoản quảng cáo.' }, 404);
    if (!hasComposioKey()) return c.json({ error: NO_KEY, code: 'composio_not_configured' }, 503);
    if (account.status === 'EXPIRED') {
      return c.json({ error: 'Kết nối Meta Ads đã hết hạn. Hãy kết nối lại rồi đồng bộ tài khoản.', code: 'connection_expired', connection: 'EXPIRED' as ConnStatus }, 409);
    }
    try {
      await runAccountSnapshot(account.id, { manual: true });
      return c.json({ ok: true });
    } catch (err) {
      return failure(c, err);
    }
  });

  app.get('/connect', async (c) => {
    try {
      return c.json(await getAdsConnectInfo());
    } catch (err) {
      return failure(c, err);
    }
  });

  app.post('/connect', async (c) => {
    const parsed = ConnectSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Dữ liệu không hợp lệ.' }, 400);
    const { appId, appSecret } = parsed.data;
    try {
      return c.json(await startAdsConnect(appId && appSecret ? { appId, appSecret } : undefined));
    } catch (err) {
      if (err instanceof AdsReconnectError) return c.json({ error: err.message, code: 'needs_app' }, 409);
      return failure(c, err);
    }
  });

  app.get('/overview', async (c) => {
    if (!hasComposioKey()) return c.json({ error: NO_KEY, code: 'composio_not_configured' }, 503);
    const { status } = await getMetaadsConnections();
    if (status !== 'ACTIVE') {
      const error = status === 'EXPIRED' ? 'Kết nối Meta Ads đã hết hạn. Hãy kết nối lại.' : 'Chưa có kết nối Meta Ads.';
      return c.json({ error, code: status === 'EXPIRED' ? 'connection_expired' : 'no_connection', connection: status }, 409);
    }
    try {
      return c.json(await loadAdsOverview(overviewWindow(c.req.query('days')), { fresh: c.req.query('fresh') === '1' }));
    } catch (err) {
      return failure(c, err);
    }
  });

  app.get('/breakdowns', async (c) => {
    const account = findAccount(c.req.query('account') ?? '');
    if (!account) return c.json({ error: 'Không tìm thấy tài khoản quảng cáo.' }, 404);
    if (!hasComposioKey()) return c.json({ error: NO_KEY, code: 'composio_not_configured' }, 503);
    if (account.status === 'EXPIRED') {
      return c.json({ error: 'Kết nối Meta Ads đã hết hạn. Hãy kết nối lại.', code: 'connection_expired', connection: 'EXPIRED' as ConnStatus }, 409);
    }
    const parsedDays = Number.parseInt(c.req.query('days') ?? '7', 10);
    const days = Number.isFinite(parsedDays) ? Math.min(28, Math.max(1, parsedDays)) : 7;
    try {
      return c.json(await loadAdsBreakdowns(account, days));
    } catch (err) {
      return failure(c, err);
    }
  });

  app.get('/campaigns', async (c) => {
    const parsedDays = Number.parseInt(c.req.query('days') ?? '7', 10);
    const days = Number.isFinite(parsedDays) ? Math.min(28, Math.max(1, parsedDays)) : 7;
    const { status } = await getMetaadsConnections();
    return c.json(loadAdsCampaigns(days, status, nowSec()));
  });

  /** Turns in-depth tracking on or off for many accounts at once (all of them when `ids` is left out). */
  app.post('/accounts/enable-all', async (c) => {
    const parsed = EnableAllSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Dữ liệu không hợp lệ.' }, 400);
    const wanted = parsed.data.ids ? new Set(parsed.data.ids.map(normalizeActId)) : null;
    const started: string[] = [];
    for (const account of listFbAdAccounts()) {
      if (wanted && !wanted.has(account.id)) continue;
      if ((account.enabled === 1) === parsed.data.enabled) continue;
      const guess = parsed.data.enabled ? (parsed.data.resultTypes?.[account.id] ?? parsed.data.resultTypes?.[account.id.replace(/^act_/, '')]) : undefined;
      updateFbAdAccountSettings(account.id, { enabled: parsed.data.enabled, ...(guess && guess !== account.result_type ? { resultType: guess } : {}) });
      if (guess && guess !== account.result_type) recomputeFbAdsResults(account.id, (raw) => resultsFromRaw(raw, guess));
      if (parsed.data.enabled && account.status === 'ACTIVE') started.push(account.id);
    }
    // One at a time: the snapshot guard refuses overlapping runs.
    if (started.length && hasComposioKey()) {
      void (async () => {
        for (const id of started) await runAccountSnapshot(id).catch(() => undefined);
      })();
    }
    _resetAdsOverviewCache();
    return c.json({ accounts: listFbAdAccounts().map(accountDto) });
  });

  app.post('/reconnect', async (c) => {
    try {
      return c.json(await startAdsReconnect());
    } catch (err) {
      return failure(c, err);
    }
  });
}
