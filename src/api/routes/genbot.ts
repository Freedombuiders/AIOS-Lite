// Đội AI · Bot: every AIOS agent is a GenBot bot (core/runtime-policy.ts). This screen's API lists the bots, adds one
// from a template of teams/agenticos-doi-mac-dinh, stores its Bot API key encrypted (integrations/genbot-keys.ts),
// probes it, pauses and deletes it, and moves a legacy agent (claude, codex…) to GenBot when the owner asks.
// Every state-changing route here is an owner route (api/owner.ts: /api/genbot/*). No response ever carries a key.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { Hono } from 'hono';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { AGENT_ID_RE } from '../../agents/schema.js';
import type { AppDeps } from '../../core/deps.js';
import { allowedRuntimes } from '../../core/runtime-policy.js';
import type { AgentConfig } from '../../core/types.js';
import { GenbotKeyError, genbotKeysFor, validateGenbotKey } from '../../integrations/genbot-keys.js';
import { GENBOT_DEFAULT_BASE_URL, checkGenbotAgent, createGenbotRuntime, readGenbotConfig } from '../../runtimes/genbot.js';
import type { DoctorReport } from '../../runtimes/contracts.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { body } from '../util.js';

const BASE_URL_KV = 'genbot.base_url';
const CHECK_KV = (id: string) => `genbot.check:${id}`;
const DEFAULT_MAX_RUNS_DAY = 500;
const TEAM_DIR = path.join('teams', 'agenticos-doi-mac-dinh', 'agents');

/** The three templates of the default team, by the id the screen uses. */
export const GENBOT_TEMPLATES = [
  { id: 'cskh', label: 'CSKH Zalo', dir: 'bot-cskh', agentId: 'bot-cskh', hint: 'Soạn trả lời khách theo sản phẩm, chính sách và giọng cửa hàng.' },
  { id: 'noi-dung', label: 'Nội dung', dir: 'bot-noi-dung', agentId: 'bot-noi-dung', hint: 'Viết bài theo giọng cửa hàng, dựa trên sản phẩm và bài học.' },
  { id: 'tro-ly', label: 'Trợ lý', dir: 'bot-tro-ly', agentId: 'bot-tro-ly', hint: 'Trả lời chủ từ brain, ghi nhớ, tạo việc và nhắc lịch.' },
] as const;
type TemplateId = (typeof GENBOT_TEMPLATES)[number]['id'];

export interface GenbotTemplateView {
  id: TemplateId;
  label: string;
  hint: string;
  context: 'lean' | 'standard';
  brain: { read: string[]; write: string[] };
  memory: { team: boolean; private: boolean };
  modules: Record<string, string[]>;
}

interface RenderedTemplate extends GenbotTemplateView {
  persona: string;
  description: string;
  maxRunsDay: number;
  brainFolder: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Fills {{input.X}} and parses one template; access is the template's, applied to `brainFolder`. */
function renderTemplate(rootDir: string, id: TemplateId, inputs: { shopName: string; brainFolder: string; baseUrl: string }): RenderedTemplate {
  const t = GENBOT_TEMPLATES.find((x) => x.id === id)!;
  const dir = path.join(rootDir, TEAM_DIR, t.dir);
  const fill = (s: string) =>
    s.replace(/\{\{\s*input\.(\w+)\s*\}\}/g, (_m, k: string) => (k === 'SHOP_NAME' ? inputs.shopName : k === 'BRAIN_FOLDER' ? inputs.brainFolder : k === 'GENBOT_URL' ? inputs.baseUrl : ''));
  const raw = parseYaml(fill(fs.readFileSync(path.join(dir, 'agent.yaml.template'), 'utf8'))) as Record<string, unknown>;
  let persona = '';
  try {
    persona = fill(fs.readFileSync(path.join(dir, 'persona.md'), 'utf8'));
  } catch {
    /* no persona: the description stands in */
  }
  const access = isRecord(raw.access) ? raw.access : {};
  const brainAll = isRecord(access.brain) ? access.brain : {};
  const first = Object.values(brainAll)[0];
  const grant = isRecord(first) ? { read: strings(first.read), write: strings(first.write) } : { read: [], write: [] };
  const mem = isRecord(access.memory) ? access.memory : {};
  const mods: Record<string, string[]> = {};
  if (isRecord(access.modules)) for (const [k, v] of Object.entries(access.modules)) mods[k] = strings(v);
  const ro = isRecord(raw.runtime_options) ? raw.runtime_options : {};
  return {
    id, label: t.label, hint: t.hint,
    context: raw.context === 'lean' ? 'lean' : 'standard',
    brain: grant,
    memory: { team: mem.team === true, private: mem.private !== false },
    modules: mods,
    persona,
    description: typeof raw.description === 'string' ? raw.description : '',
    maxRunsDay: typeof ro.max_runs_day === 'number' ? ro.max_runs_day : DEFAULT_MAX_RUNS_DAY,
    brainFolder: inputs.brainFolder,
  };
}

function slug(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 36);
}

