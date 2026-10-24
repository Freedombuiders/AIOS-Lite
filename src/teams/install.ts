// Preview and install of team packages. Install undoes everything it did if a step fails. Never writes secrets.
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AgentRegistry } from '../agents/contracts.js';
import { AGENT_ID_RE } from '../agents/schema.js';
import { RUNTIME_IDS, type RuntimeId } from '../core/types.js';
import type { SkillLibrary } from '../shared/contracts.js';
import type { SchedulerService } from '../work/contracts.js';
import { PLACEHOLDER_RE } from './package.js';
import { AGENT_YAML_TEMPLATE, TeamError, type CollisionStrategy, type LoadedTeam, type TeamInputDecl } from './types.js';

export interface InstallDeps {
  agents: AgentRegistry;
  scheduler: SchedulerService;
  skills?: SkillLibrary;
  /** where new skills are written (first skills root) */
  skillsDir: string;
  timezone: string;
}

export interface InstallOptions {
  inputs?: Record<string, string>;
  strategy?: CollisionStrategy;
  agentStrategies?: Record<string, CollisionStrategy>;
  /** per package-agent runtime override */
  runtimes?: Record<string, RuntimeId>;
  /** runtime for agents whose template names none */
  defaultRuntime?: RuntimeId;
}

export interface AgentPlan {
  pkgId: string;
  name: string;
  description: string;
  finalId: string;
  action: 'create' | 'skip';
  collision: boolean;
  runtime: RuntimeId;
  model: string | null;
  skills: string[];
  files: string[];
  reportsTo: string | null;
}
export interface SchedulePlan {
  id: string;
  name: string;
  finalAgentId: string;
  cron: string;
  tz: string;
  willCreate: boolean;
  skipReason: string | null;
}
export interface SkillPlan {
  id: string;
  bundled: boolean;
  /** already in the library: the bundled copy is not written */
  exists: boolean;
}
export interface InstallPlan {
  team: { slug: string; name: string; version: string; description: string; manager: string; prerequisites: string[]; body: string };
  strategy: CollisionStrategy;
  agents: AgentPlan[];
  schedules: SchedulePlan[];
  skills: SkillPlan[];
  inputs: Array<TeamInputDecl & { provided: boolean }>;
  missingInputs: string[];
  warnings: string[];
  blockers: string[];
  canInstall: boolean;
}
export interface InstallResult {
  slug: string;
  name: string;
  agents: Array<{ pkgId: string; id: string; name: string; runtime: RuntimeId }>;
  skills: string[];
  schedules: Array<{ id: number; name: string; agentId: string; cron: string }>;
  warnings: string[];
  nextSteps: string[];
}

const MAX_INPUT_CHARS = 2000;

function skillRel(p: string): { agent: string; skill: string; rest: string } | null {
  const m = /^agents\/([^/]+)\/skills\/([^/]+)\/(.+)$/.exec(p);
  return m ? { agent: m[1]!, skill: m[2]!, rest: m[3]! } : null;
}

function personaPath(team: LoadedTeam, id: string): string {
  return team.files.has(`agents/${id}/persona.md`) ? `agents/${id}/persona.md` : `agents/${id}/CLAUDE.md`;
}

function render(text: string, values: Map<string, string>, agentMap: Map<string, string>, secretKeys: Set<string>): string {
  return text.replace(PLACEHOLDER_RE, (m, ref: string) => {
    if (ref.startsWith('agent.')) return agentMap.get(ref.slice(6)) ?? m;
    if (ref.startsWith('input.')) {
      const key = ref.slice(6);
      if (secretKeys.has(key)) return `[CHƯA CẤU HÌNH: ${key}]`;
      return values.get(key) || `[CHƯA CẤU HÌNH: ${key}]`;
    }
    return m;
  });
}

function cleanInput(v: string): string {
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, MAX_INPUT_CHARS).trim();
}

function freeId(base: string, taken: Set<string>): string {
  const root = base.slice(0, 36);
  for (let i = 2; i < 100; i++) {
    const id = `${root}-${i}`;
    if (!taken.has(id)) return id;
  }
  throw new TeamError(`Không tìm được id trống cho "${base}".`, 409);
}

