import type { AgentConfig } from '../core/types.js';
import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import type { AppDeps } from '../core/deps.js';
import { applyMigrations, nowIso, tablesCreatedBy, type Migration } from '../core/db.js';
import type { ModuleState, Run, Task } from '../core/types.js';
import { bindCompat, bindModuleCompat, unbindModuleCompat } from './compat/state.js';
import { registerIntegration, unregisterIntegration } from '../integrations/registry.js';
import { createModuleContext, type ModuleResources } from './context.js';
import type { AddOptions, AddResult, ModuleInfo, ModuleManager, ModuleRequirement } from './contracts.js';
import { ModuleError } from './errors.js';
import { defaultImporter, discoverModules, loadDefinition, type DiscoveredModule, type LoaderOptions, type ModuleImporter } from './loader.js';
import type { ModuleContext, ModuleDefinition } from './sdk.js';
import { createSettingsStore } from './settings.js';

export interface ModuleManagerOptions {
  importer?: ModuleImporter;
  fromDist?: boolean;
}

interface Active {
  def: ModuleDefinition;
  ctx: ModuleContext;
  res: ModuleResources;
  running: boolean;
  error?: string;
  provided?: Record<string, unknown>;
  hook?: (task: Task, run: Run | null) => Promise<void>;
  skillsRoot?: string;
  routes?: Hono;
}

const CORE_TABLES = new Set([
  'tasks', 'task_comments', 'runs', 'run_events', 'schedules', 'conversations', 'messages', 'memories',
  'brain_docs', 'board', 'audit_log', 'attention', 'modules', 'kv', 'schema_migrations',
]);