/** TCP connect, then one unauthenticated GET under /hooks: any HTTP answer means GenBot's webhook host is there. Creates nothing. */
async function probeHost(baseUrl: string): Promise<{ ok: boolean; message: string }> {
  const u = new URL(baseUrl);
  const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const tcp = await new Promise<string | null>((resolve) => {
    const s = net.connect({ host, port });
    const done = (r: string | null) => {
      s.destroy();
      resolve(r);
    };
    s.setTimeout(3000, () => done('quá 3 giây không kết nối được'));
    s.once('connect', () => done(null));
    s.once('error', (e: NodeJS.ErrnoException) => done(e.code ?? 'lỗi mạng'));
  });
  if (tcp) return { ok: false, message: `Không kết nối được tới ${baseUrl} (${tcp}). GenBot có đang mở không?` };
  try {
    const res = await fetch(`${baseUrl}/hooks/api/bots/aios-probe/messages?thread=aios-probe`, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(5000) });
    if ([401, 403, 404].includes(res.status)) return { ok: true, message: `GenBot trả lời ở ${baseUrl} (Bot API có mặt, mã ${res.status} vì chưa gửi khoá).` };
    return { ok: true, message: `Có máy chủ ở ${baseUrl} (mã ${res.status}), nhưng không chắc là GenBot: kiểm lại cổng nhận webhook.` };
  } catch (err) {
    return { ok: false, message: `Kết nối được cổng nhưng không đọc được trả lời HTTP (${String((err as Error).message ?? err).slice(0, 80)}).` };
  }
}

const genbotOptions = z.object({
  name: z.string().trim().min(1).max(80),
  role: z.string().trim().max(500).default(''),
  botId: z.string().trim().max(128).default(''),
  key: z.string().max(600).optional(),
  baseUrl: z.string().trim().max(300).optional(),
  template: z.enum(['cskh', 'noi-dung', 'tro-ly']),
  brainFolder: z.string().trim().max(80).optional(),
  shopName: z.string().trim().max(120).optional(),
  id: z.string().trim().optional(),
});

