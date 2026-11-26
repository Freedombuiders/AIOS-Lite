// Kho dữ liệu (data packs) and the desktop sign-in to the AgenticOS cloud.
//
//   GET  /api/cloud/status                    signed in? which account, which cloud
//   POST /api/cloud/login/start               { cloudUrl? } → { url } to open in the browser
//   GET  /api/cloud/callback                  the browser lands here from the cloud (no AIOS_TOKEN: `state` guards it)
//
//   GET  /api/packs?module=                   store listing + what is installed here + update available
//   GET  /api/packs/installed                 installed packs, per brain folder
//   GET  /api/packs/updates                   newer or yanked releases of installed packs
//   GET  /api/packs/:id                       detail from the cloud + local installs and file status
//   POST /api/packs/:id/preview               { version, folder } → plan (nothing written)
//   POST /api/packs/:id/install               { version, folder, planId } → install or update, one commit
//   POST /api/packs/:id/uninstall/preview     { folder } → plan
//   POST /api/packs/:id/uninstall             { folder, planId } → uninstall, one commit
//
// Installing is an explicit owner action over this API only; no agent action wraps it.
import fs from 'node:fs';
import path from 'node:path';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../../core/deps.js';
import { cloudClientFor } from '../../integrations/agenticos-cloud/index.js';
import { PackYankedError } from '../../integrations/agenticos-cloud/client.js';
import { CLOUD_INTEGRATION_ID, callbackPage, createCloudLogin, type CloudLogin } from '../../integrations/agenticos-cloud/login.js';
import { integrationServiceFor } from '../../integrations/mount.js';
import { IntegrationApiError, IntegrationUsageError } from '../../integrations/types.js';
import { PACK_MODULES } from '../../packs/format.js';
import { createPackService, type PackService } from '../../packs/service.js';
import { loadPackKeys } from '../../packs/verify.js';
import type { FetchImpl } from '../../integrations/media-http.js';
import { body } from '../util.js';
import { badRequest } from '../errors.js';

export { CLOUD_CALLBACK_PATH } from '../../integrations/agenticos-cloud/login.js';

export interface PacksRouteOptions {
  /** tests: fake cloud */
  fetchImpl?: FetchImpl;
}

const services = new WeakMap<object, { packs: PackService; login: CloudLogin }>();