export function createModuleManager(deps: AppDeps, opts: ModuleManagerOptions = {}): ModuleManager {
  const { db, bus, log, config } = deps;
  const importer = opts.importer ?? defaultImporter;
  const loaderOpts: LoaderOptions = { rootDir: config.rootDir, modulesDir: config.modulesDir, fromDist: opts.fromDist };
  bindCompat(deps);
  const active = new Map<string, Active>();
  const stateErrors = new Map<string, string>();

  const scan = () => discoverModules(loaderOpts);
  const find = (id: string): DiscoveredModule | undefined => scan().modules.find((m) => m.manifest.id === id);
  const settings = createSettingsStore(db, deps.cipher, (id) => find(id)?.manifest);

  const row = (id: string) =>
    db.prepare('SELECT id, enabled, version, installed_at AS installedAt, settings FROM modules WHERE id = ?').get(id) as
      | { id: string; enabled: number; version: string; installedAt: string | null; settings: string }
      | undefined;

  const isEnabled = (id: string) => row(id)?.enabled === 1;

  function stateOf(mod: DiscoveredModule): ModuleState {
    const r = row(mod.manifest.id);
    return {
      id: mod.manifest.id,
      enabled: r?.enabled === 1,
      version: r?.version ?? mod.manifest.version,
      installedAt: r?.installedAt ?? null,
      settings: settings.masked(mod.manifest.id),
    };
  }

  function requirementsOf(mod: DiscoveredModule): ModuleRequirement[] {
    const out: ModuleRequirement[] = [];
    for (const id of mod.manifest.requires?.modules ?? []) {
      const ok = isEnabled(id);
      out.push({ kind: 'module', id, ok, message: ok ? `Module "${id}" đã bật.` : `Cần thêm module "${id}" trước.` });
    }
    for (const id of mod.manifest.requires?.connections ?? []) {
      const ok = deps.connections.has(id);
      out.push({ kind: 'connection', id, ok, message: ok ? `Kết nối "${id}" sẵn sàng.` : `Cần kết nối "${id}" (vào trang Kết nối).` });
    }
    return out;
  }

  function templatesOf(mod: DiscoveredModule): string[] {
    if (mod.manifest.agentTemplates) return mod.manifest.agentTemplates;
    try {
      return fs.readdirSync(path.join(mod.dir, 'agents'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return [];
    }
  }

  function infoOf(mod: DiscoveredModule): ModuleInfo {
    const requirements = requirementsOf(mod);
    const error = active.get(mod.manifest.id)?.error ?? stateErrors.get(mod.manifest.id);
    return {
      manifest: mod.manifest,
      state: stateOf(mod),
      requirements,
      ready: requirements.every((r) => r.ok),
      hasServer: mod.serverEntry !== null,
      hasWeb: mod.webEntry !== null,
      agentTemplates: templatesOf(mod),
      ...(error ? { error } : {}),
    };
  }

  const emitState = (mod: DiscoveredModule) => bus.emit({ type: 'module', module: stateOf(mod) });

  function readMigrations(mod: DiscoveredModule): Migration[] {
    const dir = path.join(mod.dir, 'migrations');
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    } catch {
      return [];
    }
    const declared = new Set(mod.manifest.tables);
    const migrations = files.map((f) => ({ id: f.replace(/\.sql$/, ''), sql: fs.readFileSync(path.join(dir, f), 'utf8') }));
    const undeclared = new Set<string>();
    for (const m of migrations) for (const t of tablesCreatedBy(m.sql)) if (!declared.has(t)) undeclared.add(t);
    if (undeclared.size) {
      throw new ModuleError('bad_request', `Migration của module "${mod.manifest.id}" tạo bảng chưa khai báo trong module.json: ${[...undeclared].join(', ')}.`);
    }
    const core = mod.manifest.tables.filter((t) => CORE_TABLES.has(t));
    if (core.length) throw new ModuleError('bad_request', `Module không được khai báo bảng của lõi: ${core.join(', ')}.`);
    return migrations;
  }

  async function activate(mod: DiscoveredModule): Promise<Active> {
    const id = mod.manifest.id;
    let a = active.get(id);
    if (!a) {
      const def = await loadDefinition(mod.serverEntry, importer);
      const res: ModuleResources = { stops: new Set() };
      const ctx = createModuleContext(deps, mod.manifest, mod.dir, res, {
        settings,
        isEnabled,
        provides: (other) => manager.provides(other),
      });
      a = { def, ctx, res, running: false };
      active.set(id, a);
    }
    if (a.running) return a;
    bindModuleCompat(id, a.ctx);

    const source = `module:${id}`;
    const self = a;
    self.error = undefined;
    stateErrors.delete(id);
    const skills = path.join(mod.dir, 'skills');
    if (fs.existsSync(skills)) {
      deps.skills.addRoot(skills, source);
      self.skillsRoot = skills;
    }
    if (self.def.onTaskFinished) {
      const handler = self.def.onTaskFinished;
      self.hook = async (task, run) => {
        if (task.source !== source) return;
        try {
          await handler(task, run, self.ctx);
        } catch (err) {
          log.error({ err, module: id }, 'onTaskFinished failed');
        }
      };
      deps.hooks.taskFinished.add(self.hook);
    }
    if (self.def.contextFor) {
      const contextFor = self.def.contextFor;
      deps.hooks.moduleContext.set(id, (task) => contextFor(task, self.ctx));
    }
    for (const def of self.def.integrations ?? []) {
      if (!registerIntegration(def)) log.warn({ module: id, integration: def.id }, 'integration id already registered; skipped');
    }
    if (self.def.agentContext) {
      const agentContext = self.def.agentContext;
      (deps.hooks.agentContext ??= new Map()).set(id, (agent: AgentConfig, task: Task, scopes: string[]) => agentContext({ agent, task, scopes }, self.ctx));
    }
    if (self.def.actions) {
      const registry = (deps.hooks.moduleActions ??= new Map());
      for (const [name, action] of Object.entries(self.def.actions)) {
        registry.set(`${id}:${name}`, {
          moduleId: id,
          name,
          scope: action.scope,
          description: action.description,
          ...(action.example !== undefined ? { example: action.example } : {}),
          run: (payload: unknown, call: { agentId: string; taskId: number; runId: number | null }) => action.handler(payload, call, self.ctx),
        });
      }
    }
    self.running = true;
    try {
      self.provided = self.def.provides?.(self.ctx);
      await self.def.start?.(self.ctx);
    } catch (err) {
      self.error = err instanceof Error ? err.message : String(err);
      log.error({ err, module: id }, 'module start() failed');
    }
    return self;
  }

  async function deactivate(id: string): Promise<void> {
    const a = active.get(id);
    if (!a || !a.running) return;
    a.running = false;
    try {
      await a.def.stop?.(a.ctx);
    } catch (err) {
      log.error({ err, module: id }, 'module stop() failed');
    }
    for (const stop of [...a.res.stops]) {
      try {
        stop();
      } catch {
        /* ignore */
      }
    }
    a.res.stops.clear();
    if (a.hook) deps.hooks.taskFinished.delete(a.hook);
    a.hook = undefined;
    deps.hooks.moduleContext.delete(id);
    for (const key of [...(deps.hooks.moduleActions?.keys() ?? [])]) if (key.startsWith(`${id}:`)) deps.hooks.moduleActions!.delete(key);
    deps.hooks.agentContext?.delete(id);
    for (const def of a.def.integrations ?? []) unregisterIntegration(def.id);
    unbindModuleCompat(id);
    if (a.skillsRoot) deps.skills.removeRoot(a.skillsRoot);
    a.skillsRoot = undefined;
    a.provided = undefined;
  }

  function requireModule(id: string): DiscoveredModule {
    const mod = find(id);
    if (!mod) throw new ModuleError('not_found', `Không tìm thấy module "${id}".`);
    return mod;
  }

  const manager: ModuleManager = {
    discover: () => scan().modules.map(infoOf),
    list: () => scan().modules.map(infoOf),
    get: (id) => {
      const mod = find(id);
      return mod ? infoOf(mod) : undefined;
    },
    isEnabled,

    async add(id, addOpts: AddOptions = {}): Promise<AddResult> {
      const mod = requireModule(id);
      const current = active.get(id);
      if (isEnabled(id) && current?.running) return { module: infoOf(mod), migrationsApplied: [], agentsInstalled: [] };

      const missing = requirementsOf(mod).filter((r) => !r.ok);
      if (missing.length) {
        throw new ModuleError('requirements_missing', `Chưa đủ điều kiện để thêm "${mod.manifest.name}": ${missing.map((r) => r.message).join(' ')}`, missing);
      }
      const migrations = readMigrations(mod);
      const migrationsApplied = applyMigrations(db, id, migrations);

      // load before touching state, so a broken server entry leaves nothing half-enabled
      const a = await activate(mod).catch((err) => {
        throw new ModuleError('bad_request', `Không nạp được module "${id}": ${err instanceof Error ? err.message : String(err)}`);
      });
      try {
        a.def.migrate?.(a.ctx);
      } catch (err) {
        await deactivate(id);
        throw new ModuleError('bad_request', `Migration bằng code của "${id}" lỗi: ${err instanceof Error ? err.message : String(err)}`);
      }

      const agentsInstalled: string[] = [];
      if (addOpts.installAgents) {
        for (const tpl of templatesOf(mod)) {
          if (deps.agents.get(tpl)) continue;
          const dir = path.join(mod.dir, 'agents', tpl);
          if (!fs.existsSync(dir)) continue;
          agentsInstalled.push(deps.agents.installTemplate(dir, tpl).id);
        }
      }

      db.prepare(
        `INSERT INTO modules (id, enabled, version, installed_at, settings) VALUES (?, 1, ?, ?, '{}')
         ON CONFLICT(id) DO UPDATE SET enabled = 1, version = excluded.version, installed_at = COALESCE(installed_at, excluded.installed_at)`,
      ).run(id, mod.manifest.version, nowIso());
      deps.audit.log({ actor: 'system', action: 'module.add', target: id, detail: { migrationsApplied, agentsInstalled } });
      emitState(mod);
      return { module: infoOf(mod), migrationsApplied, agentsInstalled };
    },

    async remove(id) {
      const mod = requireModule(id);
      const dependents = scan()
        .modules.filter((m) => m.manifest.id !== id && isEnabled(m.manifest.id) && m.manifest.requires?.modules?.includes(id))
        .map((m) => m.manifest.id);
      if (dependents.length) {
        throw new ModuleError('conflict', `Không thể gỡ "${id}": module ${dependents.join(', ')} đang cần nó.`);
      }
      await deactivate(id);
      db.prepare('UPDATE modules SET enabled = 0 WHERE id = ?').run(id);
      deps.audit.log({ actor: 'system', action: 'module.remove', target: id });
      emitState(mod);
      return infoOf(mod);
    },

    async purge(id, confirm) {
      const mod = requireModule(id);
      if (isEnabled(id)) throw new ModuleError('conflict', `Hãy gỡ module "${id}" trước khi xoá dữ liệu.`);
      if (confirm !== id) throw new ModuleError('bad_request', `Nhập đúng id module "${id}" để xác nhận xoá dữ liệu.`);
      db.pragma('foreign_keys = OFF');
      try {
        db.transaction(() => {
          for (const t of mod.manifest.tables) db.exec(`DROP TABLE IF EXISTS "${t}"`);
          db.prepare('DELETE FROM schema_migrations WHERE owner = ?').run(id);
          db.prepare('DELETE FROM modules WHERE id = ?').run(id);
        })();
      } finally {
        db.pragma('foreign_keys = ON');
      }
      fs.rmSync(path.join(config.dataDir, 'modules', id), { recursive: true, force: true });
      active.delete(id);
      stateErrors.delete(id);
      deps.audit.log({ actor: 'system', action: 'module.purge', target: id, detail: { tables: mod.manifest.tables } });
      emitState(mod);
    },

    provides<T = Record<string, unknown>>(id: string): T | undefined {
      if (!isEnabled(id)) return undefined;
      return active.get(id)?.provided as T | undefined;
    },

    mount(app) {
      const handle = async (c: import('hono').Context): Promise<Response> => {
        const id = c.req.param('id') ?? '';
        const a = active.get(id);
        if (!isEnabled(id) || !a?.running) return c.json({ error: { code: 'not_found', message: `Module "${id}" chưa được thêm.` } }, 404);
        if (!a.routes) {
          const sub = new Hono();
          try {
            a.def.routes?.(sub, a.ctx);
          } catch (err) {
            log.error({ err, module: id }, 'module routes() failed');
            return c.json({ error: { code: 'internal', message: 'Module lỗi khi khai báo route.' } }, 500);
          }
          a.routes = sub;
        }
        const url = new URL(c.req.url);
        const prefix = `/api/m/${id}`;
        url.pathname = url.pathname.slice(prefix.length) || '/';
        const method = c.req.method;
        // Stream the body through (video uploads can be GBs); never buffer it here.
        const body = method === 'GET' || method === 'HEAD' ? undefined : c.req.raw.body;
        return a.routes.fetch(new Request(url, { method, headers: c.req.raw.headers, body, duplex: 'half' } as RequestInit));
      };
      app.all('/api/m/:id', handle);
      app.all('/api/m/:id/*', handle);
    },

    async start() {
      const enabled = scan().modules.filter((m) => isEnabled(m.manifest.id));
      const started = new Set<string>();
      let pending = [...enabled];
      while (pending.length) {
        const ready = pending.filter((m) => (m.manifest.requires?.modules ?? []).every((r) => started.has(r) || !enabled.some((e) => e.manifest.id === r)));
        const batch = ready.length ? ready : pending; // cycles: start anyway
        for (const mod of batch) {
          try {
            applyMigrations(db, mod.manifest.id, readMigrations(mod));
            const a = await activate(mod);
            a.def.migrate?.(a.ctx);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            stateErrors.set(mod.manifest.id, message);
            log.error({ err, module: mod.manifest.id }, 'module failed to start');
          }
          started.add(mod.manifest.id);
        }
        pending = pending.filter((m) => !started.has(m.manifest.id));
      }
      for (const r of db.prepare('SELECT id FROM modules WHERE enabled = 1').all() as { id: string }[]) {
        if (!enabled.some((m) => m.manifest.id === r.id)) log.warn({ module: r.id }, 'enabled module has no folder in modules/');
      }
    },

    async stop() {
      for (const id of [...active.keys()]) await deactivate(id);
    },

    settings: (id) => {
      requireModule(id);
      return settings.masked(id);
    },

    updateSettings(id, patch) {
      const mod = requireModule(id);
      settings.patch(id, patch, mod.manifest.version);
      emitState(mod);
      return settings.masked(id);
    },
  };

  return manager;
}