export function genbotRoutes(app: Hono, deps: AppDeps): void {
  const keys = () => genbotKeysFor(deps);
  const allowed = () => deps.config.allowedRuntimes ?? allowedRuntimes();
  const kvGet = (k: string): string | undefined => (deps.db.prepare('SELECT value FROM kv WHERE key = ?').get(k) as { value: string } | undefined)?.value;
  const kvSet = (k: string, v: string) => deps.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);
  const kvDel = (k: string) => deps.db.prepare('DELETE FROM kv WHERE key = ?').run(k);
  const baseUrl = () => kvGet(BASE_URL_KV) || GENBOT_DEFAULT_BASE_URL;
  const checkBase = (raw: string): string => {
    const r = readGenbotConfig({ base_url: raw, bot_id: 'x' });
    if (!r.ok) throw badRequest(r.problems.join(' '));
    return r.config.baseUrl;
  };
  const checkBotId = (raw: string): string => {
    if (raw && !/^[\w-]{1,128}$/.test(raw)) throw badRequest('Mã bot chỉ gồm chữ, số, "_" và "-" (tối đa 128 ký tự). Lấy trong app GenBot, thẻ Bot API của bot.');
    return raw;
  };
  const withKeyError = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      if (err instanceof GenbotKeyError) throw badRequest(err.message);
      throw err;
    }
  };
  const requireBot = (id: string): AgentConfig => {
    const a = deps.agents.get(id);
    if (!a || a.runtime !== 'genbot') throw notFound(`Không tìm thấy bot GenBot "${id}".`);
    return a;
  };

  function keyStatus(a: AgentConfig) {
    const s = keys().status(a.id);
    if (s.hasKey) return { hasKey: true, last4: s.last4, source: 'store' as const, updatedAt: s.updatedAt };
    const keyEnv = typeof a.runtimeOptions.key_env === 'string' ? a.runtimeOptions.key_env.trim() : '';
    if (keyEnv && /^GENBOT_KEY_[A-Z0-9_]{1,64}$/.test(keyEnv) && process.env[keyEnv]?.trim()) return { hasKey: true, last4: '', source: 'env' as const, keyEnv, updatedAt: null };
    return { hasKey: false, last4: '', source: null, updatedAt: null };
  }

  function lastCheck(id: string): { ok: boolean; message: string; at: string } | null {
    try {
      const v = kvGet(CHECK_KV(id));
      return v ? (JSON.parse(v) as { ok: boolean; message: string; at: string }) : null;
    } catch {
      return null;
    }
  }

  /** Where the bot is used: care assignments, module settings naming it (learn, dream…), marketing pages. */
  function usedBy(id: string): string[] {
    const out: string[] = [];
    const count = (sql: string): number => {
      try {
        return (deps.db.prepare(sql).get(id) as { n: number } | undefined)?.n ?? 0;
      } catch {
        return 0; // the module's table is not there (module never added)
      }
    };
    const care = count('SELECT COUNT(*) AS n FROM care_assignments WHERE agent_id = ? AND enabled = 1');
    if (care) out.push(`Chăm khách: ${care} phân công`);
    const pages = count('SELECT COUNT(*) AS n FROM fb_pages WHERE writer_agent = ?1 OR video_agent = ?1');
    if (pages) out.push(`Marketing: ${pages} Fanpage`);
    for (const m of deps.modules?.list() ?? []) {
      let settings: Record<string, unknown>;
      try {
        settings = deps.modules.settings(m.manifest.id);
      } catch {
        continue;
      }
      for (const [k, v] of Object.entries(settings)) {
        if (v === id) out.push(`${m.manifest.name}: ${m.manifest.settings?.[k]?.label ?? k}`);
      }
    }
    return out;
  }

  function card(a: AgentConfig) {
    const ro = a.runtimeOptions;
    const rawMax = ro.max_runs_day;
    const maxRunsDay = typeof rawMax === 'number' ? rawMax : typeof rawMax === 'string' && rawMax.trim() ? Number(rawMax) : DEFAULT_MAX_RUNS_DAY;
    const key = keyStatus(a);
    const botId = typeof ro.bot_id === 'string' ? ro.bot_id : '';
    let runsToday = 0;
    try {
      runsToday = deps.runs.dayCount(a.id, deps.config.timezone);
    } catch {
      /* fake run service in some tests */
    }
    return {
      id: a.id,
      name: a.name,
      role: a.description,
      enabled: a.enabled,
      botId,
      baseUrl: typeof ro.base_url === 'string' && ro.base_url ? ro.base_url : '',
      connected: !!botId && key.hasKey,
      key,
      lastCheck: lastCheck(a.id),
      runsToday,
      maxRunsDay,
      context: a.context,
      usedBy: usedBy(a.id),
      brain: Object.entries(a.access.brain).map(([folder, g]) => ({ folder, read: g.read, write: g.write })),
      modules: a.access.modules,
    };
  }

  function templates(): GenbotTemplateView[] {
    const folder = deps.brain.folders()[0]?.id ?? '';
    return GENBOT_TEMPLATES.flatMap((t) => {
      try {
        const { persona: _p, description: _d, maxRunsDay: _m, brainFolder: _b, ...view } = renderTemplate(deps.config.rootDir, t.id, { shopName: '', brainFolder: folder, baseUrl: baseUrl() });
        return [view];
      } catch {
        return [];
      }
    });
  }

  const overview = () => {
    const all = deps.agents.list();
    return {
      baseUrl: baseUrl(),
      defaultBaseUrl: GENBOT_DEFAULT_BASE_URL,
      bots: all.filter((a) => a.runtime === 'genbot').map(card),
      // agents left on a runtime that is no longer offered: shown with "Chuyển sang GenBot"
      legacy: all.filter((a) => a.runtime !== 'genbot' && !allowed().includes(a.runtime)).map((a) => ({ id: a.id, name: a.name, runtime: a.runtime, enabled: a.enabled })),
      templates: templates(),
      brainFolders: deps.brain.folders().map((f) => ({ id: f.id, name: f.name })),
    };
  };

  async function probe(agent: { id?: string; runtimeOptions: AgentConfig['runtimeOptions'] }, pastedKey?: string): Promise<DoctorReport> {
    // a key pasted before saving goes to a one-off runtime instance; a saved bot uses the app's runtime and its stored key
    const runtime = pastedKey ? createGenbotRuntime({ keyFor: () => pastedKey }) : deps.runtimes.get('genbot');
    const keyFor = pastedKey ? () => pastedKey : (id: string) => keys().get(id);
    return checkGenbotAgent(runtime, agent, { probe: true, keyFor });
  }
  const summary = (r: DoctorReport) => {
    const err = r.checks.find((c) => c.level === 'error');
    const probeLine = r.checks.find((c) => c.code === 'genbot.probe');
    return { ok: !err, message: (err ?? probeLine ?? r.checks[r.checks.length - 1])?.message ?? '', at: new Date().toISOString() };
  };

  // ---------------------------------------------------------------- reads

  app.get('/api/genbot', (c) => c.json(overview()));

  /** The how-to, shown in the screen (docs/huong-dan-noi-genbot.md). */
  app.get('/api/genbot/guide', (c) => {
    let markdown = '';
    try {
      markdown = fs.readFileSync(path.join(deps.config.rootDir, 'docs', 'huong-dan-noi-genbot.md'), 'utf8');
    } catch {
      markdown = 'Không tìm thấy docs/huong-dan-noi-genbot.md.';
    }
    return c.json({ markdown });
  });

  // ---------------------------------------------------------------- connection

  app.put('/api/genbot/connection', async (c) => {
    const input = await body(c, z.object({ baseUrl: z.string().trim().min(1).max(300), applyToAll: z.boolean().optional() }));
    const url = checkBase(input.baseUrl);
    kvSet(BASE_URL_KV, url);
    let updated = 0;
    if (input.applyToAll) {
      for (const a of deps.agents.list().filter((x) => x.runtime === 'genbot')) {
        deps.agents.update(a.id, { runtimeOptions: { ...a.runtimeOptions, base_url: url } });
        updated++;
      }
    }
    deps.audit.log({ actor: 'user', action: 'genbot.connection', detail: { baseUrl: url, applyToAll: !!input.applyToAll, updated } });
    return c.json({ ...overview(), updated });
  });

  app.post('/api/genbot/connection/check', async (c) => {
    const input = await body(c, z.object({ baseUrl: z.string().trim().max(300).optional() }));
    const url = checkBase(input.baseUrl || baseUrl());
    const doctor = await deps.runtimes.get('genbot').doctor({ probe: false });
    const host = await probeHost(url);
    return c.json({ ok: host.ok, baseUrl: url, checks: [...doctor.checks, { code: 'genbot.host', level: host.ok ? 'info' : 'error', message: host.message }] });
  });

  // ---------------------------------------------------------------- probe before saving

  app.post('/api/genbot/probe', async (c) => {
    const input = await body(c, z.object({ botId: z.string().trim().max(128), key: z.string().max(600).optional(), baseUrl: z.string().trim().max(300).optional(), agentId: z.string().optional() }));
    const saved = input.agentId ? requireBot(input.agentId) : undefined;
    const key = input.key?.trim() ? withKeyError(() => validateGenbotKey(input.key)) : undefined;
    if (!key && !saved) throw badRequest('Dán khoá Bot API để kiểm tra bot trước khi lưu.');
    const runtimeOptions = { ...saved?.runtimeOptions, base_url: checkBase(input.baseUrl || (saved?.runtimeOptions.base_url as string) || baseUrl()), bot_id: checkBotId(input.botId) };
    const report = await probe({ ...(saved ? { id: saved.id } : {}), runtimeOptions }, key);
    return c.json({ ...report, summary: summary(report) });
  });

  // ---------------------------------------------------------------- bots

  app.post('/api/genbot/bots', async (c) => {
    const input = await body(c, genbotOptions);
    const key = input.key?.trim() ? withKeyError(() => validateGenbotKey(input.key)) : undefined;
    const url = checkBase(input.baseUrl || baseUrl());
    const botId = checkBotId(input.botId);
    const tpl = GENBOT_TEMPLATES.find((t) => t.id === input.template)!;
    const folders = deps.brain.folders().map((f) => f.id);
    const brainFolder = input.brainFolder || folders[0] || '';
    if (brainFolder && folders.length && !folders.includes(brainFolder)) throw badRequest(`Không có thư mục brain "${brainFolder}".`);
    let id = input.id?.trim() || slug(input.name) || tpl.agentId;
    if (!AGENT_ID_RE.test(id)) id = tpl.agentId;
    if (deps.agents.get(id)) {
      if (input.id) throw conflict(`Agent "${id}" đã tồn tại.`);
      let n = 2;
      while (deps.agents.get(`${id}-${n}`)) n++;
      id = `${id}-${n}`;
    }
    const r = renderTemplate(deps.config.rootDir, input.template, { shopName: input.shopName || input.name, brainFolder, baseUrl: url });
    const created = deps.agents.create(id, {
      name: input.name,
      description: input.role || r.description,
      runtime: 'genbot',
      runtimeOptions: { base_url: url, bot_id: botId, max_runs_day: r.maxRunsDay },
      context: r.context,
      permission: 'safe',
      persona: r.persona || input.role || input.name,
      access: {
        brain: brainFolder ? { [brainFolder]: r.brain } : {},
        memory: r.memory,
        skills: [],
        connections: {},
        modules: r.modules,
      },
    });
    if (key) keys().set(created.id, key);
    deps.audit.log({ actor: 'user', action: 'genbot.bot.create', target: created.id, detail: { template: input.template, botId, hasKey: !!key } });
    return c.json(card(deps.agents.require(created.id)), 201);
  });

  app.put('/api/genbot/bots/:id', async (c) => {
    const a = requireBot(c.req.param('id'));
    const input = await body(c, z.object({
      name: z.string().trim().min(1).max(80).optional(),
      role: z.string().trim().max(500).optional(),
      botId: z.string().trim().max(128).optional(),
      baseUrl: z.string().trim().max(300).optional(),
      maxRunsDay: z.number().int().min(0).max(100_000).optional(),
      context: z.enum(['lean', 'standard']).optional(),
    }));
    const ro = { ...a.runtimeOptions };
    if (input.botId !== undefined) ro.bot_id = checkBotId(input.botId);
    if (input.baseUrl !== undefined) ro.base_url = checkBase(input.baseUrl);
    if (input.maxRunsDay !== undefined) ro.max_runs_day = input.maxRunsDay;
    deps.agents.update(a.id, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.role !== undefined ? { description: input.role } : {}),
      ...(input.context !== undefined ? { context: input.context } : {}),
      runtimeOptions: ro,
    });
    if (input.botId !== undefined || input.baseUrl !== undefined) kvDel(CHECK_KV(a.id));
    deps.audit.log({ actor: 'user', action: 'genbot.bot.update', target: a.id, detail: { fields: Object.keys(input) } });
    return c.json(card(deps.agents.require(a.id)));
  });

  app.put('/api/genbot/bots/:id/key', async (c) => {
    const a = requireBot(c.req.param('id'));
    const input = await body(c, z.object({ key: z.string().max(600) }));
    const status = withKeyError(() => keys().set(a.id, input.key));
    kvDel(CHECK_KV(a.id));
    deps.audit.log({ actor: 'user', action: 'genbot.key.set', target: a.id });
    return c.json({ ...card(deps.agents.require(a.id)), key: { ...status, source: 'store' } });
  });

  app.delete('/api/genbot/bots/:id/key', (c) => {
    const a = requireBot(c.req.param('id'));
    keys().remove(a.id);
    deps.audit.log({ actor: 'user', action: 'genbot.key.remove', target: a.id });
    return c.json(card(deps.agents.require(a.id)));
  });

  app.post('/api/genbot/bots/:id/check', async (c) => {
    const a = requireBot(c.req.param('id'));
    const report = await probe({ id: a.id, runtimeOptions: a.runtimeOptions });
    const s = summary(report);
    kvSet(CHECK_KV(a.id), JSON.stringify(s));
    return c.json({ ...report, summary: s, bot: card(a) });
  });

  app.post('/api/genbot/bots/:id/pause', async (c) => {
    const a = requireBot(c.req.param('id'));
    const input = await body(c, z.object({ paused: z.boolean() }));
    deps.agents.update(a.id, { enabled: !input.paused });
    deps.audit.log({ actor: 'user', action: input.paused ? 'genbot.bot.pause' : 'genbot.bot.resume', target: a.id });
    return c.json(card(deps.agents.require(a.id)));
  });

  app.delete('/api/genbot/bots/:id', (c) => {
    const a = requireBot(c.req.param('id'));
    deps.agents.archive(a.id);
    keys().remove(a.id);
    kvDel(CHECK_KV(a.id));
    deps.audit.log({ actor: 'user', action: 'genbot.bot.delete', target: a.id });
    return c.json({ ok: true });
  });

  /** An agent left on claude, codex…: moved to GenBot only when the owner asks (never silently). */
  app.post('/api/genbot/bots/:id/convert', async (c) => {
    const id = c.req.param('id');
    const a = deps.agents.get(id);
    if (!a) throw notFound(`Không tìm thấy agent "${id}".`);
    if (a.runtime === 'genbot') return c.json(card(a));
    const keep = { ...a.runtimeOptions };
    for (const k of Object.keys(keep)) if (!['max_runs_day'].includes(k)) delete keep[k];
    // `model` named a CLI model; GenBot picks its own AI ('' drops it from agent.yaml)
    deps.agents.update(id, { runtime: 'genbot', model: '', runtimeOptions: { ...keep, base_url: baseUrl(), bot_id: '' } });
    deps.audit.log({ actor: 'user', action: 'genbot.bot.convert', target: id, detail: { from: a.runtime } });
    deps.attention.resolve(`legacy-runtime:${id}`);
    return c.json(card(deps.agents.require(id)));
  });
}