export function planInstall(deps: InstallDeps, team: LoadedTeam, opts: InstallOptions = {}): InstallPlan {
  const m = team.manifest;
  const strategy: CollisionStrategy = opts.strategy ?? 'rename';
  const warnings = [...team.warnings];
  const blockers: string[] = [];
  const taken = new Set(deps.agents.list().map((a) => a.id));
  const agents: AgentPlan[] = [];
  const idMap = new Map<string, string>();

  for (const a of m.agents) {
    const clash = taken.has(a.id);
    const how = opts.agentStrategies?.[a.id] ?? strategy;
    let finalId = a.id;
    let action: AgentPlan['action'] = 'create';
    if (clash && how === 'skip') action = 'skip';
    else if (clash) finalId = freeId(a.id, taken);
    if (action === 'create') taken.add(finalId);
    idMap.set(a.id, finalId);
    const runtime = opts.runtimes?.[a.id] ?? a.runtime ?? opts.defaultRuntime ?? 'claude';
    if (!(RUNTIME_IDS as readonly string[]).includes(runtime)) blockers.push(`Runtime "${runtime}" của ${a.id} không hợp lệ.`);
    const bundled = [...new Set([...team.files.keys()].map(skillRel).filter((s) => s?.agent === a.id).map((s) => s!.skill))];
    agents.push({
      pkgId: a.id,
      name: a.name,
      description: a.description,
      finalId,
      action,
      collision: clash,
      runtime,
      model: a.model,
      skills: [...new Set([...bundled, ...a.skills])],
      files: [...team.files.keys()].filter((p) => p.startsWith(`agents/${a.id}/`)).sort(),
      reportsTo: null,
    });
  }
  const managerFinal = idMap.get(m.manager) ?? m.manager;
  const mainExists = !!deps.agents.get('main');
  for (const p of agents) {
    if (p.action === 'skip') continue;
    p.reportsTo = p.pkgId === m.manager ? (mainExists && p.finalId !== 'main' ? 'main' : null) : managerFinal;
  }

  const skillIds = new Set<string>();
  for (const f of team.files.keys()) {
    const s = skillRel(f);
    if (s) skillIds.add(s.skill);
  }
  const skills: SkillPlan[] = [...skillIds].sort().map((id) => ({ id, bundled: true, exists: fs.existsSync(path.join(deps.skillsDir, id, 'SKILL.md')) || !!deps.skills?.get(id) }));
  for (const id of m.requiredSkills) {
    if (skillIds.has(id)) continue;
    const exists = !!deps.skills?.get(id) || fs.existsSync(path.join(deps.skillsDir, id, 'SKILL.md'));
    skills.push({ id, bundled: false, exists });
    if (!exists) warnings.push(`Gói cần skill "${id}" nhưng thư viện chưa có. Agent vẫn được tạo; thêm skill này sau.`);
  }
  for (const s of skills) if (s.bundled && s.exists) warnings.push(`Skill "${s.id}" đã có trong thư viện, giữ bản hiện tại.`);

  const known = new Map(m.inputs.map((i) => [i.key, i]));
  const provided = new Map<string, string>();
  for (const [k, v] of Object.entries(opts.inputs ?? {})) {
    if (known.has(k) && typeof v === 'string') provided.set(k, cleanInput(v));
  }
  const inputs = m.inputs.map((i) => ({ ...i, provided: !!(provided.get(i.key) || i.defaultValue) }));
  const missingInputs = m.inputs.filter((i) => i.required && !provided.get(i.key) && !i.defaultValue).map((i) => i.key);
  for (const k of missingInputs) blockers.push(`Cần điền "${known.get(k)!.label}".`);

  const existingSchedules = new Set(deps.scheduler.list().map((s) => `${s.agentId}\0${s.name}`));
  const schedules: SchedulePlan[] = m.schedules.map((s) => {
    const finalAgentId = idMap.get(s.agent) ?? s.agent;
    const name = `${m.name}: ${s.id}`;
    const agent = agents.find((a) => a.pkgId === s.agent);
    let skipReason: string | null = null;
    if (agent?.action === 'skip') skipReason = 'agent được giữ nguyên, không tạo lịch mới';
    else if (existingSchedules.has(`${finalAgentId}\0${name}`)) skipReason = 'lịch cùng tên đã có';
    return { id: s.id, name, finalAgentId, cron: s.cron, tz: s.tz ?? deps.timezone, willCreate: !skipReason, skipReason };
  });
  if (agents.every((a) => a.action === 'skip')) warnings.push('Mọi agent đều đã có và bị bỏ qua: không có gì để tạo.');
  return {
    team: { slug: m.slug, name: m.name, version: m.version, description: m.description, manager: managerFinal, prerequisites: m.prerequisites, body: m.body },
    strategy,
    agents,
    schedules,
    skills,
    inputs,
    missingInputs,
    warnings,
    blockers,
    canInstall: blockers.length === 0,
  };
}