function readVersion(rootDir: string): string | undefined {
  try {
    return (JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

/** One pack service and sign-in flow per app (the in-memory download cache and the busy flag live there). */
export function packServicesFor(deps: AppDeps, opts: PacksRouteOptions = {}): { packs: PackService; login: CloudLogin } {
  let s = services.get(deps);
  if (!s) {
    const integrations = integrationServiceFor(deps);
    s = {
      packs: createPackService({
        db: deps.db,
        notes: deps.notes,
        brain: deps.brain,
        log: deps.log,
        keys: () => loadPackKeys(deps.config.configDir),
        cloud: () => cloudClientFor(integrations.credentials.loadValues(CLOUD_INTEGRATION_ID), { fetchImpl: opts.fetchImpl }),
        appVersion: readVersion(deps.config.rootDir),
      }),
      login: createCloudLogin({ store: integrations.oauthStore, host: deps.config.host, port: deps.config.port, fetchImpl: opts.fetchImpl }),
    };
    services.set(deps, s);
  }
  return s;
}

const version = z.string().min(1).max(64);
const folder = z.string().min(1).max(200);

/** Cloud and sign-in failures as API errors; everything else goes to the app's error handler. */
async function cloudCall<T>(c: Context, fn: () => Promise<T>): Promise<Response> {
  try {
    return c.json(await fn());
  } catch (e) {
    if (e instanceof PackYankedError) return c.json({ error: { code: 'gone', message: e.message } }, 410);
    if (e instanceof IntegrationUsageError) return c.json({ error: { code: 'requirements_missing', message: e.message } }, 412);
    if (e instanceof IntegrationApiError) {
      if (e.status === 401) return c.json({ error: { code: 'requirements_missing', message: 'Phiên đăng nhập cloud đã hết hạn hoặc bị thu hồi. Đăng nhập cloud lại.' } }, 412);
      return c.json({ error: { code: 'bad_gateway', message: e.message } }, 502);
    }
    throw e;
  }
}

export function packsRoutes(app: Hono, deps: AppDeps, opts: PacksRouteOptions = {}): void {
  const s = () => packServicesFor(deps, opts);
  const integrations = () => integrationServiceFor(deps);

  // ---- cloud sign-in
  app.get('/api/cloud/status', (c) => {
    const summary = integrations().credentials.get(CLOUD_INTEGRATION_ID);
    const values = integrations().credentials.loadValues(CLOUD_INTEGRATION_ID);
    return c.json({
      connected: !!values?.session_token,
      cloudUrl: values?.cloud_url ?? '',
      account: summary?.accountLabel ?? '',
      status: summary?.status ?? 'not_configured',
      returnUrl: s().login.returnUrl(),
      pending: s().login.pending(),
      lastLogin: s().login.lastLogin(),
    });
  });

  app.post('/api/cloud/login/start', async (c) => {
    const input = await body(c, z.object({ cloudUrl: z.string().max(300).optional() }), { optional: true });
    try {
      return c.json(s().login.start(input.cloudUrl));
    } catch (e) {
      if (e instanceof IntegrationUsageError) throw badRequest(e.message);
      throw e;
    }
  });

  app.get('/api/cloud/callback', async (c) => {
    const r = await s().login.callback({ code: c.req.query('code'), state: c.req.query('state'), error: c.req.query('error') });
    if (r.ok) deps.audit.log({ actor: 'user', action: 'cloud.login', target: CLOUD_INTEGRATION_ID });
    return c.html(callbackPage(r), r.ok ? 200 : 400, { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  });

  // ---- store
  app.get('/api/packs', (c) => {
    const module = c.req.query('module') || undefined;
    if (module && !(PACK_MODULES as readonly string[]).includes(module)) throw badRequest(`"module" chỉ nhận: ${PACK_MODULES.join(', ')}.`);
    return cloudCall(c, async () => ({ items: await s().packs.catalog(module) }));
  });

  app.get('/api/packs/installed', (c) => c.json({ items: s().packs.installed() }));

  app.get('/api/packs/updates', (c) => cloudCall(c, async () => ({ items: await s().packs.updates() })));

  app.get('/api/packs/:id', (c) => cloudCall(c, () => s().packs.detail(c.req.param('id'))));

  app.post('/api/packs/:id/preview', async (c) => {
    const input = await body(c, z.object({ version, folder }));
    return cloudCall(c, () => s().packs.preview(c.req.param('id'), input.version, input.folder));
  });

  app.post('/api/packs/:id/install', async (c) => {
    const input = await body(c, z.object({ version, folder, planId: z.string().regex(/^[0-9a-f]{64}$/) }));
    const id = c.req.param('id');
    return cloudCall(c, async () => {
      const result = await s().packs.install(id, input.version, input.folder, input.planId);
      deps.audit.log({ actor: 'user', action: 'pack.install', target: `${id}@${input.version}`, detail: { folder: input.folder, written: result.written.length, deleted: result.deleted.length, skipped: result.skipped.length } });
      return result;
    });
  });

  app.post('/api/packs/:id/uninstall/preview', async (c) => {
    const input = await body(c, z.object({ folder }));
    return c.json(s().packs.uninstallPreview(c.req.param('id'), input.folder));
  });

  app.post('/api/packs/:id/uninstall', async (c) => {
    const input = await body(c, z.object({ folder, planId: z.string().regex(/^[0-9a-f]{64}$/) }));
    const id = c.req.param('id');
    const result = await s().packs.uninstall(id, input.folder, input.planId);
    deps.audit.log({ actor: 'user', action: 'pack.uninstall', target: id, detail: { folder: input.folder, deleted: result.deleted.length, kept: result.kept.length } });
    return c.json(result);
  });
}
