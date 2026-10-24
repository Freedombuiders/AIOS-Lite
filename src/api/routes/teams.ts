// /api/teams/*, /api/agent-market/*, /api/recos/* (docs/dev/API-teams.md)
import type { Hono } from 'hono';
import { z } from 'zod';
import { createMarketService, MarketError } from '../../agent-market/service.js';
import type { AppDeps } from '../../core/deps.js';
import { RUNTIME_IDS } from '../../core/types.js';
import { createRecosService, RecoError } from '../../recos/service.js';
import { createTeamsService, type TeamSourceRef } from '../../teams/service.js';
import { TeamError } from '../../teams/types.js';
import { ApiError, badRequest, conflict, notFound } from '../errors.js';
import { body } from '../util.js';

const RUNTIME = z.enum(RUNTIME_IDS as [string, ...string[]]);
const source = z.object({ kind: z.enum(['catalog', 'import']), id: z.string().min(1).max(80) });
const installBody = z.object({
  source,
  inputs: z.record(z.string(), z.string()).optional(),
  strategy: z.enum(['rename', 'skip']).optional(),
  agentStrategies: z.record(z.string(), z.enum(['rename', 'skip'])).optional(),
  runtimes: z.record(z.string(), RUNTIME).optional(),
  defaultRuntime: RUNTIME.optional(),
});
const exportBody = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().max(60).optional(),
  description: z.string().max(1000).optional(),
  agentIds: z.array(z.string()).min(1).max(40),
  manager: z.string().optional(),
});
const importBody = z.object({ base64: z.string().min(1) });
const marketBody = z.object({
  name: z.string().max(100).optional(),
  id: z.string().max(60).optional(),
  runtime: RUNTIME.optional(),
  model: z.string().max(80).optional(),
  fields: z.record(z.string(), z.string().max(20_000)).optional(),
});
const statusBody = z.object({ status: z.enum(['new', 'cart', 'skipped']) });

function guard<T>(fn: () => T): T;
function guard<T>(fn: () => Promise<T>): Promise<T>;
function guard<T>(fn: () => T | Promise<T>): T | Promise<T> {
  const map = (e: unknown): never => {
    if (e instanceof TeamError || e instanceof MarketError || e instanceof RecoError) {
      if (e.status === 404) throw notFound(e.message);
      if (e.status === 409) throw conflict(e.message);
      throw badRequest(e.message);
    }
    throw e instanceof ApiError ? e : e;
  };
  try {
    const r = fn();
    return r instanceof Promise ? r.catch(map) : r;
  } catch (e) {
    return map(e);
  }
}

export function teamsRoutes(app: Hono, deps: AppDeps): void {
  let teams: ReturnType<typeof createTeamsService> | undefined;
  let market: ReturnType<typeof createMarketService> | undefined;
  let recos: ReturnType<typeof createRecosService> | undefined;
  const cfg = () => ({ rootDir: deps.config.rootDir, skillsDirs: deps.config.skillsDirs, timezone: deps.config.timezone });
  const T = () => (teams ??= createTeamsService({ config: cfg(), db: deps.db, agents: deps.agents, scheduler: deps.scheduler, skills: deps.skills, audit: deps.audit }));
  const M = () => (market ??= createMarketService({ config: cfg(), agents: deps.agents, skills: deps.skills, audit: deps.audit }));
  const R = () => (recos ??= createRecosService({ db: deps.db, agents: deps.agents, tasks: deps.tasks, runs: deps.runs, skills: deps.skills, brain: deps.brain, modules: deps.modules, audit: deps.audit }));
  const ref = (s: { kind: 'catalog' | 'import'; id: string }): TeamSourceRef => s;

  // ---- teams
  app.get('/api/teams', (c) => c.json(guard(() => T().list())));
  app.get('/api/teams/:kind/:id', (c) => {
    const kind = c.req.param('kind');
    if (kind !== 'catalog' && kind !== 'import') throw notFound('Không tìm thấy gói.');
    return c.json(guard(() => T().get({ kind, id: c.req.param('id') })));
  });
  app.post('/api/teams/preview', async (c) => {
    const b = await body(c, installBody);
    return c.json(guard(() => T().preview(ref(b.source), b as never)));
  });
  app.post('/api/teams/install', async (c) => {
    const b = await body(c, installBody);
    return c.json(guard(() => T().install(ref(b.source), b as never)), 201);
  });
  app.post('/api/teams/import', async (c) => {
    const { base64 } = await body(c, importBody);
    return c.json(guard(() => T().importZip(Buffer.from(base64, 'base64'))), 201);
  });
  app.delete('/api/teams/import/:id', (c) => c.json({ ok: T().dropImport(c.req.param('id')) }));
  app.post('/api/teams/export', async (c) => {
    const b = await body(c, exportBody);
    const r = guard(() => T().export(b));
    return c.json({ filename: r.filename, base64: r.zip.toString('base64'), files: r.files, redactions: r.redactions, inputs: r.inputs });
  });

  // ---- agent market
  app.get('/api/agent-market', (c) => c.json({ templates: M().templates(), teams: guard(() => T().list().items) }));
  app.post('/api/agent-market/:id/preview', async (c) => {
    const b = await body(c, marketBody, { optional: true });
    return c.json(guard(() => M().preview(c.req.param('id'), b as never)));
  });
  app.post('/api/agent-market/:id/install', async (c) => {
    const b = await body(c, marketBody, { optional: true });
    return c.json(guard(() => M().install(c.req.param('id'), b as never)), 201);
  });

  // ---- recos
  app.get('/api/recos', (c) => {
    const status = c.req.query('status') as 'open' | 'all' | 'new' | 'cart' | 'done' | 'skipped' | undefined;
    return c.json(guard(() => R().list({ status, arm: c.req.query('arm') })));
  });
  app.post('/api/recos/apply-cart', async (c) => c.json(await guard(() => R().applyCart())));
  app.put('/api/recos/:id/status', async (c) => {
    const { status } = await body(c, statusBody);
    return c.json(guard(() => R().setStatus(decodeURIComponent(c.req.param('id')), status)));
  });
  app.post('/api/recos/:id/apply', async (c) => c.json(await guard(() => R().apply(decodeURIComponent(c.req.param('id'))))));
}