export function installTeam(deps: InstallDeps, team: LoadedTeam, opts: InstallOptions = {}): InstallResult {
  const plan = planInstall(deps, team, opts);
  if (!plan.canInstall) throw new TeamError(plan.blockers.join(' '), 422, plan.blockers);
  const secretKeys = new Set(team.manifest.inputs.filter((i) => i.kind === 'secret').map((i) => i.key));
  const values = new Map<string, string>();
  for (const i of team.manifest.inputs) {
    const v = cleanInput(opts.inputs?.[i.key] ?? '');
    values.set(i.key, v || i.defaultValue);
  }
  const agentMap = new Map(plan.agents.map((a) => [a.pkgId, a.finalId]));
  const r = (t: string) => render(t, values, agentMap, secretKeys);

  const undo: Array<() => void> = [];
  const result: InstallResult = { slug: plan.team.slug, name: plan.team.name, agents: [], skills: [], schedules: [], warnings: [...plan.warnings], nextSteps: [] };
  try {
    for (const s of plan.skills) {
      if (!s.bundled || s.exists) continue;
      const dest = path.join(deps.skillsDir, s.id);
      for (const [rel, data] of team.files) {
        const sr = skillRel(rel);
        if (!sr || sr.skill !== s.id) continue;
        const target = path.join(dest, sr.rest);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, r(data.toString('utf8')));
      }
      undo.push(() => fs.rmSync(dest, { recursive: true, force: true }));
      result.skills.push(s.id);
    }
    if (result.skills.length) deps.skills?.reload();

    for (const a of plan.agents) {
      if (a.action === 'skip') {
        result.warnings.push(`Giữ nguyên agent "${a.finalId}" đã có.`);
        continue;
      }
      if (!AGENT_ID_RE.test(a.finalId)) throw new TeamError(`Id agent "${a.finalId}" không hợp lệ.`, 422);
      const tpl = team.files.get(`agents/${a.pkgId}/${AGENT_YAML_TEMPLATE}`)!;
      const rawTpl = (deepRender(parseTemplate(tpl.toString('utf8')), r) ?? {}) as Record<string, unknown>;
      const persona = r(team.files.get(personaPath(team, a.pkgId))!.toString('utf8'));
      const created = deps.agents.create(a.finalId, {
        name: String(rawTpl.name ?? a.name),
        description: String(rawTpl.description ?? a.description),
        runtime: a.runtime,
        ...(a.model ? { model: a.model } : {}),
        persona,
        permission: 'safe',
        ...(a.reportsTo ? { reportsTo: a.reportsTo } : {}),
        canDelegate: a.pkgId === plan.team.manager || a.pkgId === team.manifest.manager,
        ...(typeof rawTpl.budget_usd_month === 'number' ? { budgetUsdMonth: rawTpl.budget_usd_month } : {}),
        access: { brain: {}, memory: { team: false, private: true }, skills: a.skills, connections: {}, modules: {} },
      });
      undo.push(() => {
        fs.rmSync(created.dir, { recursive: true, force: true });
        deps.agents.reload();
      });
      for (const rel of a.files) {
        if (rel.endsWith('/persona.md') || rel.endsWith('/CLAUDE.md') || rel.endsWith(`/${AGENT_YAML_TEMPLATE}`) || skillRel(rel)) continue;
        const sub = rel.slice(`agents/${a.pkgId}/`.length);
        const target = path.join(created.dir, sub);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, r(team.files.get(rel)!.toString('utf8')));
      }
      result.agents.push({ pkgId: a.pkgId, id: a.finalId, name: created.name, runtime: a.runtime });
    }

    for (const s of plan.schedules) {
      if (!s.willCreate) {
        if (s.skipReason) result.warnings.push(`Lịch "${s.id}": ${s.skipReason}.`);
        continue;
      }
      const decl = team.manifest.schedules.find((x) => x.id === s.id)!;
      const created = deps.scheduler.create({ name: s.name, agentId: s.finalAgentId, cron: s.cron, timezone: s.tz, prompt: r(decl.prompt), enabled: false });
      undo.push(() => deps.scheduler.remove(created.id));
      result.schedules.push({ id: created.id, name: created.name, agentId: created.agentId, cron: created.cron });
    }
  } catch (err) {
    for (const step of undo.reverse()) {
      try {
        step();
      } catch {
        /* best effort */
      }
    }
    if (err instanceof TeamError) throw err;
    throw new TeamError(`Cài gói thất bại, đã hoàn tác: ${(err as Error).message}`, 422);
  }
  if (result.schedules.length) result.nextSteps.push('Các lịch được tạo ở trạng thái TẮT. Bật từng lịch trong Lịch chạy sau khi kiểm tra.');
  result.nextSteps.push('Mở từng agent để cấp quyền (Second Brain, kết nối, module); mặc định agent chưa có quyền nào.');
  result.nextSteps.push(...plan.team.prerequisites);
  return result;
}

function deepRender(v: unknown, r: (t: string) => string): unknown {
  if (typeof v === 'string') return r(v);
  if (Array.isArray(v)) return v.map((x) => deepRender(x, r));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepRender(x, r)]));
  return v;
}

function parseTemplate(text: string): unknown {
  try {
    return parseYaml(text);
  } catch (e) {
    throw new TeamError(`agent.yaml.template không đọc được: ${(e as Error).message.split('\n')[0]}`, 422);
  }
}
